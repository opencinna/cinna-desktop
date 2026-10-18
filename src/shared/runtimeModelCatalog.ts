import type { AgentEngine } from './engine'
import type { WorkComplexity } from './modelFamilies'

export interface RuntimeModelChoice {
  id: string
  name: string
  description?: string
}

/** One reasoning-effort value a runtime offers (Claude's `effort`, Codex's `reasoning_effort`). */
export interface RuntimeEffortChoice {
  id: string
  name: string
}

/**
 * Where a catalogue came from:
 * - `session` — a runtime session advertised it (a turn, or an on-demand refresh);
 * - `cli-cache` — Codex's own `models_cache.json`, read before any session ran;
 * - `unavailable` — nothing has been learned for this profile and runtime yet.
 */
export type RuntimeModelCatalogSource = 'session' | 'cli-cache' | 'unavailable'

/**
 * Models (and effort levels) last advertised by this profile's runtime. Kept per
 * profile and runtime across restarts; never a guess.
 */
export interface RuntimeModelCatalog {
  engine: AgentEngine
  models: RuntimeModelChoice[]
  /**
   * Effort values per model id, as the runtime offered them while that model
   * was the session's: efforts are per model (Claude builds its `effort`
   * option for the current model only; Codex lists supported levels per model).
   * An empty list means that model offers none; a missing key means it was
   * never seen.
   */
  effortsByModel?: Record<string, RuntimeEffortChoice[]>
  /**
   * The model a fresh session started on before anything was asked of it — the
   * runtime's own default — when that is known. Learned from an on-demand refresh
   * (a session the desktop named no model for) or the CLI's cache.
   */
  defaultModelId?: string
  source: RuntimeModelCatalogSource
  updatedAt: number | null
}

/** What an on-demand refresh returns: the catalogue as it now stands, and why it failed, if it did. Data, never thrown. */
export interface RuntimeModelCatalogRefresh {
  catalog: RuntimeModelCatalog
  error: string | null
}

/** A catalogue older than this is refreshed when the Advanced picker for its runtime is shown. */
export const RUNTIME_MODEL_CATALOG_MAX_AGE_MS = 24 * 60 * 60 * 1000

/**
 * The efforts a model offers: its own list (possibly empty), or undefined when
 * the catalogue never saw that model as a session's current one.
 */
export function effortsFor(catalog: RuntimeModelCatalog | undefined | null, model: string | null): RuntimeEffortChoice[] | undefined {
  if (!catalog || !model) return undefined
  const exact = catalog.effortsByModel?.[model]
  if (exact) return exact
  // A model the tool offers under another value (an alias, a context hint) is
  // the one the turn sets, so it has that value's efforts — the driver's rule.
  const offered = catalog.models.map((m) => ({ value: m.id, name: m.name, description: m.description ?? '' }))
  const resolved = matchOfferedModel(offered, model)
  return resolved ? catalog.effortsByModel?.[resolved] : undefined
}

/**
 * Whether a catalogue is missing, came from a cache rather than the runtime's own
 * session, or is old enough that the Advanced picker should ask for a fresh one.
 */
export function catalogNeedsRefresh(catalog: RuntimeModelCatalog | undefined, now = Date.now()): boolean {
  if (!catalog || catalog.source !== 'session' || catalog.updatedAt === null) return true
  return now - catalog.updatedAt > RUNTIME_MODEL_CATALOG_MAX_AGE_MS
}

/* --------------------------------------------------------------- matching */

/** One offered model value, as a session's config option or a catalogue names it. */
export interface OfferedModelValue {
  value: string
  name: string
  description: string
}

/** Words that name no model family: `default` is whatever the CLI picks, `claude` is in every id. */
const NOT_A_FAMILY = new Set(['claude', 'default', 'latest', 'context'])

/** A model value's context tier (`opus[1m]` → `1m`), or null for the standard one. */
function contextHintOf(value: string): string | null {
  return value.trim().toLowerCase().match(/\[(\d+m)\]$/)?.[1] ?? null
}

/**
 * The model generation a text names (`claude-sonnet-4-5` → `4.5`, `Opus 4.7` →
 * `4.7`), or null. The Claude adapter's own pattern (`session-model.js`
 * `extractModelFamilyVersion`), context hints dropped first.
 */
function modelVersionOf(value: string | undefined): string | null {
  const match = value?.replace(/\[\d+m\]/gi, '').match(/\b(\d+)(?:[-.](\d+))?\b/)
  if (!match) return null
  return match[2] ? `${match[1]}.${match[2]}` : match[1]
}

function modelFamilies(value: string): string[] {
  return value
    .toLowerCase()
    .replace(/\[\d+m\]/g, ' ')
    .split(/[^a-z0-9]+/)
    .filter((token) => /^[a-z]+$/.test(token) && !NOT_A_FAMILY.has(token))
}

/**
 * The offered value a requested model resolves to, or null.
 *
 * In order: the exact value; the same value ignoring case; the same value
 * ignoring a context hint (`opus` ↔ `opus[1m]`); then the first offered value
 * sharing a family word with the request (`claude-haiku-4-5` → `haiku`) — never
 * `default`, which names whatever the CLI would pick. That last step keeps the
 * Claude adapter's own guards (`resolveModelPreference`): the context tier must
 * be the request's, and a version the request names must not differ from one
 * the candidate's value, name or description names (`claude-opus-4-1` is not
 * `opus` described as Opus 4.7).
 *
 * The one rule both the driver (which model a turn sets) and the panel and
 * composer (whether an agent's model is still offered) apply, so the warning
 * cannot disagree with what the turn does.
 */
export function matchOfferedModel(offered: readonly OfferedModelValue[], requested: string): string | null {
  const plain = (value: string): string => value.trim().toLowerCase().replace(/\[\d+m\]$/, '')
  const wanted = requested.trim()
  if (wanted === '') return null
  const families = modelFamilies(wanted)
  const wantedHint = contextHintOf(wanted)
  const wantedVersion = modelVersionOf(wanted)
  // As the adapter's `modelVersionsCompatible`: the first version the value,
  // name or description names must be the one the request names, if both do.
  const versionFits = (o: OfferedModelValue): boolean => {
    if (!wantedVersion) return true
    const version = modelVersionOf(o.value) ?? modelVersionOf(o.name) ?? modelVersionOf(o.description)
    return !version || version === wantedVersion
  }
  const match =
    offered.find((o) => o.value === wanted) ??
    offered.find((o) => o.value.toLowerCase() === wanted.toLowerCase()) ??
    offered.find((o) => o.value !== 'default' && plain(o.value) === plain(wanted)) ??
    offered.find((o) =>
      o.value !== 'default' &&
      contextHintOf(o.value) === wantedHint &&
      versionFits(o) &&
      modelFamilies(`${o.value} ${o.name}`).some((family) => families.includes(family)))
  return match?.value ?? null
}

/**
 * Whether a declared model is offered by a catalogue: `true`/`false` when the
 * catalogue is known, `null` when it is not (nothing to judge against — never a
 * warning on a guess).
 */
export function isModelOffered(catalog: RuntimeModelCatalog | undefined | null, model: string): boolean | null {
  if (!catalog || catalog.source === 'unavailable' || catalog.models.length === 0) return null
  const offered = catalog.models.map((m) => ({ value: m.id, name: m.name, description: m.description ?? '' }))
  return matchOfferedModel(offered, model) !== null
}

/* ------------------------------------------------- CLI model ↔ tier mapping */

/** The tier a Claude model belongs to by family word (`haiku`/`sonnet`/`opus`), or null. */
function claudeTier(model: string): WorkComplexity | null {
  const families = modelFamilies(model)
  if (families.includes('haiku')) return 'simple'
  if (families.includes('sonnet')) return 'medium'
  if (families.includes('opus')) return 'complex'
  return null
}

/** The tier an Antigravity model's thinking-level suffix names (`-low`/`-medium`/`-high`), or null. */
function antigravityTier(model: string): WorkComplexity | null {
  const level = model.trim().toLowerCase().match(/-(low|medium|high)$/)?.[1]
  return level === 'low' ? 'simple' : level === 'medium' ? 'medium' : level === 'high' ? 'complex' : null
}

/**
 * What a CLI agent's Advanced choice converts back to on the tier picker:
 * `{ tier }` (a null tier is the engine's Default), or `null` when no tier
 * honestly represents it — the checkbox then stays on, disabled, with the reason.
 *
 * - Claude: an alias or id of the haiku / sonnet / opus families, with no effort set.
 * - Antigravity: a `-low` / `-medium` / `-high` model.
 * - Codex: the runtime's default model, with a low / medium / high effort (or none).
 */
export function cliModelTier(
  engine: 'claude' | 'codex' | 'antigravity',
  model: string,
  effort: string | null,
  catalog: RuntimeModelCatalog | undefined | null
): { tier: WorkComplexity | null } | null {
  return CLI_TIER_OF[engine](model, effort, catalog)
}

type TierOf = (model: string, effort: string | null, catalog: RuntimeModelCatalog | undefined | null) => { tier: WorkComplexity | null } | null

/** Per engine, so no caller compares engine names (see `kindBranches.test.ts`). */
const CLI_TIER_OF: Readonly<Record<'claude' | 'codex' | 'antigravity', TierOf>> = {
  // An effort beside the model is a choice the tier picker cannot show: never dropped silently.
  claude: (model, effort) => {
    const tier = claudeTier(model)
    return tier && effort === null ? { tier } : null
  },
  antigravity: (model) => {
    const tier = antigravityTier(model)
    return tier ? { tier } : null
  },
  // The default only from a session: Codex's cache ignores the model the user's config.toml names.
  codex: (model, effort, catalog) => {
    const defaultModel = catalog?.source === 'session' ? catalogDefaultModel(catalog) : null
    if (!defaultModel || defaultModel !== model) return null
    if (effort === null) return { tier: null }
    return effort === 'low' ? { tier: 'simple' } : effort === 'medium' ? { tier: 'medium' } : effort === 'high' ? { tier: 'complex' } : null
  }
}

/** The catalogue's default model: the one a fresh session started on, else the first listed. */
export function catalogDefaultModel(catalog: RuntimeModelCatalog | undefined | null): string | null {
  if (!catalog || catalog.source === 'unavailable') return null
  if (catalog.defaultModelId && catalog.models.some((m) => m.id === catalog.defaultModelId)) return catalog.defaultModelId
  return catalog.models.find((m) => m.id !== 'default')?.id ?? null
}
