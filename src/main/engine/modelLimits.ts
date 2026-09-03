/**
 * The context and output ceilings the desktop tells the engine about, for the
 * models of a **custom** provider entry.
 *
 * ## Why this exists at all
 *
 * A **canonical** provider key (`anthropic`, `openai`) is a models.dev key, so
 * OpenCode already knows every model that provider has, with its real windows —
 * `anthropic/claude-sonnet-4-6` arrives carrying
 * `limit: {context: 1000000, output: 128000}`. Nothing here applies to those,
 * and `configGenerator` deliberately emits no `models` map for them: our
 * approximations would *replace* true numbers, and for that model would have
 * cut the output window from 128000 to 32000.
 *
 * A **custom** entry has no catalog behind it. That is every second credential
 * of a type the user holds, and every OpenAI-compatible gateway. For those the
 * engine defaults each model to **`limit: {context: 0, output: 0}`**, and
 * `SessionRunnerModel` passes `limits: {context, output}` straight into the
 * request executor — where the **Anthropic** transport sends `limit.output` as
 * `max_tokens`. The provider then answers:
 *
 * ```
 * 400 invalid_request_error "stream cannot be true when max_tokens is 0"
 * ```
 *
 * which is what every folder agent on a second Anthropic credential did on its
 * first real turn. The **OpenAI-compatible** transport happens to send no
 * `max_tokens` at all, so the identical zero is invisible on a gateway — which
 * is why this is a table over every provider type rather than a fix aimed at
 * Anthropic. Verified against `opencode` **1.18.27** on **3 September 2026** by
 * pointing two otherwise identical custom entries at a probe server: without a
 * `limit` the request body carried `"max_tokens": 0`, with one it carried the
 * number below. See `docs/agents/local_agents/opencode_contract.md` §9.5.9.
 *
 * ## What these numbers are, and what they are not
 *
 * **Each is a floor chosen to be valid for every current model of that type —
 * not the truth about any particular model.** The desktop has no per-model
 * metadata to be truthful with: a runtime DTO carries a model's `id` and
 * `name` and nothing else, and the adapters do not expose windows either
 * (`src/main/llm/anthropic.ts` uses one flat `max_tokens` of 8192 for every
 * Anthropic model, whatever it is).
 *
 * The cost of being approximate runs in both directions, and only one of them
 * is loud: a number **above** what a model accepts is rejected by the provider
 * on the first turn, and a number **below** what it supports silently truncates
 * a long answer with nothing reporting it. So each entry is the largest figure
 * valid across that type's current line-up, and the quiet failure is the one to
 * watch for.
 *
 * **Where the truth would come from:** each adapter's `listModels()` already
 * calls the provider's own model endpoint, which publishes context and output
 * windows; returning them on `ModelInfo` and threading them through the runtime
 * DTOs to `EngineProviderInput.models` would make this table unnecessary.
 * Until then — **revisit whenever a model ships with a smaller output window
 * than its type's figure here.**
 */

/** One model's ceilings, in tokens, as the engine config spells them. */
export interface EngineModelLimit {
  /** Total context window. */
  readonly context: number
  /** Maximum tokens in one reply. Reaches Anthropic as `max_tokens`. */
  readonly output: number
}

/**
 * Every credential type the engine config generator can emit an entry for.
 *
 * Declared here rather than in `configGenerator` so that the limit table and
 * `PROVIDER_NPM` are both `Record<EngineProviderType, …>`: **a type added to
 * this union is a compile error in every table that has to answer for it**,
 * which is the guarantee that a new provider type cannot quietly arrive with no
 * limit and reintroduce `max_tokens: 0`.
 */
export type EngineProviderType = 'anthropic' | 'openai' | 'gemini' | 'openai_compatible'

/**
 * The ceilings a custom entry's models are declared with, by credential type.
 *
 * Frozen because it is a fact about the pinned engine and the providers, not a
 * setting: nothing in this app should be able to reach in and change what the
 * config claims a model can do.
 */
export const CUSTOM_MODEL_LIMITS: Readonly<Record<EngineProviderType, EngineModelLimit>> =
  Object.freeze({
    /** Sonnet 4.6 and Opus 4.x accept 32k output; the canonical entry's real 128k comes from models.dev. */
    anthropic: Object.freeze({ context: 200_000, output: 32_000 }),
    /** GPT-4o-class: 128k context, 16k output. */
    openai: Object.freeze({ context: 128_000, output: 16_384 }),
    /** Gemini 2.5's 1M context and 64k output. */
    gemini: Object.freeze({ context: 1_048_576, output: 65_536 }),
    /** A gateway is whatever the user pointed it at, so this is the cautious pair. */
    openai_compatible: Object.freeze({ context: 128_000, output: 8_192 })
  })

/**
 * Whether a credential type string is one the generator can emit an entry for.
 *
 * Derived from {@link CUSTOM_MODEL_LIMITS}'s own keys so it cannot drift from
 * the union: a type added to `EngineProviderType` must be given a limit, and
 * the moment it is, this recognises it.
 *
 * A credential's `type` reaches the generator as a plain `string` out of the
 * database, so this is the narrowing every table lookup goes through. **There
 * is deliberately no fallback limit behind it.** An earlier version had one, on
 * the reasoning that forgetting a row should not mean a zero; making the table
 * exhaustive over the union removes the possibility instead of softening it,
 * and a constant no code path can reach is a claim that rots.
 */
export function isEngineProviderType(value: string): value is EngineProviderType {
  return Object.prototype.hasOwnProperty.call(CUSTOM_MODEL_LIMITS, value)
}
