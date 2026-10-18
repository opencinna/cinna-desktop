import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { sha256Of, skillTgz, tgzOf } from '../kit/testSupport/skillTar'
import { SERVICE_CREDENTIALS_CHANGED } from '../../shared/serviceCredentials'

/**
 * Marketplace skills in local agents: discover, add, update, remove, fetch
 * what is pinned, and status — over a real agent folder, a real manifest and a
 * real cache, with only the network, the agent index, the git origin and the
 * catalog listing (for U9's read-only rule) faked. What is proved is what the
 * service decides: the refusals as data, the two digest checks, the pin it
 * writes, the status mapping, and the cache's layout, marker and clean-up.
 */

const PROFILE = 'profile-cinna'
const HOST = 'https://cinna.test'
const USER = '__default__'
const AGENT_ID = 'folder:11111111-2222-4333-8444-555566667777'
const MANIFEST_ID = '11111111-2222-4333-8444-555566667777'
const ENTRY = '3c9a7e21-5b4d-4f60-8e12-7a9b0c1d2e3f'
const MARKETPLACE = '8d2f4a6b-1c3e-4a5b-9c7d-0e1f2a3b4c5d'

const host = vi.hoisted(() => ({ userData: '', signedIn: true }))
const cinnaFetch = vi.hoisted(() => vi.fn<(...args: unknown[]) => Promise<unknown>>())
const cinnaFetchBytes = vi.hoisted(() => vi.fn<(...args: unknown[]) => Promise<unknown>>())
const publishEvent = vi.hoisted(() => vi.fn())
const autoAttachSkills = vi.hoisted(() => vi.fn(async (_agentId: string): Promise<unknown[]> => []))
const detachUnusedAutoAttachments = vi.hoisted(() => vi.fn(async (_agentId: string): Promise<unknown[]> => []))
const located = vi.hoisted(() => ({ dir: '', kind: 'managed' as string, missing: false }))
const remote = vi.hoisted(() => ({ ownRepo: false, originUrl: null as string | null, cinnaServer: null as string | null }))
const listing = vi.hoisted(() => ({ value: null as null | { items: unknown[]; agents: unknown[] } }))
const registry = vi.hoisted(() => ({
  roots: [] as { id: string; path: string }[],
  rows: [] as { localPath: string | null }[],
  scans: {} as Record<string, { path: string; skills?: unknown[] }[]>
}))

vi.mock('../host/runtimeHost', () => ({ runtimeHost: { getPath: () => host.userData } }))
vi.mock('../logger/logger', () => ({
  createLogger: () => ({ debug: () => {}, info: () => {}, warn: () => {}, error: () => {} })
}))
vi.mock('../auth/scope', () => ({ getProfileScopeUserId: () => PROFILE, getSettingsScopeUserId: () => USER }))
vi.mock('../host/events', () => ({ publishEvent }))
vi.mock('./cinna-http', () => ({ cinnaFetch, cinnaFetchBytes }))
vi.mock('./libraryService', () => ({
  catalogItemPath: (uuid: string) => `/api/v1/catalog/items/${encodeURIComponent(uuid)}`,
  libraryService: {
    hostOf: (profile: string) => (profile === PROFILE && host.signedIn ? HOST : null),
    knownHosts: () => new Set([HOST]),
    cached: () => listing.value,
    refresh: async () => listing.value
  }
}))
vi.mock('./localAgents/localAgentService', async () => {
  const { LocalAgentError } = await import('../errors')
  return {
    localAgentService: {
      get: () => {
        if (located.missing) throw new LocalAgentError('not_found', 'gone')
        return { rootId: 'root-1', path: located.dir, ...(located.kind === 'external' ? {} : { skills: [] }) }
      }
    }
  }
})
vi.mock('./localAgents/scannerService', () => ({
  scannerService: {
    markAllRootsDirty: () => {},
    scanRootCached: (_user: string, scanned: { id: string }) => ({ agents: registry.scans[scanned.id] ?? [] })
  }
}))
vi.mock('./serviceCredentials/service', () => ({ serviceCredentialService: { autoAttachSkills, detachUnusedAutoAttachments } }))
vi.mock('../db/agents', () => ({ agentRepo: { listFolder: (user: string) => (user === USER ? registry.rows : []) } }))
vi.mock('../db/agentRoots', () => ({ agentRootRepo: { list: (user: string) => (user === USER ? registry.roots : []) } }))
vi.mock('./localAgents/gitService', () => ({
  gitService: { readShareRemote: async () => ({ ...remote, refusal: null }) }
}))

const { marketplaceSkillService, pinStatus, toEntry } = await import('./marketplaceSkillService')
const { marketplaceSkillCache, MARKETPLACE_NOT_AVAILABLE_SENTENCE } = await import('./marketplaceSkillCache')
const { catalogSkillCache, removeTree } = await import('./catalogSkillCache')
const { agentSkillRows, deliverableSkills } = await import('../kit/skills')
const { readSkillArchive } = await import('../kit/skillArchive')
const { CinnaApiError } = await import('../errors')
const { CinnaReauthRequired } = await import('../auth/cinna-oauth')

let root: string
let agentDir: string

/** An entry as core's `/discover` and batch lookup send it, its snapshot `archive`. */
function entry(archive: Buffer | null, over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: ENTRY,
    marketplace_id: MARKETPLACE,
    name: 'pdf-report',
    description: 'Builds PDF reports.',
    version: '0.3.1',
    commit_hash: 'abc123',
    plugin_type: 'skills',
    supported: true,
    unsupported_reason: null,
    skill_archive_sha256: archive ? sha256Of(archive) : null,
    skill_archive_size: archive ? archive.length : null,
    skill_summary: { name: 'pdf-report', description: 'Builds PDF reports.', has_scripts: true },
    marketplace_name: 'Team skills',
    marketplace_owner: 'Ada',
    repository_url: 'https://github.com/example/skills',
    ...over
  }
}

/** The batch lookup answers `visible`; an archive request answers from `archives` by digest. */
function serve(visible: Record<string, unknown>[], archives: Buffer[], header: (bytes: Buffer) => string = sha256Of): void {
  cinnaFetch.mockImplementation(async (...args: unknown[]) => {
    const path = args[1] as string
    if (path.startsWith('/api/v1/llm-plugins/plugins?ids=')) {
      const ids = decodeURIComponent(path.split('ids=')[1]).split(',')
      const data = visible.filter((row) => ids.includes(String(row.id)))
      return { data, count: data.length }
    }
    throw new Error(`unexpected ${path}`)
  })
  cinnaFetchBytes.mockImplementation(async (...args: unknown[]) => {
    const path = args[1] as string
    const sha = path.match(/sha256=([0-9a-f]{64})/)?.[1]
    const bytes = archives.find((archive) => sha256Of(archive) === sha)
    if (!bytes) throw new CinnaApiError('request_failed', 'Cinna API 404', '{"detail":{"code":"snapshot_missing"}}', 404)
    return { ok: true, bytes, headers: new Headers({ 'X-Archive-Sha256': header(bytes) }) }
  })
}

function writeManifest(extra: Record<string, unknown> = {}): void {
  writeFileSync(join(agentDir, 'cinna-agent.json'), `${JSON.stringify({ id: MANIFEST_ID, slug: 'invoices', name: 'Invoices', ...extra }, null, 2)}\n`)
}

const manifest = (): Record<string, unknown> => JSON.parse(readFileSync(join(agentDir, 'cinna-agent.json'), 'utf8'))
const cacheRoot = (): string => join(host.userData, 'marketplace-skills')
const snapshotDir = (archive: Buffer): string => join(cacheRoot(), 'https-cinna.test', ENTRY, sha256Of(archive))
const pinOf = (archive: Buffer, over: Record<string, unknown> = {}) => ({
  entry_uuid: ENTRY,
  marketplace_uuid: MARKETPLACE,
  marketplace_name: 'Team skills',
  name: 'pdf-report',
  archive_sha256: sha256Of(archive),
  commit_hash: 'abc123',
  version: '0.3.1',
  ...over
})

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'cinna-marketplace-skills-'))
  host.userData = join(root, 'userData')
  host.signedIn = true
  agentDir = join(root, 'Local', 'invoices')
  mkdirSync(agentDir, { recursive: true })
  writeManifest()
  located.dir = agentDir
  located.kind = 'managed'
  located.missing = false
  remote.ownRepo = false
  remote.originUrl = null
  remote.cinnaServer = null
  listing.value = { items: [], agents: [] }
  registry.roots = []
  registry.rows = []
  registry.scans = {}
  cinnaFetch.mockReset()
  cinnaFetchBytes.mockReset()
  publishEvent.mockClear()
  autoAttachSkills.mockClear()
  detachUnusedAutoAttachments.mockClear()
  marketplaceSkillCache._reset()
  catalogSkillCache._reset()
  marketplaceSkillService._reset()
})

afterEach(() => {
  removeTree(root)
})

describe('discover', () => {
  it('reads every page of the skills-format entries and maps each one', async () => {
    const page = (skip: number, n: number) => Array.from({ length: n }, (_, i) => entry(null, { id: `00000000-0000-4000-8000-${String(skip + i).padStart(12, '0')}` }))
    cinnaFetch.mockImplementation(async (...args: unknown[]) => {
      const path = args[1] as string
      const skip = Number(path.match(/skip=(\d+)/)?.[1])
      return { data: page(skip, skip === 0 ? 100 : 20), count: 120 }
    })
    const result = await marketplaceSkillService.discover()
    expect(cinnaFetch.mock.calls.map((call) => call[1])).toEqual([
      '/api/v1/llm-plugins/discover?plugin_type=skills&skip=0&limit=100',
      '/api/v1/llm-plugins/discover?plugin_type=skills&skip=100&limit=100'
    ])
    expect(result.ok && result.entries.length).toBe(120)
  })

  it('maps core’s entry fields, and an unsupported one keeps its reason with no digest', () => {
    const archive = skillTgz('pdf-report')
    expect(toEntry(entry(archive))).toEqual({
      entryUuid: ENTRY,
      name: 'pdf-report',
      description: 'Builds PDF reports.',
      marketplaceUuid: MARKETPLACE,
      marketplaceName: 'Team skills',
      marketplaceOwner: 'Ada',
      repositoryUrl: 'https://github.com/example/skills',
      supported: true,
      unsupportedReason: null,
      archiveSha256: sha256Of(archive),
      archiveSize: archive.length,
      hasScripts: true,
      commitHash: 'abc123',
      version: '0.3.1'
    })
    expect(toEntry(entry(null, { supported: false, unsupported_reason: 'too_large', version: '' }))).toMatchObject({
      supported: false,
      unsupportedReason: 'too_large',
      archiveSha256: null,
      version: null
    })
    expect(toEntry({ name: 'no id' })).toBeNull()
  })

  it('answers no_account, reauth_required and network as data', async () => {
    host.signedIn = false
    expect(await marketplaceSkillService.discover()).toMatchObject({ ok: false, code: 'no_account' })
    host.signedIn = true
    cinnaFetch.mockRejectedValueOnce(new CinnaReauthRequired('expired'))
    expect(await marketplaceSkillService.discover()).toMatchObject({ ok: false, code: 'reauth_required' })
    cinnaFetch.mockRejectedValueOnce(new CinnaApiError('request_failed', 'socket hang up'))
    expect(await marketplaceSkillService.discover()).toMatchObject({ ok: false, code: 'network' })
  })
})

describe('Add to agent', () => {
  it('downloads by digest, checks both digests, caches read-only under the entry and digest, and writes the pin', async () => {
    const archive = skillTgz('pdf-report')
    serve([entry(archive)], [archive])
    expect(await marketplaceSkillService.addToAgent(USER, AGENT_ID, ENTRY)).toEqual({ ok: true, name: 'pdf-report', archiveSha256: sha256Of(archive) })
    expect(cinnaFetch.mock.calls[0][1]).toBe(`/api/v1/llm-plugins/plugins?ids=${ENTRY}`)
    expect(cinnaFetchBytes.mock.calls[0].slice(0, 2)).toEqual([PROFILE, `/api/v1/llm-plugins/plugins/${ENTRY}/skill-archive?sha256=${sha256Of(archive)}`])
    expect(manifest().marketplace_skills).toEqual([pinOf(archive)])
    expect(manifest().slug).toBe('invoices')

    // The layout and the marker; files read-only, the script executable.
    const skillDir = join(snapshotDir(archive), 'pdf-report')
    expect(JSON.parse(readFileSync(join(snapshotDir(archive), '.cinna-marketplace-skill.json'), 'utf8'))).toEqual({
      entry_uuid: ENTRY,
      name: 'pdf-report',
      archive_sha256: sha256Of(archive)
    })
    expect(statSync(join(skillDir, 'SKILL.md')).mode & 0o777).toBe(0o444)
    expect(statSync(join(skillDir, 'scripts', 'run.sh')).mode & 0o777).toBe(0o555)
    expect(statSync(skillDir).mode & 0o777).toBe(0o555)

    // It reaches the deliverable set, from the cache.
    const delivered = deliverableSkills(agentSkillRows(agentDir, manifest(), catalogSkillCache.resolve, marketplaceSkillCache.resolve))
    expect(delivered).toMatchObject([{ name: 'pdf-report', source: 'marketplace', entryUuid: ENTRY, marketplaceName: 'Team skills', path: join(skillDir, 'SKILL.md') }])
  })

  it('refuses a download whose bytes do not match the server’s header or the entry’s digest, keeping nothing', async () => {
    const archive = skillTgz('pdf-report')
    serve([entry(archive)], [archive], () => 'f'.repeat(64))
    expect(await marketplaceSkillService.addToAgent(USER, AGENT_ID, ENTRY)).toMatchObject({ ok: false, code: 'hash_mismatch' })
    expect(manifest().marketplace_skills).toBeUndefined()
    expect(existsSync(snapshotDir(archive))).toBe(false)

    // The entry names one digest, the server sends other bytes under it.
    const other = skillTgz('pdf-report', 'Something else.')
    serve([entry(archive)], [archive])
    cinnaFetchBytes.mockResolvedValueOnce({ ok: true, bytes: other, headers: new Headers({ 'X-Archive-Sha256': sha256Of(other) }) })
    expect(await marketplaceSkillService.addToAgent(USER, AGENT_ID, ENTRY)).toMatchObject({ ok: false, code: 'hash_mismatch' })
  })

  it('answers each refusal as data', async () => {
    const archive = skillTgz('pdf-report')
    serve([entry(archive)], [archive])

    host.signedIn = false
    expect(await marketplaceSkillService.addToAgent(USER, AGENT_ID, ENTRY)).toMatchObject({ ok: false, code: 'no_account' })
    host.signedIn = true

    located.missing = true
    expect(await marketplaceSkillService.addToAgent(USER, AGENT_ID, ENTRY)).toMatchObject({ ok: false, code: 'not_found' })
    located.missing = false
    located.kind = 'external'
    expect(await marketplaceSkillService.addToAgent(USER, AGENT_ID, ENTRY)).toMatchObject({
      ok: false,
      code: 'not_kit_agent',
      message: 'Only an agent with a cinna-agent.json can hold marketplace skills.'
    })
    located.kind = 'managed'

    // Not visible (absent from the batch lookup).
    expect(await marketplaceSkillService.addToAgent(USER, AGENT_ID, '00000000-0000-4000-8000-000000000000')).toMatchObject({ ok: false, code: 'not_found' })

    // Unsupported, or no snapshot.
    serve([entry(null, { supported: false, unsupported_reason: 'no_skill_md' })], [])
    expect(await marketplaceSkillService.addToAgent(USER, AGENT_ID, ENTRY)).toMatchObject({ ok: false, code: 'unsupported' })

    // Snapshot no longer kept.
    serve([entry(archive)], [])
    expect(await marketplaceSkillService.addToAgent(USER, AGENT_ID, ENTRY)).toMatchObject({ ok: false, code: 'snapshot_missing' })

    // 404 not_found on the archive: the entry went between the lookup and the download.
    serve([entry(archive)], [])
    cinnaFetchBytes.mockRejectedValueOnce(new CinnaApiError('request_failed', 'Cinna API 404', '{"detail":{"code":"not_found"}}', 404))
    expect(await marketplaceSkillService.addToAgent(USER, AGENT_ID, ENTRY)).toMatchObject({ ok: false, code: 'not_found' })

    // 409 not_a_skill.
    cinnaFetchBytes.mockRejectedValueOnce(new CinnaApiError('request_failed', 'Cinna API 409', '{"detail":{"code":"not_a_skill"}}', 409))
    expect(await marketplaceSkillService.addToAgent(USER, AGENT_ID, ENTRY)).toMatchObject({ ok: false, code: 'unsupported' })

    // Over the cap, and an unsafe archive.
    cinnaFetchBytes.mockResolvedValueOnce({ ok: false, reason: 'too_large' })
    expect(await marketplaceSkillService.addToAgent(USER, AGENT_ID, ENTRY)).toMatchObject({ ok: false, code: 'too_large' })
    const linked = tgzOf([
      { name: 'skills/pdf-report/SKILL.md', body: '---\nname: pdf-report\ndescription: x\n---\n' },
      { name: 'skills/pdf-report/evil', type: '2', linkname: '/etc/passwd' }
    ])
    serve([entry(linked)], [linked])
    expect(await marketplaceSkillService.addToAgent(USER, AGENT_ID, ENTRY)).toMatchObject({ ok: false, code: 'invalid_archive' })

    // An expired session on the lookup.
    cinnaFetch.mockRejectedValueOnce(new CinnaReauthRequired('expired'))
    expect(await marketplaceSkillService.addToAgent(USER, AGENT_ID, ENTRY)).toMatchObject({ ok: false, code: 'reauth_required' })
    cinnaFetch.mockRejectedValueOnce(new CinnaApiError('request_failed', 'socket hang up'))
    expect(await marketplaceSkillService.addToAgent(USER, AGENT_ID, ENTRY)).toMatchObject({ ok: false, code: 'network' })

    expect(manifest().marketplace_skills).toBeUndefined()
  })

  it('refuses a name already taken — own skill, catalog pin, platform skill — and an entry already pinned', async () => {
    const archive = skillTgz('pdf-report')
    serve([entry(archive)], [archive])
    writeManifest({ catalog_skills: [{ package_id: 'io.x.skill.pdf-report', package_uuid: '0b5c1f8e-6a43-4d7e-9a51-2f0c7d1e9b34', name: 'pdf-report', revision_number: 1, archive_sha256: 'a'.repeat(64) }] })
    expect(await marketplaceSkillService.addToAgent(USER, AGENT_ID, ENTRY)).toMatchObject({ ok: false, code: 'clash' })
    writeManifest()
    mkdirSync(join(agentDir, 'skills', 'pdf-report'), { recursive: true })
    expect(await marketplaceSkillService.addToAgent(USER, AGENT_ID, ENTRY)).toMatchObject({ ok: false, code: 'clash' })
    removeTree(join(agentDir, 'skills'))
    serve([entry(archive, { name: 'cinna-tasks', skill_summary: { name: 'cinna-tasks', description: '', has_scripts: false } })], [archive])
    expect(await marketplaceSkillService.addToAgent(USER, AGENT_ID, ENTRY)).toMatchObject({ ok: false, code: 'clash' })
    serve([entry(archive)], [archive])
    expect(await marketplaceSkillService.addToAgent(USER, AGENT_ID, ENTRY)).toMatchObject({ ok: true })
    expect(await marketplaceSkillService.addToAgent(USER, AGENT_ID, ENTRY)).toMatchObject({ ok: false, code: 'already_added' })
    expect(cinnaFetchBytes).toHaveBeenCalledTimes(1)
  })

  it('refuses a shared agent this person may only use, before any download', async () => {
    const archive = skillTgz('pdf-report')
    serve([entry(archive)], [archive])
    remote.ownRepo = true
    remote.originUrl = `${HOST}/git/r1.git`
    listing.value = { items: [], agents: [{ repoId: 'r1', bundleId: 'b', cloneUrl: `${HOST}/git/r1.git`, access: 'use' }] }
    expect(await marketplaceSkillService.addToAgent(USER, AGENT_ID, ENTRY)).toMatchObject({ ok: false, code: 'read_only' })
    expect(cinnaFetchBytes).not.toHaveBeenCalled()
    listing.value.agents = []
    expect(await marketplaceSkillService.addToAgent(USER, AGENT_ID, ENTRY)).toMatchObject({ ok: false, code: 'access_unknown' })
  })

})

describe('update and remove', () => {
  it('moves the pin to the entry’s current digest, keeping its unknown keys and its marketplace name', async () => {
    const v1 = skillTgz('pdf-report')
    const v2 = skillTgz('pdf-report', 'Builds better PDF reports.')
    writeManifest({ marketplace_skills: [pinOf(v1, { x_note: 'kept', marketplace_name: 'Old name' })] })
    serve([entry(v2, { version: '0.4.0', commit_hash: 'def456', marketplace_name: 'Renamed' })], [v2])
    expect(await marketplaceSkillService.update(USER, AGENT_ID, 'pdf-report')).toEqual({ ok: true, name: 'pdf-report', archiveSha256: sha256Of(v2) })
    expect(manifest().marketplace_skills).toEqual([
      pinOf(v2, { x_note: 'kept', marketplace_name: 'Old name', version: '0.4.0', commit_hash: 'def456' })
    ])
    // Already current: nothing downloads.
    cinnaFetchBytes.mockClear()
    expect(await marketplaceSkillService.update(USER, AGENT_ID, 'pdf-report')).toMatchObject({ ok: true })
    expect(cinnaFetchBytes).not.toHaveBeenCalled()
  })

  it('refuses an update of a pin whose entry is not visible any more, or a name not pinned', async () => {
    const v1 = skillTgz('pdf-report')
    writeManifest({ marketplace_skills: [pinOf(v1)] })
    serve([], [])
    expect(await marketplaceSkillService.update(USER, AGENT_ID, 'pdf-report')).toMatchObject({ ok: false, code: 'not_found' })
    expect(await marketplaceSkillService.update(USER, AGENT_ID, 'nope')).toMatchObject({ ok: false, code: 'not_found' })
  })

  it('removes the pin and leaves the cached snapshot for the next start’s clean-up', async () => {
    const archive = skillTgz('pdf-report')
    serve([entry(archive)], [archive])
    await marketplaceSkillService.addToAgent(USER, AGENT_ID, ENTRY)
    expect(await marketplaceSkillService.remove(USER, AGENT_ID, 'pdf-report')).toEqual({ ok: true, name: 'pdf-report', archiveSha256: sha256Of(archive) })
    expect(manifest().marketplace_skills).toEqual([])
    expect(existsSync(join(snapshotDir(archive), 'pdf-report', 'SKILL.md'))).toBe(true)
    expect(await marketplaceSkillService.remove(USER, AGENT_ID, 'pdf-report')).toMatchObject({ ok: false, code: 'not_found' })
  })
})

describe('skill credentials', () => {
  /** A snapshot whose SKILL.md declares the `api_token` slot `pdf-api`. */
  const withSlot = (description = 'Builds PDF reports.'): Buffer =>
    tgzOf([
      {
        name: 'skills/pdf-report/SKILL.md',
        body: `---\nname: pdf-report\ndescription: ${description}\ncredentials:\n  - slot: pdf-api\n    type: api_token\n---\n\nBody.\n`
      }
    ])

  it('auto-attaches a marketplace skill’s declared slot on Add, and tells the renderer what it attached', async () => {
    const archive = withSlot()
    serve([entry(archive)], [archive])
    autoAttachSkills.mockImplementationOnce(async () => [{ slot: 'pdf-api', credentialName: 'PDF', skill: true }])
    expect(await marketplaceSkillService.addToAgent(USER, AGENT_ID, ENTRY)).toMatchObject({ ok: true })
    await vi.waitFor(() => expect(autoAttachSkills).toHaveBeenCalledWith(AGENT_ID))
    // The slot is read from the cached snapshot the attach runs against.
    const [row] = agentSkillRows(agentDir, manifest(), undefined, marketplaceSkillCache.resolve)
    expect(row.credentials).toMatchObject([{ slot: 'pdf-api', type: 'api_token' }])
    await vi.waitFor(() => expect(publishEvent).toHaveBeenCalledWith(SERVICE_CREDENTIALS_CHANGED,
      { autoAttached: { agentId: AGENT_ID, items: [{ slot: 'pdf-api', credentialName: 'PDF', skill: true }] } }, 'all'))
    expect(detachUnusedAutoAttachments).not.toHaveBeenCalled()
  })

  it('detaches what auto-attach put there on Remove, after the pin is gone', async () => {
    const archive = withSlot()
    serve([entry(archive)], [archive])
    await marketplaceSkillService.addToAgent(USER, AGENT_ID, ENTRY)
    let pinsAtDetach: unknown = 'not called'
    detachUnusedAutoAttachments.mockImplementationOnce(async () => {
      pinsAtDetach = manifest().marketplace_skills
      return [{ group: 'g', ref: 'pdf-1', slot: 'pdf-api' }]
    })
    expect(await marketplaceSkillService.remove(USER, AGENT_ID, 'pdf-report')).toMatchObject({ ok: true })
    await vi.waitFor(() => expect(detachUnusedAutoAttachments).toHaveBeenCalledWith(AGENT_ID))
    expect(pinsAtDetach).toEqual([])
  })

  it('on Update detaches first, then fills the new snapshot’s slots; after a background fetch it fills them too', async () => {
    const v1 = withSlot()
    const v2 = withSlot('Builds better PDF reports.')
    writeManifest({ marketplace_skills: [pinOf(v1)] })
    serve([entry(v2)], [v1, v2])
    expect(await marketplaceSkillService.update(USER, AGENT_ID, 'pdf-report')).toMatchObject({ ok: true })
    await vi.waitFor(() => expect(autoAttachSkills).toHaveBeenCalledTimes(1))
    expect(detachUnusedAutoAttachments).toHaveBeenCalledWith(AGENT_ID)
    expect(detachUnusedAutoAttachments.mock.invocationCallOrder[0]).toBeLessThan(autoAttachSkills.mock.invocationCallOrder[0])

    autoAttachSkills.mockClear()
    writeManifest({ marketplace_skills: [pinOf(v1)] })
    marketplaceSkillService.ensurePinnedInBackground(USER, AGENT_ID)
    await vi.waitFor(() => expect(autoAttachSkills).toHaveBeenCalledWith(AGENT_ID, expect.anything()))
    expect(existsSync(join(snapshotDir(v1), 'pdf-report', 'SKILL.md'))).toBe(true)
  })
})

describe('ensurePinned', () => {
  it('fetches what is missing, skips what is cached, and records a not-visible entry with the marketplace’s sentence', async () => {
    const archive = skillTgz('pdf-report')
    writeManifest({ marketplace_skills: [pinOf(archive)] })
    serve([], [archive])
    expect(await marketplaceSkillService.ensurePinned(USER, AGENT_ID)).toEqual({ ok: true, fetched: ['pdf-report'], failed: [] })
    cinnaFetchBytes.mockClear()
    expect(await marketplaceSkillService.ensurePinned(USER, AGENT_ID)).toEqual({ ok: true, fetched: [], failed: [] })
    expect(cinnaFetchBytes).not.toHaveBeenCalled()

    // Another digest the server says is gone (404 not_found): the row's issue says so.
    const gone = skillTgz('pdf-report', 'gone')
    writeManifest({ marketplace_skills: [pinOf(gone)] })
    cinnaFetchBytes.mockRejectedValueOnce(new CinnaApiError('request_failed', 'Cinna API 404', '{"detail":{"code":"not_found"}}', 404))
    expect(await marketplaceSkillService.ensurePinned(USER, AGENT_ID)).toMatchObject({ ok: true, failed: [{ name: 'pdf-report', code: 'not_found' }] })
    const [row] = agentSkillRows(agentDir, manifest(), undefined, marketplaceSkillCache.resolve)
    expect(row).toMatchObject({ deliverable: false, issues: [{ code: 'download_failed', message: MARKETPLACE_NOT_AVAILABLE_SENTENCE }] })
  })

  it('refuses a pin naming the snapshot under another name, keeping the folder another agent uses', async () => {
    const archive = skillTgz('pdf-report')
    writeManifest({ marketplace_skills: [pinOf(archive)] })
    serve([], [archive])
    expect(await marketplaceSkillService.ensurePinned(USER, AGENT_ID)).toMatchObject({ ok: true, fetched: ['pdf-report'] })
    const marker = readFileSync(join(snapshotDir(archive), '.cinna-marketplace-skill.json'), 'utf8')

    // A hand-edited pin of the same entry and digest under another name: one <entry>/<sha> holds one name.
    writeManifest({ marketplace_skills: [pinOf(archive, { name: 'pdf-renamed' })] })
    expect(await marketplaceSkillService.ensurePinned(USER, AGENT_ID)).toMatchObject({
      ok: true,
      fetched: [],
      failed: [{ name: 'pdf-renamed', code: 'invalid_archive' }]
    })
    expect(readFileSync(join(snapshotDir(archive), '.cinna-marketplace-skill.json'), 'utf8')).toBe(marker)
    expect(readdirSync(snapshotDir(archive)).sort()).toEqual(['.cinna-marketplace-skill.json', 'pdf-report'])
    expect(marketplaceSkillCache.resolve({ entryUuid: ENTRY, name: 'pdf-report', archiveSha256: sha256Of(archive) }).state).toBe('ready')
  })

  it('without an account, records the reason on every missing pin and fetches nothing', async () => {
    const archive = skillTgz('pdf-report')
    writeManifest({ marketplace_skills: [pinOf(archive)] })
    host.signedIn = false
    expect(await marketplaceSkillService.ensurePinned(USER, AGENT_ID)).toMatchObject({ ok: true, failed: [{ name: 'pdf-report', code: 'no_account' }] })
    expect(cinnaFetchBytes).not.toHaveBeenCalled()
  })
})

describe('status', () => {
  it('maps each pin from one batch lookup: current, update_available, unavailable', async () => {
    const v1 = skillTgz('pdf-report')
    const v2 = skillTgz('pdf-report', 'newer')
    const MOVED = '5e1d2c3b-4a59-4687-9a6b-5c4d3e2f1a0b'
    const GONE = '6f2e3d4c-5b6a-4798-8a7b-6c5d4e3f2a1b'
    writeManifest({
      marketplace_skills: [
        pinOf(v1),
        pinOf(v1, { entry_uuid: MOVED, name: 'csv-export' }),
        pinOf(v1, { entry_uuid: GONE, name: 'old-one' })
      ]
    })
    serve([entry(v1), entry(v2, { id: MOVED, version: '2.0' })], [])
    expect(await marketplaceSkillService.status(USER, AGENT_ID)).toEqual({
      ok: true,
      pins: [
        { name: 'pdf-report', entryUuid: ENTRY, state: 'current', repositoryUrl: 'https://github.com/example/skills' },
        {
          name: 'csv-export',
          entryUuid: MOVED,
          state: 'update_available',
          latestSha256: sha256Of(v2),
          latestVersion: '2.0',
          repositoryUrl: 'https://github.com/example/skills'
        },
        { name: 'old-one', entryUuid: GONE, state: 'unavailable' }
      ]
    })
    expect(cinnaFetch).toHaveBeenCalledTimes(1)
    expect(cinnaFetch.mock.calls[0][1]).toBe(`/api/v1/llm-plugins/plugins?ids=${ENTRY},${MOVED},${GONE}`)
  })

  it('treats a visible entry with no snapshot to move to as current, and answers refusals as data', async () => {
    const v1 = skillTgz('pdf-report')
    expect(pinStatus(pinOf(v1), toEntry(entry(null, { supported: false }))!)).toMatchObject({ state: 'current' })
    expect(pinStatus(pinOf(v1, { archive_sha256: sha256Of(v1).toUpperCase() }), toEntry(entry(v1))!)).toMatchObject({ state: 'current' })
    writeManifest({ marketplace_skills: [pinOf(v1)] })
    host.signedIn = false
    expect(await marketplaceSkillService.status(USER, AGENT_ID)).toMatchObject({ ok: false, code: 'no_account' })
    host.signedIn = true
    cinnaFetch.mockRejectedValueOnce(new CinnaReauthRequired('expired'))
    expect(await marketplaceSkillService.status(USER, AGENT_ID)).toMatchObject({ ok: false, code: 'reauth_required' })
    cinnaFetch.mockRejectedValueOnce(new CinnaApiError('request_failed', 'down'))
    expect(await marketplaceSkillService.status(USER, AGENT_ID)).toMatchObject({ ok: false, code: 'network' })
    // No pins: no request.
    writeManifest()
    cinnaFetch.mockClear()
    expect(await marketplaceSkillService.status(USER, AGENT_ID)).toEqual({ ok: true, pins: [] })
    expect(cinnaFetch).not.toHaveBeenCalled()
  })
})

describe('the marketplace cache', () => {
  const ref = (archive: Buffer) => ({ entryUuid: ENTRY, name: 'pdf-report', archiveSha256: sha256Of(archive) })

  it('does not count a snapshot folder whose marker names another digest or entry', () => {
    const archive = skillTgz('pdf-report')
    marketplaceSkillCache.install('https-cinna.test', ref(archive), readSkillArchive(archive, 'pdf-report'))
    expect(marketplaceSkillCache.resolve(ref(archive))).toMatchObject({ state: 'ready' })
    const marker = join(snapshotDir(archive), '.cinna-marketplace-skill.json')
    const write = (value: unknown): void => {
      removeTree(marker)
      writeFileSync(marker, JSON.stringify(value))
    }
    write({ entry_uuid: ENTRY, name: 'pdf-report', archive_sha256: 'c'.repeat(64) })
    expect(marketplaceSkillCache.resolve(ref(archive))).toEqual({ state: 'missing' })
    write({ entry_uuid: '00000000-0000-4000-8000-000000000000', name: 'pdf-report', archive_sha256: sha256Of(archive) })
    expect(marketplaceSkillCache.resolve(ref(archive))).toEqual({ state: 'missing' })
    write({ entry_uuid: ENTRY, name: 'pdf-report', archive_sha256: sha256Of(archive) })
    expect(marketplaceSkillCache.resolve(ref(archive))).toMatchObject({ state: 'ready' })
  })

  it('never names a path from an unusable pin, and keeps the catalog cache apart', () => {
    expect(marketplaceSkillCache.revisionDir('x', { entryUuid: '../../etc', name: 'pdf-report', archiveSha256: 'a'.repeat(64) })).toBeNull()
    expect(marketplaceSkillCache.revisionDir('x', { entryUuid: ENTRY, name: 'pdf-report', archiveSha256: 'nothex' })).toBeNull()
    expect(marketplaceSkillCache.root()).toBe(join(host.userData, 'marketplace-skills'))
    expect(catalogSkillCache.root()).toBe(join(host.userData, 'catalog-skills'))
  })

  it('collects every snapshot no agent pins, keeping pinned digests on every instance', () => {
    const workshop = join(root, 'Workshop')
    registry.roots = [{ id: 'root-1', path: workshop }]
    const kept = skillTgz('pdf-report')
    const old = skillTgz('pdf-report', 'older')
    const dir = join(workshop, 'agents', 'invoices')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'cinna-agent.json'), JSON.stringify({ id: 'a', slug: 'invoices', marketplace_skills: [pinOf(kept, { entry_uuid: ENTRY.toUpperCase() })] }))
    registry.rows.push({ localPath: dir })
    registry.scans['root-1'] = [{ path: dir, skills: [] }]
    for (const instance of ['https-a.test', 'https-b.test']) {
      marketplaceSkillCache.install(instance, ref(kept), readSkillArchive(kept, 'pdf-report'))
      marketplaceSkillCache.install(instance, ref(old), readSkillArchive(old, 'pdf-report'))
    }
    expect(marketplaceSkillService.collectGarbage()).toEqual({ ok: true, removed: 2 })
    expect(readdirSync(join(cacheRoot(), 'https-a.test', ENTRY))).toEqual([sha256Of(kept)])
    expect(readdirSync(join(cacheRoot(), 'https-b.test', ENTRY))).toEqual([sha256Of(kept)])
  })

  it('skips the clean-up when an agent’s pins cannot be read', () => {
    const archive = skillTgz('pdf-report')
    marketplaceSkillCache.install('https-a.test', ref(archive), readSkillArchive(archive, 'pdf-report'))
    registry.rows.push({ localPath: join(root, 'unmounted') })
    expect(marketplaceSkillService.collectGarbage()).toMatchObject({ ok: false })
    expect(existsSync(join(cacheRoot(), 'https-a.test', ENTRY, sha256Of(archive)))).toBe(true)
  })
})
