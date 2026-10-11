/**
 * The cloud agents' Update card follows the catalog listing: a listing that
 * moved and names a newer revision of a cloud agent this profile installed
 * than its synced row knows of runs the remote agents' sync once.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'

const rows = vi.hoisted(() => ({ list: [] as unknown[] }))
const runSyncOnce = vi.hoisted(() => vi.fn<(userId: string) => Promise<void>>())
const listeners = vi.hoisted(() => new Set<(userId: string, listing: unknown) => void>())
const cached = vi.hoisted(() => ({ listing: null as unknown }))
const scope = vi.hoisted(() => ({ active: 'p-cinna' }))

vi.mock('../db/agents', () => ({ agentRepo: { listRemote: () => rows.list } }))
vi.mock('./remote-sync', () => ({ runSyncOnce }))
vi.mock('../services/libraryService', () => ({
  libraryService: {
    cached: () => cached.listing,
    onListingChanged: (listener: (userId: string, listing: unknown) => void) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    }
  }
}))
vi.mock('../auth/scope', () => ({ getProfileScopeUserId: () => scope.active }))
vi.mock('../logger/logger', () => ({
  createLogger: () => ({ debug: () => {}, info: () => {}, warn: () => {}, error: () => {} })
}))

const { installCloudUpdateFollow, _resetCloudUpdateFollow } = await import('./cloudUpdateFollow')

const PROFILE = 'p-cinna'

function item(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    kind: 'agent',
    runs_on: 'cloud',
    uuid: 'u-cloud',
    latest: { revision_number: 2 },
    my_installs: [{ where: 'cloud', install_id: 'i-1', revision_number: 1 }],
    ...overrides
  }
}

function row(latest: number | null, installed = 1, remoteTargetId: string | null = 'i-1'): unknown {
  return {
    id: 'a-1',
    remoteTargetId,
    remoteMetadata: {
      bundle_version: {
        installed_revision_number: installed,
        latest_revision_number: latest,
        update_available: latest !== null && latest > installed,
        update_mode: 'manual'
      }
    }
  }
}

/** A listing lands, as libraryService tells its listeners. */
function land(items: unknown[], profile = PROFILE): unknown {
  const listing = { host: 'https://core.test', items, agents: [], fetchedAt: new Date(), available: true }
  cached.listing = listing
  for (const listener of listeners) listener(profile, listing)
  return listing
}

/** Let the `.finally` of a sync run. */
const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

beforeEach(() => {
  _resetCloudUpdateFollow()
  listeners.clear()
  rows.list = []
  cached.listing = null
  runSyncOnce.mockReset()
  runSyncOnce.mockResolvedValue(undefined)
  scope.active = PROFILE
  installCloudUpdateFollow()
  // The activation's own first listing, which the activation sync already covers.
  land([])
})

describe('cloudUpdateFollow', () => {
  it('syncs once when the listing names a newer revision of an installed cloud agent', async () => {
    rows.list = [row(1)]
    land([item()])
    expect(runSyncOnce.mock.calls).toEqual([[PROFILE]])

    // The same revision again (the sync's bundle_version lagging): not asked again.
    await settle()
    land([item()])
    expect(runSyncOnce).toHaveBeenCalledTimes(1)

    // The next revision is.
    land([item({ latest: { revision_number: 3 } })])
    expect(runSyncOnce).toHaveBeenCalledTimes(2)
  })

  it('also syncs when the row has no latest revision yet, only its installed one', () => {
    rows.list = [row(null, 1)]
    land([item()])
    expect(runSyncOnce).toHaveBeenCalledTimes(1)
  })

  it('does not sync when the row already knows that revision', () => {
    rows.list = [row(2)]
    land([item()])
    expect(runSyncOnce).not.toHaveBeenCalled()
  })

  it('does not sync for a desktop agent, a skill, or a cloud agent this profile did not install', () => {
    rows.list = [row(1)]
    land([
      item({ runs_on: 'desktop', my_installs: [{ where: 'desktop', install_id: 'i-1' }] }),
      item({ kind: 'skill', runs_on: null }),
      item({ my_installs: [] }),
      item({ my_installs: [{ where: 'cloud', install_id: 'someone-else' }] })
    ])
    expect(runSyncOnce).not.toHaveBeenCalled()
  })

  it('does not sync for a row without an install id or without version state', () => {
    rows.list = [row(1, 1, null), { id: 'a-2', remoteTargetId: 'i-1', remoteMetadata: {} }]
    land([item()])
    expect(runSyncOnce).not.toHaveBeenCalled()
  })

  it('coalesces listings that land while its sync runs into one look afterwards', async () => {
    let finish!: () => void
    runSyncOnce.mockImplementationOnce(() => new Promise<void>((resolve) => (finish = resolve)))
    rows.list = [row(1)]
    land([item()])
    land([item({ latest: { revision_number: 3 } })])
    land([item({ latest: { revision_number: 3 } })])
    expect(runSyncOnce).toHaveBeenCalledTimes(1)

    // The sync wrote revision 3 already: nothing left to fetch.
    rows.list = [row(3)]
    finish()
    await settle()
    expect(runSyncOnce).toHaveBeenCalledTimes(1)
  })

  it('does not follow the first listing after a profile becomes active: its activation sync covers it', () => {
    _resetCloudUpdateFollow()
    installCloudUpdateFollow()
    rows.list = [row(1)]
    land([item()])
    expect(runSyncOnce).not.toHaveBeenCalled()
    land([item({ latest: { revision_number: 3 } })])
    expect(runSyncOnce).toHaveBeenCalledTimes(1)
  })

  it('never syncs for a profile that is no longer active, nor re-checks after a switch mid-sync', async () => {
    rows.list = [row(1)]
    scope.active = 'p-other'
    land([item()])
    expect(runSyncOnce).not.toHaveBeenCalled()

    scope.active = PROFILE
    land([])
    let finish!: () => void
    runSyncOnce.mockImplementationOnce(() => new Promise<void>((resolve) => (finish = resolve)))
    land([item()])
    expect(runSyncOnce).toHaveBeenCalledTimes(1)
    land([item({ latest: { revision_number: 3 } })])
    scope.active = 'p-other'
    finish()
    await settle()
    expect(runSyncOnce).toHaveBeenCalledTimes(1)
  })
})
