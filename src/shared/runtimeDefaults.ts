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
 *    keeps a working agent. `openai_compatible` is excluded — two gateways
 *    behind that type are two different catalogues that happen to share a
 *    wire format.
 * 4. **Nothing.** Better than a model the credential cannot serve: the engine
 *    builds `<credential>/<model>` verbatim, so a wrong pairing is a config
 *    that saves cleanly and fails on the agent's first turn, while nothing at
 *    all is a skip the panel can explain and the user can fix.
 *
 * There is deliberately no "first model in the list" step. Picking one would
 * run the agent on a model the user never chose — the same reasoning that
 * keeps `runtimeService` from inventing a *credential*.
 */

/** A credential, as much of one as this rule needs. */
export interface RuntimeCredential {
  id: string
  /** `anthropic` | `openai` | `gemini` | `openai_compatible`. */
  type: string
  defaultModelId: string | null
}

/** The Default runtime — the user's default chat mode, already resolved. */
export interface RuntimeFallback {
  credentialId: string | null
  credentialType: string | null
  modelId: string | null
}

/** The one type whose rows are separate catalogues rather than one namespace. */
const PER_ROW_CATALOGUE = 'openai_compatible'

export function inheritedModelId(
  chosen: RuntimeCredential | null,
  fallback: RuntimeFallback
): string | null {
  if (!chosen) return fallback.modelId
  if (chosen.id === fallback.credentialId) return fallback.modelId ?? chosen.defaultModelId
  if (chosen.defaultModelId) return chosen.defaultModelId
  if (chosen.type === fallback.credentialType && chosen.type !== PER_ROW_CATALOGUE) {
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
 *   `listModels` call just failed) is not foreign — `openai_compatible` again
 *   excepted, where two gateways are two catalogues.
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
  if (chosen.type === PER_ROW_CATALOGUE) return true
  return !owners.some(
    (owner) => providers.find((provider) => provider.id === owner)?.type === chosen.type
  )
}
