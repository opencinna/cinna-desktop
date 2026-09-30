import { describe, expect, it } from 'vitest'
import {
  formatAgo,
  formatAuth,
  formatContextPercent,
  formatCountdown,
  formatPrice,
  formatRatio,
  formatTokens,
  formatTtl,
  formatUsd
} from './telemetryFormat'

describe('telemetryFormat', () => {
  it('writes token counts compactly', () => {
    expect([0, 950, 1000, 12_345, 84_200, 999_949, 999_960, 1_000_000, 1_500_000].map(formatTokens))
      .toEqual(['0', '950', '1K', '12.3K', '84.2K', '999.9K', '1M', '1M', '1.5M'])
  })

  it('writes the context fill, <1% for a tiny one, nothing without a window', () => {
    expect(formatContextPercent(84_200, 200_000)).toBe('42%')
    expect(formatContextPercent(100, 1_000_000)).toBe('<1%')
    expect(formatContextPercent(0, 200_000)).toBe('0%')
    expect(formatContextPercent(5_000, 0)).toBeUndefined()
  })

  it('writes dollars: two decimals from $1, three significant digits below', () => {
    expect(formatUsd(0.0412345)).toBe('$0.0412')
    expect(formatUsd(0.5)).toBe('$0.50')
    expect(formatUsd(1)).toBe('$1.00')
    expect(formatUsd(12.345)).toBe('$12.35')
    expect(formatUsd(1234.5)).toBe('$1,234.50')
    expect(formatUsd(0)).toBe('$0')
  })

  it('writes list prices', () => {
    expect([3, 0.3, 3.75, 0.075, 15].map(formatPrice)).toEqual(['$3', '$0.30', '$3.75', '$0.075', '$15'])
  })

  it('writes countdowns and ages', () => {
    expect(formatCountdown(192_000)).toBe('3:12')
    expect(formatCountdown(4_100)).toBe('0:05')
    expect(formatCountdown(3_723_000)).toBe('1:02:03')
    expect(formatCountdown(-5)).toBe('0:00')
    expect(formatAgo(0, 30_000)).toBe('just now')
    expect(formatAgo(0, 3 * 60_000 + 5_000)).toBe('3 min ago')
    expect(formatAgo(0, 2 * 3_600_000)).toBe('2 h ago')
    expect(formatAgo(0, 4 * 86_400_000)).toBe('4 d ago')
  })

  it('writes TTLs and ratios', () => {
    expect(formatTtl(5 * 60_000)).toBe('5 min')
    expect(formatTtl(60 * 60_000)).toBe('1 hour')
    expect(formatTtl(120 * 60_000)).toBe('2 hours')
    expect(formatRatio(0.724)).toBe('72%')
  })

  it('names the login, and nothing for none or unknown', () => {
    expect(formatAuth({ kind: 'subscription', label: 'Claude Max', plan: 'max' })).toBe('Claude Max')
    expect(formatAuth({ kind: 'subscription', plan: 'pro' })).toBe('Pro subscription')
    expect(formatAuth({ kind: 'subscription' })).toBe('Subscription')
    expect(formatAuth({ kind: 'api_key' })).toBe('API key')
    expect(formatAuth({ kind: 'gateway' })).toBe('Gateway')
    expect(formatAuth({ kind: 'cloud' })).toBe('Cloud provider')
    expect(formatAuth({ kind: 'unknown' })).toBeUndefined()
    expect(formatAuth({ kind: 'none' })).toBeUndefined()
  })
})
