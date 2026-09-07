/**
 * Work Complexity: choosing a model by the *kind of work* rather than by id.
 *
 * A provider catalogue is a list nobody outside this industry can read. Anthropic's
 * `models.list()` returns its whole line-up including access-gated tiers, OpenAI's
 * returns every `gpt-*` and `o*` id it has ever shipped, and Gemini's returns
 * everything that supports `generateContent` — dozens of entries, growing on their
 * own schedule, named `claude-haiku-4-5-20251001`. Asking a user to pick one is
 * asking them to have an opinion they have no way to form.
 *
 * So a local agent's manifest can say **`simple` | `medium` | `complex`** instead,
 * and this module turns that into an id against whatever the chosen credential
 * actually lists today. Two properties make that worth the indirection:
 *
 * - **It is portable.** `cinna-agent.json` is committed to the user's repository,
 *   read by their coding assistant and uploaded to a Cinna instance on publish. A
 *   model id means something only to the catalogue that lists it; `medium` means
 *   the same thing on the next machine, on a different credential and on a Cinna
 *   instance that has never heard of this one.
 * - **It survives releases.** The mapping is *patterns over families*, not a table
 *   of ids. `claude-sonnet-6` classifies as medium the day it ships, with no app
 *   update — which is the same machinery that answers "this agent names
 *   `gpt-5.4-mini` and the catalogue no longer lists it": see
 *   {@link sameFamilyFallback}.
 *
 * Nothing here reaches the network or the filesystem. It classifies ids and ranks
 * them; the live catalogue is always passed in, because the whole point is to
 * choose from what a particular credential can actually serve.
 */

import { isChatCapableModelId, isDefaultEligibleModelId } from './modelDefaults'

/** How hard the work is, as the user is asked to describe it. */
export type WorkComplexity = 'simple' | 'medium' | 'complex'

/** In the order they are offered — cheapest and fastest first. */
export const WORK_COMPLEXITIES: readonly WorkComplexity[] = ['simple', 'medium', 'complex']

/** Select labels. The parenthesised model name is appended by the caller. */
export const WORK_COMPLEXITY_LABELS: Record<WorkComplexity, string> = {
  simple: 'Simple',
  medium: 'Medium',
  complex: 'Complex'
}

/**
 * What each tier costs the user, as one short clause.
 *
 * Short because of where it has to fit: the panel shows it inline beside the
 * resolved model, in a line that truncates at the 800px minimum window. A longer
 * sentence would be a hint nobody finishes reading, which is what the previous
 * one was — it lived only in a `<option title>`, and macOS does not render those.
 *
 * Lives here rather than in the panel so the manifest's own documentation and
 * the picker cannot drift apart.
 */
export const WORK_COMPLEXITY_HINTS: Record<WorkComplexity, string> = {
  simple: 'fastest and cheapest',
  medium: 'the balanced default',
  complex: 'slowest and most expensive'
}

export function isWorkComplexity(value: unknown): value is WorkComplexity {
  return value === 'simple' || value === 'medium' || value === 'complex'
}

/** As much of a catalogue entry as classification needs. */
export interface CatalogueModel {
  id: string
}

/** One model id, understood. */
export interface ClassifiedModel {
  id: string
  tier: WorkComplexity
  /** The line the model belongs to: `haiku`, `mini`, `flash`. Fallback keys off this. */
  family: string
  /**
   * A **comparable rank**, not a display version: `major + minor/1000`, so
   * `claude-sonnet-4-5` (4.005) sorts above `claude-opus-4-1` (4.001) and a
   * two-digit minor (`4-10` → 4.010) still sorts above a one-digit one. Null when
   * the id names no version at all.
   */
  version: number | null
  /** The id ends in a pinned date (`-20251001`, `-2025-08-07`). */
  snapshot: boolean
  /** The id names a preview / experimental / beta build. */
  preview: boolean
  /** Tiebreak within a tier at equal version. Lower is preferred. */
  preference: number
}

interface FamilyRule {
  family: string
  tier: WorkComplexity
  /** Provider types this rule applies to. A gateway is matched against them all. */
  types: readonly string[]
  match: RegExp
  preference: number
}

/**
 * Provider types whose catalogue is one known namespace. Anything else — an
 * `openai_compatible` gateway, or a type added after this file — is matched
 * against every rule, because a gateway proxies other people's families and the
 * id is the only evidence there is.
 */
const KNOWN_TYPES = new Set(['anthropic', 'openai', 'gemini'])

/**
 * Boundary-anchored so a family name cannot be found inside an unrelated word.
 * The one that actually bites: `gemini` contains `mini`, so a bare `/mini/` would
 * file every Gemini model under Simple.
 */
function token(word: string): RegExp {
  return new RegExp(`(?:^|[-_/])${word}(?:[-_./]|$)`, 'i')
}

/**
 * The mapping, in **match order** — first hit wins. `preference` is separate on
 * purpose: `nano` has to be tested before `mini` (so `-mini-nano` could not be
 * read as a mini) while `mini` is the one you would rather run at equal version.
 *
 * The access-gated Anthropic tiers are classified but never auto-chosen —
 * {@link bestInTier} drops them via `isDefaultEligibleModelId`, because they are
 * listed to accounts that cannot call them. They stay reachable by picking the
 * model by hand.
 */
const RULES: readonly FamilyRule[] = [
  { family: 'haiku', tier: 'simple', types: ['anthropic'], match: /haiku/i, preference: 0 },
  { family: 'sonnet', tier: 'medium', types: ['anthropic'], match: /sonnet/i, preference: 0 },
  { family: 'opus', tier: 'complex', types: ['anthropic'], match: /opus/i, preference: 0 },
  { family: 'fable', tier: 'complex', types: ['anthropic'], match: /fable/i, preference: 1 },
  { family: 'mythos', tier: 'complex', types: ['anthropic'], match: /mythos/i, preference: 2 },
  { family: 'flash-lite', tier: 'simple', types: ['gemini'], match: /flash-lite/i, preference: 0 },
  { family: 'flash', tier: 'medium', types: ['gemini'], match: /flash/i, preference: 0 },
  { family: 'ultra', tier: 'complex', types: ['gemini'], match: token('ultra'), preference: 1 },
  { family: 'nano', tier: 'simple', types: ['openai'], match: token('nano'), preference: 1 },
  { family: 'mini', tier: 'simple', types: ['openai'], match: token('mini'), preference: 0 },
  { family: 'pro', tier: 'complex', types: ['openai', 'gemini'], match: token('pro'), preference: 0 },
  { family: 'o-series', tier: 'complex', types: ['openai'], match: /(?:^|[-_/])o\d+(?:[-_./]|$)/i, preference: 1 },
  { family: 'gpt', tier: 'medium', types: ['openai'], match: /(?:^|[-_/])(?:gpt|chatgpt)-/i, preference: 0 }
]

/** A pinned build date at the end of an id: `-20251001` or `-2025-08-07`. */
const SNAPSHOT = /[-_](?:\d{8}|\d{4}-\d{2}-\d{2})$/

/**
 * A build that may move or vanish under us. `latest` is deliberately absent: it is
 * an alias, which is the thing this module *prefers*, not a warning.
 */
const PREVIEW = /(?:^|[-_/])(?:preview|experimental|exp|nightly|beta|rc\d*)(?:[-_./]|$)/i

/**
 * The comparable rank described on {@link ClassifiedModel.version}.
 *
 * Every catalogue spells a version differently and all of them have to sort
 * against each other: Anthropic separates major from minor with a hyphen
 * (`claude-sonnet-4-5`), OpenAI uses a dot (`gpt-4.1`) or glues a letter on
 * (`gpt-4o`) or drops the prefix entirely (`o3`), Gemini uses a dot
 * (`gemini-2.5-flash`). The pinned date is stripped first so a snapshot ranks
 * level with the alias it snapshots, rather than reading `20251001` as a version.
 */
function versionOf(id: string): number | null {
  const tokens = id.replace(SNAPSHOT, '').split(/[-_/]/)
  for (let i = 0; i < tokens.length; i++) {
    const part = tokens[i]
    const dotted = /^(\d+)\.(\d+)$/.exec(part)
    if (dotted) return Number(dotted[1]) + Number(dotted[2]) / 1000
    const bare = /^(\d+)$/.exec(part)
    if (bare) {
      // `claude-sonnet-4-5`: the minor is the next token when it is a bare
      // number, and absent when it is a word (`gpt-4-turbo`).
      const next = tokens[i + 1]
      const minor = next !== undefined && /^\d+$/.test(next) ? Number(next) : 0
      return Number(bare[1]) + minor / 1000
    }
    const suffixed = /^(\d+)o$/i.exec(part)
    if (suffixed) return Number(suffixed[1])
    const oSeries = /^o(\d+)$/i.exec(part)
    if (oSeries) return Number(oSeries[1])
  }
  return null
}

/** What tier and family a model id belongs to, or null when nothing recognises it. */
export function classifyModel(modelId: string, providerType: string): ClassifiedModel | null {
  const id = modelId.trim()
  if (id === '') return null
  const type = providerType.trim().toLowerCase()
  const rules = KNOWN_TYPES.has(type) ? RULES.filter((rule) => rule.types.includes(type)) : RULES
  const rule = rules.find((candidate) => candidate.match.test(id))
  if (!rule) return null
  return {
    id: modelId,
    tier: rule.tier,
    family: rule.family,
    version: versionOf(id),
    snapshot: SNAPSHOT.test(id),
    preview: PREVIEW.test(id),
    preference: rule.preference
  }
}

/**
 * Best-first order within a tier or a family.
 *
 * **Preview beats version**, deliberately and in that order: a stable
 * `gemini-2.0-flash` is a better thing to run an agent on unattended than a
 * `gemini-2.5-flash-preview-04-17` that may be withdrawn, and a tier whose whole
 * membership is preview still resolves to its best preview. After that: newest,
 * then the family we would rather run at equal version, then a stable alias over
 * a pinned snapshot of it, then the id — so the answer is deterministic and a
 * test can assert it.
 */
function compareClassified(a: ClassifiedModel, b: ClassifiedModel): number {
  return (
    Number(a.preview) - Number(b.preview) ||
    (b.version ?? -1) - (a.version ?? -1) ||
    a.preference - b.preference ||
    Number(a.snapshot) - Number(b.snapshot) ||
    a.id.localeCompare(b.id)
  )
}

/** Classify a catalogue, dropping what nothing recognises. */
function classifyAll(
  models: readonly CatalogueModel[],
  providerType: string
): ClassifiedModel[] {
  const out: ClassifiedModel[] = []
  for (const model of models) {
    const classified = classifyModel(model.id, providerType)
    if (classified) out.push(classified)
  }
  return out
}

/**
 * The model a tier resolves to on one credential's live catalogue, or null when it
 * lists nothing in that tier.
 *
 * Two exclusions, both from `modelDefaults`: a non-chat model (an embedding, a
 * TTS voice) is never a runtime, and an access-gated tier is listed to accounts
 * that cannot call it — auto-selecting one produces a 404 on the agent's first
 * turn rather than an error the user can act on. Neither is hidden from the
 * by-hand model picker; they are only excluded from being *chosen for* the user.
 */
export function bestInTier(
  tier: WorkComplexity,
  models: readonly CatalogueModel[],
  providerType: string
): string | null {
  const eligible = models.filter(
    (model) => isChatCapableModelId(model.id) && isDefaultEligibleModelId(model.id)
  )
  const candidates = classifyAll(eligible, providerType).filter(
    (model) => model.tier === tier
  )
  if (candidates.length === 0) return null
  candidates.sort(compareClassified)
  return candidates[0].id
}

/**
 * The nearest surviving sibling of a model the catalogue no longer lists.
 *
 * The case this exists for: an agent pinned to `gpt-5.4-mini`, opened after that
 * id was retired. Refusing to run is wrong — the user asked for a small OpenAI
 * model and one is right there — and so is silently jumping to a different tier.
 * Same family, nearest version, **preferring the version above**: a retired id is
 * retired because something replaced it, and the replacement is the one above.
 *
 * `isDefaultEligibleModelId` is deliberately *not* applied here, unlike
 * {@link bestInTier}. Gating is about what may be chosen on the user's behalf; a
 * user who pinned a model in that family already chose it, and the honest
 * substitute for one gated model is the next one in its own line.
 *
 * The manifest is never rewritten from this. It is a resolution, reported where
 * the user can see it, so the file keeps saying what they wrote.
 */
export function sameFamilyFallback(
  modelId: string,
  models: readonly CatalogueModel[],
  providerType: string
): string | null {
  const target = classifyModel(modelId, providerType)
  if (!target) return null

  const candidates = classifyAll(
    models.filter((model) => model.id !== modelId && isChatCapableModelId(model.id)),
    providerType
  ).filter((model) => model.family === target.family)
  if (candidates.length === 0) return null

  const wanted = target.version
  if (wanted === null) {
    candidates.sort(compareClassified)
    return candidates[0].id
  }

  // `>=` on purpose: the same version by a different spelling — the dated
  // snapshot of an alias that was withdrawn — is the closest thing there is.
  const above = candidates.filter((model) => model.version !== null && model.version >= wanted)
  const below = candidates.filter((model) => model.version !== null && model.version < wanted)
  const pool = above.length > 0 ? above : below.length > 0 ? below : candidates

  pool.sort((a, b) => {
    const da = a.version === null ? Number.POSITIVE_INFINITY : Math.abs(a.version - wanted)
    const db = b.version === null ? Number.POSITIVE_INFINITY : Math.abs(b.version - wanted)
    return da - db || compareClassified(a, b)
  })
  return pool[0].id
}
