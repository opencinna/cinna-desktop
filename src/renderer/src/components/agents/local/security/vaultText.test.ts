import { describe, expect, it } from 'vitest'
import { GB, formatBytes, isHostPattern, lockAfterLabel, sizeLimitProblem, unavailableText, unlockedLabel } from './vaultText'

describe('sizeLimitProblem', () => {
  it('accepts a limit at or above what the vault uses', () => {
    expect(sizeLimitProblem('10', null)).toBeNull()
    expect(sizeLimitProblem('12.5', 3 * GB)).toBeNull()
    expect(sizeLimitProblem('3', 3 * GB)).toBeNull()
  })

  it('refuses to go below what is used, naming the usage', () => {
    expect(sizeLimitProblem('2', 2.4 * GB)).toBe('The vault already uses 2.4 GB; the limit can’t go below that.')
  })

  it('refuses what is not a size', () => {
    expect(sizeLimitProblem('', null)).toBe('Enter the limit in GB.')
    expect(sizeLimitProblem('ten', null)).toBe('Enter the limit in GB.')
    expect(sizeLimitProblem('0.5', null)).toBe('The limit is at least 1 GB.')
  })
})

describe('vault copy', () => {
  it('says why this Mac cannot hold a vault in words, and nothing when it can', () => {
    expect(unavailableText({ ok: true })).toBeNull()
    expect(unavailableText({ ok: false, reason: 'unsupported-os' })).toBe('Needs macOS 15 or later on Apple silicon.')
    expect(unavailableText({ ok: false, reason: 'nested' })).toBe('Not available inside a virtual machine.')
    expect(unavailableText({ ok: false, reason: 'helper-missing' })).toBe('The vault helper is missing from this build.')
    expect(unavailableText({ ok: false, reason: 'image-missing' })).toBe('The guest image isn’t installed.')
  })

  it('counts the unlock window down, and says Running while a turn holds it', () => {
    expect(unlockedLabel(10_000 + 42_000, 10_000)).toBe('Unlocked · locks in 0:42')
    expect(unlockedLabel(10_000 + 272_000, 10_000)).toBe('Unlocked · locks in 4:32')
    expect(unlockedLabel(5_000, 10_000)).toBe('Unlocked · locks in 0:00')
    expect(unlockedLabel(null, 10_000)).toBe('Running')
    // No timer (until Cinna quits): neither a countdown nor "Running".
    expect(unlockedLabel(null, 10_000, 0)).toBe('Unlocked')
  })

  it('says a lock timeout from the backend’s list in words', () => {
    expect(lockAfterLabel(30_000)).toBe('30 seconds')
    expect(lockAfterLabel(300_000)).toBe('5 minutes')
    expect(lockAfterLabel(60_000)).toBe('1 minute')
    expect(lockAfterLabel(3_600_000)).toBe('1 hour')
    expect(lockAfterLabel(0)).toBe('Until Cinna quits')
  })

  it('formats sizes and host patterns', () => {
    expect(formatBytes(10 * GB)).toBe('10 GB')
    expect(formatBytes(2.4 * GB)).toBe('2.4 GB')
    expect(formatBytes(512 * 1024 ** 2)).toBe('512 MB')
    expect(isHostPattern('api.example.com')).toBe(true)
    expect(isHostPattern('*.example.com')).toBe(true)
    expect(isHostPattern('localhost')).toBe(false)
    expect(isHostPattern('https://x.com')).toBe(false)
  })
})
