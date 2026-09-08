/**
 * Which model a folder agent runs on when its manifest names a credential but
 * no model — shared by the main process (`runtimeService.resolve`) and the
 * renderer (the "Runs with" panel's `Default (…)` option), so the label the
 * user picks from and the config the engine builds cannot disagree. They did
 * disagree, which is the bug this module exists to make unrepresentable.
 *
 * The chain, in order, and why each step is where it is:
 *
 * 1. **The default runtime's model, when the credential is the default's own
 *    row.** Same credential, same choice the user already made once.
 * 2. **The credential's own default model.** Set in Settings → AI Credentials;
 *    it is the user's answer to "what should this key run" and beats anything
 *    inferred. This is also the step that covers a default chat mode left on
 *    *First available*, whose `modelId` is null.
 * 3. **The default runtime's model again, when the two credentials share a
 *    provider type.** A model id belongs to a provider's *catalogue*, not to a
 *    row: `claude-sonnet-4-5` is as valid on a second Anthropic key as on the
 *    first, so a user with a personal key alongside an account-provisioned one
 *    keeps a working agent. `openai_compatible` and `ollama` are excluded —
 *    see {@link PER_ROW_CATALOGUE}: two gateways, or two Ollama hosts, are two
 *    different catalogues that happen to share a wire format.
 * 4. **The Medium tier on that credential** — {@link resolveRuntimeModel}'s last
 *    step, added with Work Complexity. See below.
 * 5. **Nothing.** Better than a model the credential cannot serve: the engine
 *    builds `<credential>/<model>` verbatim, so a wrong pairing is a config
 *    that saves cleanly and fails on the agent's first turn, while nothing at
 *    all is a skip the panel can explain and the user can fix.
 *
 * There is still deliberately no "first model in the list" step, and step 4 is
 * not one. This module used to end at "nothing", on the reasoning that an agent
 * must never run on a model the user did not choose — the same reasoning that
 * keeps `runtimeService` from inventing a *credential*. Work Complexity changes
 * what "choose" can mean: a **tier** is a choice a user can hold an opinion
 * about, it is stable across releases, and the desktop can resolve one against
 * any catalogue. So the floor is Medium — the tier a user who expressed no
 * preference would have picked — resolved against the credential they *did*
 * choose, and never silently upward into Complex. What it replaces is a dead
 * end: an agent that listed no model at all, could not run, and said so on a
 * panel the user had to go and find.
 *
 * The credential is untouched by any of this. Inventing one would be a billing
 * surprise; picking the middle model of a key the user already chose is not.
 */

import { bestInTier, sameFamilyFallback, type CatalogueModel, type WorkComplexity } from './modelFamilies'

/** A credential, as much of one as this rule needs. */
export interface RuntimeCredential {
  id: string
  /** `anthropic` | `openai` | `gemini` | `openai_compatible` | `ollama`. */
  type: string
  defaultModelId: string | null
}

/** The Default runtime — the user's default chat mode, already resolved. */
export interface RuntimeFallback {
  credentialId: string | null
  credentialType: string | null
  modelId: string | null
}

/**
 * The types whose rows are separate catalogues rather than one namespace.
 *
 * `openai_compatible` because two gateways behind that type are two different
 * catalogues that happen to share a wire format. `ollama` for the sharper
 * version of the same thing: a catalogue there is literally the set of models
 * pulled onto one machine, so a second Ollama credential — a colleague's box on
 * the LAN, a second port — shares nothing with the first beyond the protocol.
 */
const PER_ROW_CATALOGUE: ReadonlySet<string> = new Set(['openai_compatible', 'ollama'])

export function inheritedModelId(
  chosen: RuntimeCredential | null,
  fallback: RuntimeFallback
): string | null {
  if (!chosen) return fallback.modelId
  if (chosen.id === fallback.credentialId) return fallback.modelId ?? chosen.defaultModelId
  if (chosen.defaultModelId) return chosen.defaultModelId
  if (chosen.type === fallback.credentialType && !PER_ROW_CATALOGUE.has(chosen.type)) {
    return fallback.modelId
  }
  return null
}

/**
 * True when the registry positively attributes a model to a *different*
 * catalogue than the one this credential draws on.
 *
 * The panel's test for "this pair cannot run", and it has to agree with
 * {@link inheritedModelId} or the two contradict each other on one screen —
 * lending a model in the select while calling it foreign in the warning. So it
 * refuses to answer in exactly the cases that rule declines to guess about:
 *
 * - a model id the registry has never listed is a hand-written id for a
 *   catalogue we cannot see;
 * - a credential of the same provider type shares the catalogue, so a model
 *   listed only under a sibling row (a second Anthropic key, or one whose
 *   `listModels` call just failed) is not foreign — {@link PER_ROW_CATALOGUE}
 *   again excepted, where two rows are two catalogues.
 */
export function modelBelongsElsewhere(
  modelId: string | null,
  chosen: RuntimeCredential | null,
  models: readonly { id: string; providerId: string }[],
  providers: readonly { id: string; type: string }[]
): boolean {
  if (!modelId || !chosen) return false
  const owners = models.filter((model) => model.id === modelId).map((model) => model.providerId)
  if (owners.length === 0 || owners.includes(chosen.id)) return false
  if (PER_ROW_CATALOGUE.has(chosen.type)) return true
  return !owners.some(
    (owner) => providers.find((provider) => provider.id === owner)?.type === chosen.type
  )
}

/**
 * The Default runtime's model, flattened exactly once.
 *
 * `runtimeService.resolveDefault` has always applied {@link inheritedModelId} to
 * the default chat mode before handing the result on as the fallback — that is
 * the step covering a default mode left on *First available*, whose `modelId` is
 * null. The "Runs with" panel built its fallback from the raw mode instead, and
 * the two therefore disagreed for one credential shape: a second key of the same
 * provider type, where the service lends the default credential's own default
 * model and the panel lent nothing.
 *
 * That was survivable while "nothing" was the end of the chain and both sides
 * showed the same emptiness. It is not survivable now that the chain ends in a
 * tier: the panel would name a floor model the engine never picks. So both sides
 * call this, and the flattening happens in one place.
 */
export function defaultRuntimeModelId(
  fallbackProvider: RuntimeCredential | null,
  modeModelId: string | null
): string | null {
  if (!fallbackProvider) return modeModelId
  return inheritedModelId(fallbackProvider, {
    credentialId: fallbackProvider.id,
    credentialType: fallbackProvider.type,
    modelId: modeModelId
  })
}

/**
 * The tier an agent that expressed no preference falls back to.
 *
 * Medium and not Simple: an agent silently downgraded to the cheapest model does
 * poor work and gives no clue why, which costs more to diagnose than the tier
 * saves. Medium and not Complex for the mirror-image reason — the failure there
 * is a bill.
 */
export const COMPLEXITY_FLOOR: WorkComplexity = 'medium'

/** How {@link resolveRuntimeModel} arrived at a model. */
export type ModelOrigin =
  /** The manifest names this model and the catalogue still lists it. */
  | 'declared'
  /** The manifest names a model the catalogue dropped; this is its nearest sibling. */
  | 'substituted'
  /** The manifest names a Work Complexity tier and this is the tier's best. */
  | 'tier'
  /** From the Default runtime, via {@link inheritedModelId}. */
  | 'inherited'
  /** Nothing above answered, so the Medium floor did. */
  | 'floor'
  /** Nothing answered. */
  | 'none'

export interface ResolvedModelChoice {
  modelId: string | null
  origin: ModelOrigin
  /** For `substituted` only: the manifest's own model, which is no longer listed. */
  replaced: string | null
}

export interface RuntimeModelInput {
  chosen: RuntimeCredential | null
  fallback: RuntimeFallback
  /** `runtime.model` from the manifest. */
  declaredModel: string | null
  /** `runtime.complexity` from the manifest. Mutually exclusive with the above. */
  declaredComplexity: WorkComplexity | null
  /**
   * The live catalogue of the **chosen** credential — not the aggregate registry.
   * A tier only means something against the list one key can actually serve.
   */
  catalogue: readonly CatalogueModel[]
}

/**
 * Which model an agent runs on, in one function called by both sides.
 *
 * The "Runs with" panel and the engine's config generator must produce the same
 * answer or the label predicts a runtime the engine does not build — which is
 * the bug this module was extracted to make unrepresentable, and the reason a
 * tier is resolved here rather than in either caller.
 *
 * Two of the steps are worth reading twice:
 *
 * - **An empty catalogue never overrides an explicit choice.** A gateway that
 *   does not implement `/models` lists nothing, and "nothing lists it" would then
 *   mean "substitute it" or "this tier is empty" for every model on that
 *   credential. So a declared model with no catalogue to check against stays
 *   declared, and a declared tier with no catalogue falls through to the Default
 *   runtime rather than resolving to null.
 * - **A tier that resolves to nothing stays nothing.** When the credential lists
 *   models but none in the chosen tier, the answer is null and the caller says
 *   so. Quietly borrowing the Default runtime's model instead would run the agent
 *   on a tier the user did not ask for, which is the whole failure mode Work
 *   Complexity exists to remove.
 */
export function resolveRuntimeModel(input: RuntimeModelInput): ResolvedModelChoice {
  const type = input.chosen?.type ?? input.fallback.credentialType ?? ''
  const catalogue = input.catalogue
  const known = catalogue.length > 0

  if (input.declaredModel) {
    if (known && !catalogue.some((model) => model.id === input.declaredModel)) {
      const sibling = sameFamilyFallback(input.declaredModel, catalogue, type)
      if (sibling) {
        return { modelId: sibling, origin: 'substituted', replaced: input.declaredModel }
      }
    }
    return { modelId: input.declaredModel, origin: 'declared', replaced: null }
  }

  if (input.declaredComplexity && known) {
    return {
      modelId: bestInTier(input.declaredComplexity, catalogue, type),
      origin: 'tier',
      replaced: null
    }
  }

  const inherited = inheritedModelId(input.chosen, input.fallback)
  if (inherited) return { modelId: inherited, origin: 'inherited', replaced: null }

  const floor = known ? bestInTier(COMPLEXITY_FLOOR, catalogue, type) : null
  if (floor) return { modelId: floor, origin: 'floor', replaced: null }

  return { modelId: null, origin: 'none', replaced: null }
}
