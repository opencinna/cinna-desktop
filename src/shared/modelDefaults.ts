/**
 * Default-model selection helper, shared by the renderer (`resolveModel`) and the
 * main process (account-config sync).
 *
 * Why this exists: Anthropic's `models.list()` returns its access-gated top tiers
 * (Claude Fable / Mythos) even for accounts that can only *see* them, not *call*
 * them — calling 404s ("… is not available. Please use Opus 4.8."). The API
 * exposes no "recommended default" or per-account entitlement flag, so "pick the
 * newest listed model" silently lands on a model the account can't use.
 *
 * This picks an *auto-default* only: a model that is safe to select when nothing
 * explicit was chosen. The gated tiers remain fully selectable in the model
 * picker for accounts that have access — we just don't auto-default to them.
 */

/**
 * Model families that are access-gated / preview and should never be chosen as a
 * silent default. Matches the id (e.g. `claude-fable-5`, `claude-mythos-5`,
 * `claude-mythos-preview`). Case-insensitive.
 */
const GATED_DEFAULT_MODEL = /fable|mythos/i

/** True when a model id is fine to use as an auto-default. */
export function isDefaultEligibleModelId(id: string): boolean {
  return !GATED_DEFAULT_MODEL.test(id)
}

/**
 * Choose an auto-default model id from a candidate list (assumed newest-first):
 * the first generally-available model, falling back to the first entry only if
 * every candidate is gated. Returns null for an empty list.
 */
export function pickDefaultModelId(ids: readonly string[]): string | null {
  return ids.find(isDefaultEligibleModelId) ?? ids[0] ?? null
}
