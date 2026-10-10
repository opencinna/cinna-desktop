/**
 * Local installs reported to the catalog: the per-install device id, the
 * install report and the removal report Remove from this computer sends. The
 * verbs that send them are proved in `sharingService.test.ts`.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const cinnaFetch = vi.hoisted(() => vi.fn<(...args: unknown[]) => Promise<unknown>>())
const cached = vi.hoisted(() => ({ listing: null as { agents: Array<{ uuid: string; repoId: string }> } | null }))
const warned = vi.hoisted(() => ({ messages: [] as string[] }))

vi.mock('../host/runtimeHost', () => ({
  runtimeHost: {
    getPath: () => {
      throw new Error('no userData on this host')
    }
  }
}))
vi.mock('../logger/logger', () => ({
  createLogger: () => ({
    debug: () => {},
    info: () => {},
    warn: (message: string) => warned.messages.push(message),
    error: () => {}
  })
}))
vi.mock('./cinna-http', () => ({ cinnaFetch }))
vi.mock('./libraryService', () => ({
  catalogItemPath: (uuid: string) => `/api/v1/catalog/items/${encodeURIComponent(uuid)}`,
  libraryService: { cached: () => cached.listing }
}))

const { catalogLocalInstalls } = await import('./catalogLocalInstalls')
const { CinnaApiError } = await import('../errors')

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'cinna-device-'))
  catalogLocalInstalls._reset(join(dir, 'catalog-device.json'))
  cinnaFetch.mockReset()
  cached.listing = null
  warned.messages = []
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('the device id', () => {
  it('is minted once, saved under userData, and the same after a restart', () => {
    const id = catalogLocalInstalls.deviceId()
    expect(id).toMatch(/^[0-9a-f-]{36}$/)
    expect(JSON.parse(readFileSync(join(dir, 'catalog-device.json'), 'utf8'))).toEqual({ deviceId: id })
    expect(catalogLocalInstalls.deviceId()).toBe(id)
    catalogLocalInstalls._reset(join(dir, 'catalog-device.json'))
    expect(catalogLocalInstalls.deviceId()).toBe(id)
  })

  it('replaces an unreadable file with a fresh id', () => {
    writeFileSync(join(dir, 'catalog-device.json'), 'not json')
    const id = catalogLocalInstalls.deviceId()
    expect(id).toMatch(/^[0-9a-f-]{36}$/)
    expect(JSON.parse(readFileSync(join(dir, 'catalog-device.json'), 'utf8'))).toEqual({ deviceId: id })
  })

  it('stays in memory for the run on a host with no userData', () => {
    catalogLocalInstalls._reset(null)
    const id = catalogLocalInstalls.deviceId()
    expect(catalogLocalInstalls.deviceId()).toBe(id)
  })
})

describe('Remove from this computer', () => {
  it('deletes this device’s row for the listed team agent the folder was shared from', async () => {
    cached.listing = { agents: [{ uuid: 'item-1', repoId: 'r1' }] }
    cinnaFetch.mockRejectedValue(new CinnaApiError('invalid_response', 'no body'))
    await catalogLocalInstalls.reportRemovedByOrigin('p1', 'https://api.cinna.test/git/r1.git')
    expect(cinnaFetch).toHaveBeenCalledWith(
      'p1',
      `/api/v1/catalog/items/item-1/local-installs/${catalogLocalInstalls.deviceId()}`,
      { method: 'DELETE' }
    )
    // A 204 has no JSON body; that is the removal done, not a failure.
    expect(warned.messages).toEqual([])
  })

  it('reports nothing for a folder whose team agent is not listed, or that is not a catalog one', async () => {
    cached.listing = { agents: [{ uuid: 'item-1', repoId: 'r1' }] }
    await catalogLocalInstalls.reportRemovedByOrigin('p1', 'https://api.cinna.test/git/r2.git')
    await catalogLocalInstalls.reportRemovedByOrigin('p1', 'https://github.com/acme/alpha.git')
    await catalogLocalInstalls.reportRemovedByOrigin('p1', '/tmp/team.git')
    expect(cinnaFetch).not.toHaveBeenCalled()
  })

  it('logs a failed report and never throws', async () => {
    cached.listing = { agents: [{ uuid: 'item-1', repoId: 'r1' }] }
    cinnaFetch.mockRejectedValue(new CinnaApiError('request_failed', 'Cinna API 500', 'Server Error', 500))
    await expect(catalogLocalInstalls.reportRemovedByOrigin('p1', 'https://api.cinna.test/git/r1.git')).resolves.toBeUndefined()
    expect(warned.messages).toEqual(['local removal could not be reported'])
  })
})

describe('Get, Update, Share changes: reportInstalled', () => {
  const HEAD = 'a'.repeat(40)
  const entry = (over: Partial<{ headSha: string; latest: { number: number } | null }> = {}) =>
    ({
      uuid: 'item-1',
      headSha: HEAD,
      latest: { number: 4, label: null, publishedAt: '', publishedBy: null, releaseNotes: null },
      ...over
    }) as unknown as Parameters<typeof catalogLocalInstalls.reportInstalled>[1]
  const post = (revision: number): unknown[] => [
    'p1',
    '/api/v1/catalog/items/item-1/local-installs',
    { method: 'POST', body: { device_id: catalogLocalInstalls.deviceId(), revision_number: revision } }
  ]

  it('posts the latest version when the folder is at the listing’s head, with no lookup', async () => {
    cinnaFetch.mockResolvedValue({})
    await catalogLocalInstalls.reportInstalled('p1', entry(), HEAD)
    expect(cinnaFetch.mock.calls).toEqual([post(4)])
  })

  it('looks the version up by its commit when the folder is at an older one', async () => {
    const older = 'c'.repeat(40)
    cinnaFetch.mockImplementation(async (...args: unknown[]) =>
      args[1] === '/api/v1/catalog/items/item-1'
        ? { revisions: [{ revision_number: 4, git_commit_sha: HEAD }, { revision_number: 3, git_commit_sha: older }] }
        : {}
    )
    await catalogLocalInstalls.reportInstalled('p1', entry(), older)
    expect(cinnaFetch.mock.calls).toEqual([['p1', '/api/v1/catalog/items/item-1'], post(3)])
  })

  it('looks it up too when the listing has no head yet', async () => {
    cinnaFetch.mockImplementation(async (...args: unknown[]) =>
      args[1] === '/api/v1/catalog/items/item-1' ? { revisions: [{ revision_number: 1, git_commit_sha: HEAD }] } : {}
    )
    await catalogLocalInstalls.reportInstalled('p1', entry({ headSha: '', latest: null }), HEAD)
    expect(cinnaFetch.mock.calls.at(-1)).toEqual(post(1))
  })

  it('posts nothing when the version cannot be told', async () => {
    cinnaFetch.mockResolvedValue({ revisions: [{ revision_number: 4, git_commit_sha: HEAD }] })
    await catalogLocalInstalls.reportInstalled('p1', entry(), 'd'.repeat(40))
    await catalogLocalInstalls.reportInstalled('p1', entry(), null)
    expect(cinnaFetch.mock.calls).toEqual([['p1', '/api/v1/catalog/items/item-1']])
    expect(warned.messages).toEqual([])
  })

  it('logs a failed post and never throws', async () => {
    cinnaFetch.mockRejectedValue(new CinnaApiError('request_failed', 'Cinna API 500', 'Server Error', 500))
    await expect(catalogLocalInstalls.reportInstalled('p1', entry(), HEAD)).resolves.toBeUndefined()
    expect(warned.messages).toEqual(['local install could not be reported'])
  })
})
