/**
 * A cloud agent's quick install and uninstall bring main's cached catalog
 * listing up to date before they answer: every surface reads its installs
 * from that listing, so a stale one offered Get on a bundle just installed.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'

const cinnaFetch = vi.hoisted(() => vi.fn<(...args: unknown[]) => Promise<unknown>>())
const publishEvent = vi.hoisted(() => vi.fn())

vi.mock('../logger/logger', () => ({
  createLogger: () => ({ debug: () => {}, info: () => {}, warn: () => {}, error: () => {} })
}))
vi.mock('./cinna-http', () => ({ cinnaFetch, resolveBaseUrl: () => 'https://core.test' }))
vi.mock('../host/events', () => ({ publishEvent }))
vi.mock('../db/users', () => ({
  userRepo: {
    get: () => ({ type: 'cinna_user', cinnaServerUrl: 'https://core.test/' }),
    list: () => []
  }
}))
vi.mock('./libraryTrust', () => ({ libraryTrust: { learn: () => null } }))
vi.mock('../auth/cinna-oauth', () => ({ CinnaReauthRequired: class extends Error {} }))

const { catalogService } = await import('./catalogService')
const { libraryService } = await import('./libraryService')

const PROFILE = 'p-cinna'

function cloudItem(installIds: string[]): Record<string, unknown> {
  return {
    kind: 'agent',
    runs_on: 'cloud',
    uuid: 'u-cloud',
    id: 'test.core.cloud1',
    name: 'Invoices',
    display_name: 'Invoices',
    description: null,
    publisher: null,
    maintainers: [],
    access: 'use',
    visibility: 'public',
    is_listed: true,
    latest: { revision_number: 1, version: null, published_at: null, published_by: null, release_notes: null },
    install_count: installIds.length,
    my_installs: installIds.map((id) => ({ where: 'cloud', install_id: id, revision_number: 1 })),
    required_credential_specs: [],
    skills: [],
    desktop: null,
    skill: null
  }
}

/** The server: the listing names whatever is installed at the time it is read. */
let installed: string[] = []

beforeEach(() => {
  libraryService._reset()
  publishEvent.mockReset()
  installed = []
  cinnaFetch.mockReset()
  cinnaFetch.mockImplementation(async (_user, path, init) => {
    const method = (init as { method?: string } | undefined)?.method ?? 'GET'
    if (path === '/api/v1/catalog/items') return { data: [cloudItem(installed)] }
    if (String(path).endsWith('/install-context')) return { service_specs: [] }
    if (method === 'POST' && String(path).endsWith('/install')) {
      installed = ['inst-1']
      return { id: 'inst-1', name: 'Invoices' }
    }
    if (method === 'POST' && String(path).endsWith('/uninstall')) {
      installed = []
      return { status: 'uninstalled' }
    }
    throw new Error(`unexpected ${method} ${String(path)}`)
  })
})

const cachedInstalls = async (): Promise<unknown[]> =>
  ((await libraryService.items(PROFILE, false))?.items[0]?.my_installs ?? []) as unknown[]

describe('catalogService refreshes the cached listing', () => {
  it('after a quick install, so the cached listing names the new install', async () => {
    expect(await cachedInstalls()).toEqual([])
    await catalogService.quickInstall(PROFILE, 'test.core.cloud1')
    expect(await cachedInstalls()).toMatchObject([{ install_id: 'inst-1' }])
    expect(publishEvent).toHaveBeenCalledWith('catalog:items-changed')
  })

  it('after an uninstall, so the cached listing stops naming it', async () => {
    installed = ['inst-1']
    expect(await cachedInstalls()).toHaveLength(1)
    publishEvent.mockReset()
    await catalogService.uninstall(PROFILE, 'inst-1')
    expect(await cachedInstalls()).toEqual([])
    expect(publishEvent).toHaveBeenCalledWith('catalog:items-changed')
  })

  it('not after a failed uninstall', async () => {
    installed = ['inst-1']
    await cachedInstalls()
    const calls = cinnaFetch.mock.calls.length
    cinnaFetch.mockRejectedValueOnce(new Error('refused'))
    await expect(catalogService.uninstall(PROFILE, 'inst-1')).rejects.toThrow('refused')
    expect(cinnaFetch.mock.calls.length).toBe(calls + 1)
  })

  it('answers an install whose listing hangs after a bounded wait', async () => {
    vi.useFakeTimers()
    try {
      const listing = vi.fn(() => new Promise<never>(() => {}))
      cinnaFetch.mockImplementation(async (_user, path, init) => {
        const method = (init as { method?: string } | undefined)?.method ?? 'GET'
        if (path === '/api/v1/catalog/items') return listing()
        if (String(path).endsWith('/install-context')) return { service_specs: [] }
        if (method === 'POST' && String(path).endsWith('/install')) return { id: 'inst-1', name: 'Invoices' }
        throw new Error(`unexpected ${method} ${String(path)}`)
      })
      const answer = catalogService.quickInstall(PROFILE, 'test.core.cloud1')
      await vi.advanceTimersByTimeAsync(5_000)
      await expect(answer).resolves.toMatchObject({ installId: 'inst-1' })
      expect(listing).toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })
})
