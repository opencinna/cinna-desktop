/**
 * How the session badge writes numbers: token counts, dollars, countdowns and
 * "how long ago". Pure, so the badge's tests and these agree on one spelling.
 */

import type { SessionTelemetryAuth } from '../../../shared/sessionTelemetry'

function trimmed(value: number): string {
  return value.toFixed(1).replace(/\.0$/, '')
}

/** A compact token count: `950`, `12.3K`, `84.2K`, `1M`, `1.5M`. */
export function formatTokens(n: number): string {
  const value = Math.max(0, n)
  if (value < 1000) return String(Math.round(value))
  if (Math.round(value / 100) / 10 < 1000) return `${trimmed(value / 1000)}K`
  return `${trimmed(value / 1_000_000)}M`
}

/**
 * The context fill as a percentage of the window, rounded: `42%`, `<1%` for a
 * context that is not empty but under half a percent. Undefined with no
 * window size: no fake percentage.
 */
export function formatContextPercent(used: number, size: number): string | undefined {
  if (!(size > 0)) return undefined
  const pct = Math.round((Math.max(0, used) / size) * 100)
  if (pct === 0 && used > 0) return '<1%'
  return `${pct}%`
}

/** Dollars spent: two decimals from $1, else three significant digits (`$0.0412`). */
export function formatUsd(n: number): string {
  if (n === 0) return '$0'
  if (Math.abs(n) >= 1) return `$${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
  const s = n.toLocaleString('en-US', { maximumSignificantDigits: 3 })
  return `$${/\.\d$/.test(s) ? `${s}0` : s}`
}

/** A list price per MTok: `$3`, `$0.30`, `$3.75`, `$0.075`. */
export function formatPrice(n: number): string {
  const s = String(Number(n.toFixed(3)))
  return `$${/\.\d$/.test(s) ? `${s}0` : s}`
}

/** Time left on a clock: `3:12`, `0:05`, `1:02:03`. Never negative. */
export function formatCountdown(ms: number): string {
  const total = Math.max(0, Math.ceil(ms / 1000))
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = String(total % 60).padStart(2, '0')
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${s}` : `${m}:${s}`
}

/** How long ago: `just now`, `3 min ago`, `2 h ago`, `4 d ago`. */
export function formatAgo(then: number, now: number): string {
  const seconds = Math.floor(Math.max(0, now - then) / 1000)
  if (seconds < 60) return 'just now'
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes} min ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours} h ago`
  return `${Math.floor(hours / 24)} d ago`
}

/** A TTL in words: `5 min`, `1 hour`, `2 hours`. */
export function formatTtl(ms: number): string {
  const minutes = Math.round(ms / 60_000)
  if (minutes < 60 || minutes % 60 !== 0) return `${minutes} min`
  const hours = minutes / 60
  return `${hours} ${hours === 1 ? 'hour' : 'hours'}`
}

/** A ratio as a whole percentage: `72%`. */
export function formatRatio(ratio: number): string {
  return `${Math.round(ratio * 100)}%`
}

/**
 * The login a session runs on, in words, or undefined where nothing true can
 * be said (`none`, `unknown`). A subscription is named by its label
 * (`Claude Max`), else its plan.
 */
export function formatAuth(auth: SessionTelemetryAuth): string | undefined {
  switch (auth.kind) {
    case 'subscription': {
      if (auth.label) return auth.label
      if (auth.plan) return `${auth.plan.charAt(0).toUpperCase()}${auth.plan.slice(1)} subscription`
      return 'Subscription'
    }
    case 'api_key':
      return 'API key'
    case 'gateway':
      return auth.label ? `Gateway · ${auth.label}` : 'Gateway'
    case 'cloud':
      return auth.label ? `Cloud · ${auth.label}` : 'Cloud provider'
    default:
      return undefined
  }
}
