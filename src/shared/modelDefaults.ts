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
 * Non-chat model families that must never be auto-selected — and are hidden from
 * the managed model picker. A provider's discovery cache (e.g. OpenAI's) lists
 * embeddings/audio/image/moderation models alongside chat ones, so "pick the
 * first model" or "newest" can silently land on `text-embedding-ada-002`.
 * Conservative on purpose: only clearly non-conversational families. Matches a
 * substring of the id, case-insensitive.
 */
const NON_CHAT_MODEL =
  /embedding|whisper|\btts\b|-tts|dall-?e|gpt-image|imagen|stable-diffusion|moderation|davinci|babbage|curie|rerank|-audio|-realtime|-transcribe|-search-|-similarity-|veo|sora|llama-guard/i

/** True when a model id looks usable for chat (not an embedding/audio/image/etc.). */
export function isChatCapableModelId(id: string): boolean {
  return !NON_CHAT_MODEL.test(id)
}

/**
 * Choose an auto-default model id from a candidate list (assumed newest-first).
 * Prefers a model that is both chat-capable and generally available, then falls
 * back to any non-gated model, then the first entry. Returns null for an empty
 * list. Used for the silent default only — gated/non-chat models stay otherwise
 * selectable for accounts that want them.
 */
export function pickDefaultModelId(ids: readonly string[]): string | null {
  return (
    ids.find((id) => isChatCapableModelId(id) && isDefaultEligibleModelId(id)) ??
    ids.find(isDefaultEligibleModelId) ??
    ids[0] ??
    null
  )
}
