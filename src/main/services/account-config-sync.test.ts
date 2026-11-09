import { beforeEach, describe, expect, it, vi } from 'vitest'

/** The runner's order: the sync, then the one-time colour adoption, then the renderer's notification. */

const mocks = vi.hoisted(() => ({
  calls: [] as string[],
  sync: vi.fn(),
  adopt: vi.fn(),
  publish: vi.fn()
}))
vi.mock('./accountConfigService', () => ({ accountConfigService: { syncAccountConfig: mocks.sync } }))
vi.mock('./brandTheme/brandThemeService', () => ({ brandThemeService: { adoptDefaultMode: mocks.adopt } }))
vi.mock('../host/events', () => ({ publishEvent: mocks.publish }))
vi.mock('../logger/logger', () => ({ createLogger: () => ({ debug() {}, info() {}, warn() {}, error() {} }) }))
vi.mock('../auth/cinna-oauth', () => ({ CinnaReauthRequired: class CinnaReauthRequired extends Error {} }))

const { runAccountConfigSyncOnce, stopAccountConfigPeriodicSync } = await import('./account-config-sync')
const { CinnaReauthRequired } = await import('../auth/cinna-oauth')

beforeEach(() => {
  mocks.calls.length = 0
  mocks.sync.mockReset().mockImplementation(async () => { mocks.calls.push('sync') })
  mocks.adopt.mockReset().mockImplementation((userId: string) => { mocks.calls.push(`adopt ${userId}`) })
  mocks.publish.mockReset().mockImplementation((_channel: string, payload: unknown) => { mocks.calls.push(`notify ${JSON.stringify(payload)}`) })
})

describe('runAccountConfigSyncOnce', () => {
  it('adopts after the sync, which may have made the default, and before notifying', async () => {
    await runAccountConfigSyncOnce('u1')
    expect(mocks.calls).toEqual(['sync', 'adopt u1', 'notify {}'])
  })

  it('still adopts when the sync fails: an offline start has a cached brand', async () => {
    mocks.sync.mockRejectedValue(new Error('offline'))
    await runAccountConfigSyncOnce('u1')
    expect(mocks.calls).toEqual(['adopt u1', 'notify {"error":"sync_failed"}'])
  })

  it('still adopts when the account needs signing in again', async () => {
    mocks.sync.mockRejectedValue(new CinnaReauthRequired('reauth'))
    await runAccountConfigSyncOnce('u1')
    expect(mocks.calls).toEqual(['adopt u1', 'notify {"error":"reauth_required"}'])
  })

  it('does nothing for a profile that was left while the sync ran', async () => {
    mocks.sync.mockImplementation(async () => { stopAccountConfigPeriodicSync() })
    await runAccountConfigSyncOnce('u1')
    expect(mocks.calls).toEqual([])
    mocks.sync.mockImplementation(async () => { stopAccountConfigPeriodicSync(); throw new Error('offline') })
    await runAccountConfigSyncOnce('u1')
    expect(mocks.calls).toEqual([])
  })
})
