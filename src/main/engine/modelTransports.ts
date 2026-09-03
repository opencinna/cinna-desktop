/**
 * Which model transports the pinned engine can actually drive, and how the
 * desktop reaches a provider that it cannot.
 *
 * ## The set, read out of the binary
 *
 * `SessionRunnerModel` builds an SDK model from a resolved catalog entry, and
 * it has exactly three branches (de-minified from `opencode` **1.18.27**,
 * 3 September 2026; see `docs/agents/local_agents/opencode_contract.md` §9.5.10):
 *
 * ```
 * if api.type == "aisdk" && api.package == "@ai-sdk/openai"             → OpenAI transport
 * if api.type == "aisdk" && api.package == "@ai-sdk/anthropic"          → Anthropic transport
 * if api.type == "aisdk" && api.package == "@ai-sdk/openai-compatible"
 *                        && api.url                                     → compatible transport
 * else fail UnsupportedApiError(providerID, modelID,
 *                              api.type == "aisdk" ? `${type}:${package}` : type)
 * ```
 *
 * **Everything else the engine will happily catalogue, it cannot run.** That
 * includes `@ai-sdk/google`, which is what a `gemini` credential becomes if it
 * is emitted under OpenCode's canonical `google` key: the model is listed, it
 * is *available*, a session opens against it — and the turn dies with
 * `UnsupportedApiError`, which like `ModelUnavailableError` reaches **no event
 * at all**, so the desktop waits out its own twenty-minute ceiling. That was a
 * real user-facing hang, not a hypothetical.
 *
 * Two conclusions follow, and both are implemented rather than documented:
 * a turn checks this before it opens a session (`localAgentTurnRunner`), and
 * the generator never emits an entry it knows the engine cannot drive
 * (`configGenerator`).
 *
 * ## The compatible route
 *
 * Google publishes an OpenAI-shaped endpoint for the Gemini models, so a
 * `gemini` credential is emitted as an OpenAI-compatible entry pointed at it
 * rather than as the canonical `google` key. That turns a transport the engine
 * refuses into one of the three it accepts, using the same credential.
 */

/**
 * The `api.package` values `SessionRunnerModel` knows how to build a model
 * from. Frozen, and a `Set` because membership is the only question asked of it.
 */
export const SUPPORTED_MODEL_PACKAGES: ReadonlySet<string> = Object.freeze(
  new Set(['@ai-sdk/openai', '@ai-sdk/anthropic', '@ai-sdk/openai-compatible'])
)

/**
 * Google's OpenAI-compatible base URL for the Gemini models.
 *
 * No trailing slash: the AI SDK's compatible provider appends `/chat/completions`,
 * and a trailing slash would make that `…/openai//chat/completions`.
 */
export const GEMINI_OPENAI_BASE_URL = 'https://generativelanguage.googleapis.com/v1beta/openai'

/** The `api` block of one entry in `GET /api/model`, as far as this cares. */
export interface EngineModelApi {
  type?: unknown
  package?: unknown
  url?: unknown
}

/**
 * Why the engine cannot build a model from this `api` block, or null if it can.
 *
 * The string is the engine's **own** wording for the same condition —
 * `aisdk:@ai-sdk/google`, or the bare `api.type` for a non-SDK entry — so a
 * message the user reports can be matched against the engine's log line
 * without a translation step.
 *
 * **An unreadable or absent `api` block is not a refusal.** This runs on JSON
 * from a separately-versioned binary, and the cost of the two mistakes is not
 * symmetrical: refusing a turn the engine would have run is a broken agent,
 * while allowing one it cannot run is the hang this exists to shorten — which
 * the turn's own ceiling still catches.
 */
export function unsupportedModelApi(api: EngineModelApi | undefined): string | null {
  if (!api || typeof api !== 'object') return null
  const type = api.type
  if (typeof type !== 'string') return null
  if (type !== 'aisdk') return type
  const pkg = api.package
  if (typeof pkg !== 'string') return null
  if (!SUPPORTED_MODEL_PACKAGES.has(pkg)) return `${type}:${pkg}`
  // The one branch that is conditional on more than the package name.
  if (pkg === '@ai-sdk/openai-compatible' && typeof api.url !== 'string') return `${type}:${pkg}`
  return null
}
