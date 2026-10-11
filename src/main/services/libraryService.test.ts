/**
 * The catalog listing as the one-catalog dialog reads it: every kind from the
 * one cached `GET /catalog/items`, an item's versions from its detail route,
 * `sharing:changed` when a desktop agent moved, and the lighter
 * `catalog:items-changed` when any other item the dialog shows moved. The team-sharing reads of the same cache are proved in
 * `sharingService.test.ts`.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'

const cinnaFetch = vi.hoisted(() => vi.fn<(...args: unknown[]) => Promise<unknown>>())
const publishEvent = vi.hoisted(() => vi.fn())
const users = vi.hoisted(
  () => new Map<string, { type: string; cinnaServerUrl: string | null }>()
)

vi.mock('../logger/logger', () => ({
  createLogger: () => ({ debug: () => {}, info: () => {}, warn: () => {}, error: () => {} })
}))
vi.mock('./cinna-http', () => ({ cinnaFetch }))
vi.mock('../host/events', () => ({ publishEvent }))
vi.mock('../db/users', () => ({
  userRepo: { get: (id: string) => users.get(id), list: () => [...users.values()] }
}))
vi.mock('./libraryTrust', () => ({ libraryTrust: { learn: () => null } }))
vi.mock('../auth/cinna-oauth', () => ({ CinnaReauthRequired: class extends Error {} }))

const { libraryService } = await import('./libraryService')
const { CinnaApiError } = await import('../errors')

const PROFILE = 'p-cinna'

function item(overrides: Record<string, unknown> = {}): Record<string, unknown> {
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
    latest: { revision_number: 2, version: null, published_at: '2026-10-01T00:00:00Z', published_by: null, release_notes: null },
    install_count: 0,
    my_installs: [],
    required_credential_specs: [],
    skills: [],
    desktop: null,
    skill: null,
    ...overrides
  }
}

const SKILL = item({ kind: 'skill', runs_on: null, uuid: 'u-skill', id: 'test.core.skill.erp', name: 'erp-lookup' })
const DESKTOP = item({
  runs_on: 'desktop',
  uuid: 'u-desk',
  id: 'test.core.desk1',
  name: 'payroll',
  desktop: { repo_id: 'r1', clone_url: 'https://core.test/git/r1.git', default_branch: 'main', head_sha: 'a', manifest_id: 'm1', slug: 'payroll', engine: null, contract_version: null }
})

beforeEach(() => {
  libraryService._reset()
  cinnaFetch.mockReset()
  publishEvent.mockReset()
  users.clear()
  users.set(PROFILE, { type: 'cinna_user', cinnaServerUrl: 'https://core.test/' })
  users.set('p-local', { type: 'local_user', cinnaServerUrl: null })
})

describe('libraryService.items', () => {
  it('answers every kind from the one cached listing, and lists again only when asked', async () => {
    cinnaFetch.mockResolvedValue({ data: [item(), SKILL, { kind: 'plugin', uuid: 'x', id: 'y' }] })
    const first = await libraryService.items(PROFILE, false)
    expect(first?.items.map((i) => i.uuid)).toEqual(['u-cloud', 'u-skill'])
    expect(first).toMatchObject({ host: 'https://core.test', available: true })
    expect(cinnaFetch).toHaveBeenCalledTimes(1)

    await libraryService.items(PROFILE, false)
    expect(cinnaFetch).toHaveBeenCalledTimes(1)

    await libraryService.items(PROFILE, true)
    expect(cinnaFetch).toHaveBeenCalledTimes(2)
    expect(cinnaFetch).toHaveBeenLastCalledWith(PROFILE, '/api/v1/catalog/items')
  })

  it('is null for a profile that is not a Cinna one', async () => {
    expect(await libraryService.items('p-local', true)).toBeNull()
    expect(cinnaFetch).not.toHaveBeenCalled()
  })

  it('says the listing is unavailable on an instance without the catalog routes', async () => {
    cinnaFetch.mockRejectedValue(new CinnaApiError('request_failed', 'Not Found', undefined, 404))
    expect(await libraryService.items(PROFILE, true)).toMatchObject({ items: [], available: false })
  })

  it('tells the catalog, not team sharing, when a cloud agent or a skill moved', async () => {
    cinnaFetch.mockResolvedValue({ data: [item(), SKILL] })
    await libraryService.refresh(PROFILE)
    publishEvent.mockReset()

    // The same answer again: nothing to tell.
    await libraryService.refresh(PROFILE)
    expect(publishEvent).not.toHaveBeenCalled()

    // The caller installed the cloud agent.
    const installed = item({ my_installs: [{ where: 'cloud', install_id: 'i1', device_id: null, host_manifest_id: null, revision_number: 2 }] })
    cinnaFetch.mockResolvedValue({ data: [installed, SKILL] })
    await libraryService.refresh(PROFILE)
    expect(publishEvent.mock.calls).toEqual([['catalog:items-changed']])

    // A skill's new version.
    publishEvent.mockReset()
    cinnaFetch.mockResolvedValue({
      data: [
        installed,
        { ...SKILL, latest: { revision_number: 3, version: '1.1.0', published_at: '2026-10-02T00:00:00Z', published_by: null, release_notes: null } }
      ]
    })
    await libraryService.refresh(PROFILE)
    expect(publishEvent.mock.calls).toEqual([['catalog:items-changed']])
  })

  it('tells its listing listeners only when an item moved', async () => {
    const heard: string[] = []
    const off = libraryService.onListingChanged((userId, listing) => heard.push(`${userId}:${listing.items[0]?.latest?.revision_number}`))
    try {
      cinnaFetch.mockResolvedValue({ data: [item()] })
      await libraryService.refresh(PROFILE)
      await libraryService.refresh(PROFILE)
      cinnaFetch.mockResolvedValue({ data: [item({ install_count: 7 })] })
      await libraryService.refresh(PROFILE)
      cinnaFetch.mockResolvedValue({
        data: [item({ latest: { revision_number: 3, version: null, published_at: null, published_by: null, release_notes: null } })]
      })
      await libraryService.refresh(PROFILE)
      expect(heard).toEqual([`${PROFILE}:2`, `${PROFILE}:3`])
    } finally {
      off()
    }
  })

  it('says nothing when only how many people use an item moved', async () => {
    cinnaFetch.mockResolvedValue({ data: [item(), SKILL, DESKTOP] })
    await libraryService.refresh(PROFILE)
    publishEvent.mockReset()
    cinnaFetch.mockResolvedValue({
      data: [item({ install_count: 5 }), { ...SKILL, install_count: 9 }, { ...DESKTOP, install_count: 3 }]
    })
    await libraryService.refresh(PROFILE)
    expect(publishEvent).not.toHaveBeenCalled()
  })

  it('tells team sharing, once, when a desktop agent moved', async () => {
    cinnaFetch.mockResolvedValue({ data: [item(), DESKTOP] })
    await libraryService.refresh(PROFILE)
    publishEvent.mockReset()
    // A new head, and the cloud agent installed in the same answer: one event,
    // the one that re-reads the catalog's items as well.
    cinnaFetch.mockResolvedValue({
      data: [
        item({ my_installs: [{ where: 'cloud', install_id: 'i1', device_id: null, host_manifest_id: null, revision_number: 2 }] }),
        { ...DESKTOP, desktop: { ...(DESKTOP.desktop as Record<string, unknown>), head_sha: 'b' } }
      ]
    })
    await libraryService.refresh(PROFILE)
    expect(publishEvent.mock.calls).toEqual([['sharing:changed']])
  })
})

describe('libraryService.itemDetail', () => {
  it('reads one item with its versions newest first, by uuid', async () => {
    cinnaFetch.mockResolvedValue({
      ...item({ uuid: 'u/1' }),
      revisions: [
        { revision_number: 1, version: null, published_at: '2026-09-01T00:00:00Z', published_by: null, release_notes: 'First.', origin: 'publish' },
        { revision_number: 3, version: '1.2.0', published_at: '2026-10-03T00:00:00Z', published_by: { user_id: 'a', display_name: 'Anna' }, release_notes: null, origin: 'publish' },
        { version: 'broken' },
        { revision_number: 2, version: null, published_at: '2026-09-15T00:00:00Z', published_by: null, release_notes: null, origin: 'publish' }
      ]
    })
    const detail = await libraryService.itemDetail(PROFILE, 'u/1')
    expect(cinnaFetch).toHaveBeenCalledWith(PROFILE, '/api/v1/catalog/items/u%2F1')
    expect(detail.uuid).toBe('u/1')
    expect(detail.revisions.map((r) => r.revision_number)).toEqual([3, 2, 1])
  })

  it('has no versions when core sends none', async () => {
    cinnaFetch.mockResolvedValue(item())
    expect((await libraryService.itemDetail(PROFILE, 'u-cloud')).revisions).toEqual([])
  })

  it('refuses an empty id, a profile without a catalog, and an answer that is not an item', async () => {
    await expect(libraryService.itemDetail(PROFILE, ' ')).rejects.toMatchObject({ code: 'invalid_id' })
    await expect(libraryService.itemDetail('p-local', 'u-cloud')).rejects.toMatchObject({ code: 'not_a_cinna_profile' })
    cinnaFetch.mockResolvedValue({ detail: 'nope' })
    await expect(libraryService.itemDetail(PROFILE, 'u-cloud')).rejects.toMatchObject({ code: 'invalid_response' })
    expect(cinnaFetch).toHaveBeenCalledTimes(1)
  })

  it('lets a refusal from core through, so the dialog can say it in the detail', async () => {
    cinnaFetch.mockRejectedValue(new CinnaApiError('request_failed', 'Not Found', undefined, 404))
    await expect(libraryService.itemDetail(PROFILE, 'u-cloud')).rejects.toMatchObject({ status: 404 })
  })
})
