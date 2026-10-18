import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { LocalAgentSkill } from '../../shared/localAgents'

/**
 * Pinned skills not on this computer are fetched in the background without a
 * click: once per pin until a profile becomes ready again (so a failing pin is
 * not retried every turn; the profile-ready sweep retries failed ones), never without a Cinna account (and then not marked tried), and
 * through each kind's own `ensurePinnedInBackground`.
 */

const account = vi.hoisted(() => ({ host: 'https://cinna.test' as string | null }))
const catalogEnsure = vi.hoisted(() => vi.fn())
const marketplaceEnsure = vi.hoisted(() => vi.fn())
const scans = vi.hoisted(() => ({ agents: [] as { id: string; skills?: unknown[] }[] }))

vi.mock('../auth/scope', () => ({ getProfileScopeUserId: () => 'profile', getSettingsScopeUserId: () => '__default__' }))
vi.mock('../logger/logger', () => ({ createLogger: () => ({ debug: () => {}, info: () => {}, warn: () => {}, error: () => {} }) }))
vi.mock('./libraryService', () => ({ libraryService: { hostOf: () => account.host } }))
vi.mock('./catalogSkillService', () => ({ catalogSkillService: { ensurePinnedInBackground: catalogEnsure } }))
vi.mock('./marketplaceSkillService', () => ({ marketplaceSkillService: { ensurePinnedInBackground: marketplaceEnsure } }))
vi.mock('../db/agentRoots', () => ({ agentRootRepo: { list: () => [{ id: 'root-1' }] } }))
vi.mock('./localAgents/scannerService', () => ({ scannerService: { scanRootCached: () => ({ agents: scans.agents }) } }))

const { pinnedSkillAutoFetch } = await import('./pinnedSkillAutoFetch')

const NOT_HERE = [{ code: 'not_downloaded', message: 'Not on this computer yet.', severity: 'warning' as const }]
const catalogPin = (extra: Partial<LocalAgentSkill> = {}): LocalAgentSkill => ({
  name: 'erp-lookup', description: '', version: null, source: 'catalog', path: '', deliverable: false, issues: NOT_HERE,
  credentials: [], packageUuid: 'u-1', revisionNumber: 2, ...extra
})
const marketplacePin = (extra: Partial<LocalAgentSkill> = {}): LocalAgentSkill => ({
  name: 'pdf-report', description: '', version: null, source: 'marketplace', path: '', deliverable: false, issues: NOT_HERE,
  credentials: [], entryUuid: 'e-1', archiveSha256: 'a'.repeat(64), ...extra
})
const authored: LocalAgentSkill = { name: 'own', description: 'x', version: null, source: 'authored', path: 'skills/own/SKILL.md', deliverable: true, issues: [], credentials: [] }

beforeEach(() => {
  account.host = 'https://cinna.test'
  catalogEnsure.mockReset()
  marketplaceEnsure.mockReset()
  scans.agents = []
  pinnedSkillAutoFetch._reset()
})

describe('pinnedSkillAutoFetch', () => {
  it('starts each kind’s background fetch for its missing pins, once per pin per session', async () => {
    expect(pinnedSkillAutoFetch.fetchMissing('folder:a', [authored, catalogPin(), marketplacePin()])).toEqual({ catalog: true, marketplace: true })
    await vi.waitFor(() => expect(catalogEnsure).toHaveBeenCalledWith('__default__', 'folder:a'))
    await vi.waitFor(() => expect(marketplaceEnsure).toHaveBeenCalledWith('__default__', 'folder:a'))
    // The next turn finds the same pins still missing (the download failed, say): nothing again.
    expect(pinnedSkillAutoFetch.fetchMissing('folder:a', [catalogPin(), marketplacePin()])).toEqual({ catalog: false, marketplace: false })
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(catalogEnsure).toHaveBeenCalledTimes(1)
    expect(marketplaceEnsure).toHaveBeenCalledTimes(1)
    // A new digest is a new pin; so is the same pin on another agent.
    expect(pinnedSkillAutoFetch.fetchMissing('folder:a', [marketplacePin({ archiveSha256: 'b'.repeat(64) })]).marketplace).toBe(true)
    expect(pinnedSkillAutoFetch.fetchMissing('folder:b', [catalogPin()]).catalog).toBe(true)
  })

  it('leaves a pin whose download already failed, an own skill and a cached pin alone', () => {
    const failed = [{ code: 'download_failed', message: 'It could not be downloaded.', severity: 'warning' as const }]
    expect(pinnedSkillAutoFetch.fetchMissing('folder:a', [authored, catalogPin({ issues: failed }), marketplacePin({ issues: [], deliverable: true })]))
      .toEqual({ catalog: false, marketplace: false })
    expect(pinnedSkillAutoFetch.fetchMissing('folder:a', undefined)).toEqual({ catalog: false, marketplace: false })
  })

  it('tries nothing without a Cinna account, and does not count that as the session’s attempt', async () => {
    account.host = null
    expect(pinnedSkillAutoFetch.fetchMissing('folder:a', [catalogPin()])).toEqual({ catalog: false, marketplace: false })
    account.host = 'https://cinna.test'
    expect(pinnedSkillAutoFetch.fetchMissing('folder:a', [catalogPin()]).catalog).toBe(true)
    await vi.waitFor(() => expect(catalogEnsure).toHaveBeenCalledTimes(1))
  })

  it('when a profile becomes ready, retries a pin already tried and one whose download failed; a turn still does not', async () => {
    const failed = [{ code: 'download_failed', message: 'Sign in to Cinna again to download this skill.', severity: 'warning' as const }]
    // Tried this session (not downloaded), and its download then failed for a lapsed sign-in.
    expect(pinnedSkillAutoFetch.fetchMissing('folder:a', [catalogPin()]).catalog).toBe(true)
    await vi.waitFor(() => expect(catalogEnsure).toHaveBeenCalledTimes(1))
    // A turn asks again: the failed row is left alone, the guard holds.
    expect(pinnedSkillAutoFetch.fetchMissing('folder:a', [catalogPin({ issues: failed })]).catalog).toBe(false)
    expect(pinnedSkillAutoFetch.fetchMissing('folder:a', [catalogPin()]).catalog).toBe(false)

    scans.agents = [{ id: 'folder:a', skills: [catalogPin({ issues: failed })] }, { id: 'folder:b', skills: [marketplacePin({ issues: failed })] }]
    pinnedSkillAutoFetch.retryAllMissing()
    await vi.waitFor(() => expect(catalogEnsure).toHaveBeenCalledTimes(2))
    await vi.waitFor(() => expect(marketplaceEnsure).toHaveBeenCalledWith('__default__', 'folder:b'))
    // That sweep marked them tried again: the next turn does not ask.
    expect(pinnedSkillAutoFetch.fetchMissing('folder:a', [catalogPin()]).catalog).toBe(false)
    // The plain start sweep does not retry a failed pin.
    pinnedSkillAutoFetch._reset()
    pinnedSkillAutoFetch.fetchAllMissing()
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(catalogEnsure).toHaveBeenCalledTimes(2)
    expect(marketplaceEnsure).toHaveBeenCalledTimes(1)
  })

  it('at start, fetches for every scanned kit agent with missing pins, and nothing without an account', async () => {
    scans.agents = [{ id: 'folder:a', skills: [catalogPin()] }, { id: 'folder:bare' }, { id: 'folder:b', skills: [marketplacePin()] }]
    account.host = null
    pinnedSkillAutoFetch.fetchAllMissing()
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(catalogEnsure).not.toHaveBeenCalled()
    account.host = 'https://cinna.test'
    pinnedSkillAutoFetch.fetchAllMissing()
    await vi.waitFor(() => expect(catalogEnsure).toHaveBeenCalledWith('__default__', 'folder:a'))
    await vi.waitFor(() => expect(marketplaceEnsure).toHaveBeenCalledWith('__default__', 'folder:b'))
  })
})
