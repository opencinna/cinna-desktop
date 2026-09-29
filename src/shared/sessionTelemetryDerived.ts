/**
 * What session telemetry means at a given moment: warm or cold cache, the
 * price of the next message's pre-context, the current model's prices, the
 * cache hit ratio. Pure — `now` is passed in — and never stored, because the
 * answers change with the clock.
 */

import { effectivePrices, priceOf, PRICES_CHECKED_AT, type TokenPrices } from './modelPricing'
import { CACHE_TTL_KNOWN, type SessionTelemetry, type TokenTally } from './sessionTelemetry'

export type CacheWarmth = 'warm' | 'cold' | 'unknown'

export interface CacheStateReading {
  state: CacheWarmth
  /** When a warm cache goes cold, if nothing touches it first. */
  flipsAt?: number
}

const DEFAULT_TTL_MS = 5 * 60_000

/**
 * Whether the session's prompt cache is warm at `now`.
 *
 * Codex: always `unknown` (its TTL is not reported). Claude: `unknown` before
 * any request; `cold` after an invalidation no request has followed, or past
 * the expiry; else `warm` until `flipsAt`.
 */
export function cacheState(t: SessionTelemetry, now: number): CacheStateReading {
  if (!CACHE_TTL_KNOWN[t.engine]) return { state: 'unknown' }
  const { lastRequestAt, invalidatedAt } = t.cache
  if (lastRequestAt === undefined) return invalidatedAt !== undefined ? { state: 'cold' } : { state: 'unknown' }
  if (invalidatedAt !== undefined && invalidatedAt >= lastRequestAt) return { state: 'cold' }
  const expiresAt = t.cache.expiresAt ?? lastRequestAt + (t.cache.ttlMs ?? DEFAULT_TTL_MS)
  return now < expiresAt ? { state: 'warm', flipsAt: expiresAt } : { state: 'cold' }
}

export interface CurrentPrices {
  /** The model priced (resolved, else selected). */
  model: string
  prices: TokenPrices
  fast: boolean
  /** The long-context tier applies at the current context size. */
  longContext: boolean
  checkedAt: string
}

function pricedModel(t: SessionTelemetry): string | undefined {
  return t.model.resolved ?? t.model.selected
}

/**
 * The current model's prices per MTok at the session's context size and
 * fast mode, or undefined when the table does not know the model ("price
 * unknown") or cannot price that context size.
 */
export function currentPrices(t: SessionTelemetry): CurrentPrices | undefined {
  const model = pricedModel(t)
  const price = priceOf(model)
  if (!model || !price) return undefined
  const fast = t.runtime?.fastMode === 'on'
  const prices = effectivePrices(price, { fast, contextTokens: t.context.used })
  if (!prices) return undefined
  return {
    model,
    prices,
    fast,
    longContext: price.longContext !== undefined && t.context.used > price.longContext.aboveInputTokens,
    checkedAt: PRICES_CHECKED_AT
  }
}

export interface NextMessageEstimate {
  /** The pre-context read from a warm cache (Claude). */
  warmUsd?: number
  /** The pre-context written to a cold cache (Claude), or read uncached (Codex, an upper bound). */
  coldUsd?: number
  /** When a warm cache goes cold. */
  flipsAt?: number
  /** `api_equivalent` on a subscription: what counts against its limits, not money paid. */
  basis: 'api' | 'api_equivalent'
  note: string
}

const REQUEST_NOTE = 'Pre-context of the first request only, without the new message. A turn with tool calls re-reads the context once per request, so it costs a multiple of this.'

/**
 * The price of the context the next message is sent on top of — the first
 * request only, the new message excluded.
 *
 * Claude: warm = `used × cacheRead`, cold = `used × cacheWrite(ttl)`.
 * Codex: only cold = `used × input`, an upper bound (it caches on its own
 * with an unreported TTL). No figures for a partner cloud (its prices
 * differ) or an unknown model.
 */
export function nextMessageEstimate(t: SessionTelemetry, now: number): NextMessageEstimate {
  const basis = t.auth.kind === 'subscription' ? 'api_equivalent' : 'api'
  if (t.auth.kind === 'cloud') return { basis, note: 'No estimate: cloud provider pricing differs from list prices.' }
  const current = currentPrices(t)
  if (!current) return { basis, note: 'Price unknown for this model.' }
  const used = t.context.used
  if (used <= 0) return { basis, note: 'No context yet.' }
  const { prices } = current
  if (!CACHE_TTL_KNOWN[t.engine]) {
    return {
      coldUsd: (used * prices.input) / 1_000_000,
      basis,
      note: `Upper bound: the whole context at the uncached input price; the runtime's own caching usually makes it cheaper. ${REQUEST_NOTE}`
    }
  }
  const writeRate = t.cache.ttlMs !== undefined && t.cache.ttlMs >= 60 * 60_000 ? prices.cacheWrite1h : prices.cacheWrite5m
  const cache = cacheState(t, now)
  return {
    warmUsd: (used * prices.cacheRead) / 1_000_000,
    coldUsd: (used * writeRate) / 1_000_000,
    ...(cache.flipsAt !== undefined ? { flipsAt: cache.flipsAt } : {}),
    basis,
    note: REQUEST_NOTE
  }
}

function hitRatio(tokens: TokenTally | undefined): number | undefined {
  if (!tokens) return undefined
  const read = tokens.cacheRead + tokens.cacheWrite + tokens.input
  return read > 0 ? tokens.cacheRead / read : undefined
}

/** `cacheRead / (cacheRead + cacheWrite + input)` for the session's totals and its last counted turn. */
export function cacheHitRatio(t: SessionTelemetry): { session?: number; lastTurn?: number } {
  const session = hitRatio(t.totals.tokens)
  const lastTurn = hitRatio(t.totals.lastTurn)
  return {
    ...(session !== undefined ? { session } : {}),
    ...(lastTurn !== undefined ? { lastTurn } : {})
  }
}
