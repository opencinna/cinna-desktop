/**
 * How long a provider keeps a prompt cache alive, for the cache-expiry notice
 * (`cacheExpiryNotice` in `sessionTelemetryDerived.ts`). Only Claude reports
 * its TTL (the TTL of each request's cache writes); for every other provider
 * the figures below are what its docs promise, read as two bounds:
 *
 * - `typicalMs` — past it the cache has **probably** gone;
 * - `maxMs` — past it the cache is **certainly** gone, whatever the settings.
 *
 * Idle time is measured from the last model request (`cache.lastRequestAt`),
 * which is right for every provider below: each hit refreshes the cache.
 *
 * Sources, checked on {@link TTL_CHECKED_AT}:
 * - Anthropic: https://platform.claude.com/docs/en/build-with-claude/prompt-caching
 *   — a 5-minute default lifetime, an optional 1-hour cache, and the TTL is
 *   refreshed at no cost each time the cached content is used.
 * - OpenAI: https://developers.openai.com/api/docs/guides/prompt-caching —
 *   in-memory retention clears after 5–10 minutes idle and always within an
 *   hour of last use; `prompt_cache_retention: "24h"` (extended retention)
 *   keeps it up to 24 hours. On GPT-5.6 and later that field is deprecated for
 *   `prompt_cache_options.ttl`, a minimum lifetime of which only 30m is
 *   supported. Whether Codex or OpenCode asks for either is not visible, so
 *   the bounds stay 1 h typical and 24 h max.
 * - Google: https://ai.google.dev/gemini-api/docs/caching — implicit caching
 *   (Gemini 2.5 and later) documents no TTL; explicit caches default to 1 h.
 *   Treated like OpenAI.
 * - Anything else (an OpenCode provider that is none of those): the same
 *   conservative bounds.
 */

import type { SessionTelemetry, TelemetryEngine } from './sessionTelemetry'

export const TTL_CHECKED_AT = '2026-10-26'

export type CacheProvider = 'anthropic' | 'openai' | 'google' | 'unknown'

const MIN = 60_000
const HOUR = 60 * MIN

export interface CacheTtlBounds {
  /** Past this idle time the cache has probably expired. */
  typicalMs: number
  /** Past this idle time the cache has certainly expired. */
  maxMs: number
}

/** Anthropic's default TTL, when no request has shown one. */
export const ANTHROPIC_DEFAULT_TTL_MS = 5 * MIN

export const CACHE_TTL_BOUNDS: Readonly<Record<CacheProvider, Readonly<CacheTtlBounds>>> = Object.freeze({
  // `typicalMs` is replaced by the TTL a request showed, when one did.
  anthropic: Object.freeze({ typicalMs: ANTHROPIC_DEFAULT_TTL_MS, maxMs: HOUR }),
  openai: Object.freeze({ typicalMs: HOUR, maxMs: 24 * HOUR }),
  google: Object.freeze({ typicalMs: HOUR, maxMs: 24 * HOUR }),
  unknown: Object.freeze({ typicalMs: HOUR, maxMs: 24 * HOUR })
})

/**
 * The provider of an OpenCode model id (`<provider key>/<model>`). The
 * launcher's config names the first Anthropic and OpenAI credentials by their
 * canonical keys (`anthropic`, `openai`) and any further one
 * `<type>-<hash>` (`anthropic-1a2b3c4d`); a Gemini credential is always a
 * custom `gemini-<hash>` entry (`configGenerator.ts`). Anything else — an
 * OpenAI-compatible gateway, Ollama — is `unknown`.
 */
export function opencodeProviderKeyOf(modelId: string | undefined): string | undefined {
  if (!modelId) return undefined
  const slash = modelId.indexOf('/')
  return slash > 0 ? modelId.slice(0, slash).toLowerCase() : undefined
}

function providerOfKey(key: string | undefined): CacheProvider {
  if (!key) return 'unknown'
  // `<family>` or `<family>-<8 hex>`; `openai-compatible-<hash>` is a gateway, not OpenAI.
  const family = /^([a-z]+)(?:-[0-9a-f]{8})?$/.exec(key)?.[1]
  if (family === 'anthropic') return 'anthropic'
  if (family === 'openai') return 'openai'
  if (family === 'google' || family === 'gemini') return 'google'
  return 'unknown'
}

/**
 * Each engine's prompt-cache provider, or null where the model id names it
 * (`<provider key>/<model>`: OpenCode runs any provider).
 */
export const ENGINE_CACHE_PROVIDER: Readonly<Record<TelemetryEngine, CacheProvider | null>> = Object.freeze({
  claude: 'anthropic',
  codex: 'openai',
  antigravity: 'google',
  opencode: null
})

/** Who caches the prompt: Claude → Anthropic, Codex → OpenAI, Antigravity → Google, OpenCode by its model id's provider. */
export function cacheProviderOf(engine: TelemetryEngine, modelId: string | undefined): CacheProvider {
  return ENGINE_CACHE_PROVIDER[engine] ?? providerOfKey(opencodeProviderKeyOf(modelId))
}

/**
 * The model id to look a price up under: an OpenCode id loses its provider
 * prefix only for Anthropic's and OpenAI's own APIs — every other provider
 * resells at its own prices, so its models get none. Other engines' ids are
 * returned as they are.
 */
export function pricingModelId(engine: TelemetryEngine, modelId: string | undefined): string | undefined {
  if (!modelId || ENGINE_CACHE_PROVIDER[engine] !== null) return modelId
  const provider = providerOfKey(opencodeProviderKeyOf(modelId))
  if (provider !== 'anthropic' && provider !== 'openai') return undefined
  return modelId.slice(modelId.indexOf('/') + 1)
}

/**
 * The session's TTL bounds. Anthropic's typical bound is the TTL a request
 * showed (Claude's `cache.ttlMs` when observed), else its 5-minute default.
 */
export function cacheTtlBounds(t: SessionTelemetry): CacheTtlBounds {
  const provider = cacheProviderOf(t.engine, t.model.resolved ?? t.model.selected)
  const bounds = CACHE_TTL_BOUNDS[provider]
  if (provider !== 'anthropic') return { ...bounds }
  const observed = t.cache.ttlSource === 'observed' ? t.cache.ttlMs : undefined
  return { typicalMs: observed ?? ANTHROPIC_DEFAULT_TTL_MS, maxMs: Math.max(bounds.maxMs, observed ?? 0) }
}
