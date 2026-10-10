import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { sha256Of, skillTgz } from '../kit/testSupport/skillTar'
import { SERVICE_CREDENTIALS_CHANGED } from '../../shared/serviceCredentials'

/**
 * Catalog skills in local agents: add, update, remove and fetch-what-is-pinned,
 * over a real agent folder, a real manifest and a real cache, with only the
 * network, the agent index, the git origin and the listing faked. What is
 * proved is what the service decides — U9's read-only rule, clashes, the two
 * digest checks, the pin it writes and the local-install reports — and that a
 * failure writes nothing.
 */

const PROFILE = 'profile-cinna'
const HOST = 'https://cinna.test'
const USER = '__default__'
const AGENT_ID = 'folder:11111111-2222-4333-8444-555566667777'
const MANIFEST_ID = '11111111-2222-4333-8444-555566667777'
const UUID = '0b6f3c1e-1111-4222-8333-444455556666'
const OTHER_AGENT_ID = 'folder:99999999-2222-4333-8444-555566667777'

const host = vi.hoisted(() => ({ userData: '' }))
const cinnaFetch = vi.hoisted(() => vi.fn<(...args: unknown[]) => Promise<unknown>>())
const cinnaFetchBytes = vi.hoisted(() => vi.fn<(...args: unknown[]) => Promise<unknown>>())
const publishEvent = vi.hoisted(() => vi.fn())
const located = vi.hoisted(() => ({ dir: '', other: '', kind: 'managed' as string, missing: false }))
const remote = vi.hoisted(() => ({ ownRepo: false, originUrl: null as string | null, cinnaServer: null as string | null }))
const listing = vi.hoisted(() => ({ value: null as null | { items: unknown[]; agents: unknown[] } }))
const refresh = vi.hoisted(() => vi.fn(async () => listing.value))
/** The skill slots main fills after Add and Update (U11), faked: what it would have attached. */
const autoAttachSkills = vi.hoisted(() => vi.fn(async (_agentId: string): Promise<unknown[]> => []))

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
    hostOf: (profile: string) => (profile === PROFILE ? HOST : null),
    knownHosts: () => new Set([HOST]),
    cached: () => listing.value,
    refresh
  }
}))
vi.mock('./localAgents/localAgentService', async () => {
  const { LocalAgentError } = await import('../errors')
  return {
    localAgentService: {
      // A bare folder's DTO carries no `skills`.
      get: (_user: string, agentId: string) => {
        if (located.missing) throw new LocalAgentError('not_found', 'gone')
        return { rootId: 'root-1', path: agentId === OTHER_AGENT_ID ? located.other : located.dir, ...(located.kind === 'external' ? {} : { skills: [] }) }
      }
    }
  }
})
vi.mock('./localAgents/scannerService', () => ({ scannerService: { markAllRootsDirty: () => {} } }))
vi.mock('./serviceCredentials/service', () => ({ serviceCredentialService: { autoAttachSkills } }))
vi.mock('./localAgents/gitService', () => ({
  gitService: { readShareRemote: async () => ({ ...remote, refusal: null }) }
}))

const { catalogSkillService } = await import('./catalogSkillService')
const { catalogSkillCache, removeTree } = await import('./catalogSkillCache')
const { catalogLocalInstalls } = await import('./catalogLocalInstalls')
const { catalogSkillUpdateItems, withCatalogSkillUpdates } = await import('./catalogSkillUpdates')
const { agentSkillRows, deliverableSkills } = await import('../kit/skills')
const { CinnaApiError } = await import('../errors')
const { libraryTrust } = await import('./libraryTrust')

let root: string
let agentDir: string

/** A skill package as the listing sends it, latest revision `revision` with `archive`'s digest. */
function skillItem(revision: number, archive: Buffer, over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    kind: 'skill',
    runs_on: null,
    uuid: UUID,
    id: 'test.cinna.skill.erp-lookup',
    name: 'erp-lookup',
    display_name: 'ERP lookup',
    access: 'use',
    latest: { revision_number: revision, version: `${revision}.0`, published_at: '', published_by: null, release_notes: null },
    skill: { frontmatter: {}, archive_sha256: sha256Of(archive), size_bytes: archive.length },
    ...over
  }
}

/** The server: `archives[n]` for revision n, with a correct digest header unless told otherwise. */
function serve(archives: Record<number, Buffer>, header: (bytes: Buffer) => string = sha256Of): void {
  cinnaFetchBytes.mockImplementation(async (...args: unknown[]) => {
    const path = args[1] as string
    const match = path.match(/\/revisions\/(\d+)\/download$/)
    const bytes = match ? archives[Number(match[1])] : undefined
    if (!bytes) throw new CinnaApiError('request_failed', 'Cinna API 404: Not Found', 'Not Found', 404)
    return { ok: true, bytes, headers: new Headers({ 'X-Content-SHA256': header(bytes) }) }
  })
}

function writeManifest(extra: Record<string, unknown> = {}): void {
  writeFileSync(
    join(agentDir, 'cinna-agent.json'),
    `${JSON.stringify({ id: MANIFEST_ID, slug: 'invoices', name: 'Invoices', ...extra }, null, 2)}\n`
  )
}

const manifest = (): Record<string, unknown> => JSON.parse(readFileSync(join(agentDir, 'cinna-agent.json'), 'utf8'))
const cacheRoot = (): string => join(host.userData, 'catalog-skills')
const revisionDir = (revision: number): string => join(cacheRoot(), 'https-cinna.test', UUID, String(revision))
const posts = (): unknown[][] => cinnaFetch.mock.calls.filter((call) => (call[2] as { method?: string })?.method === 'POST')
const deletes = (): unknown[][] => cinnaFetch.mock.calls.filter((call) => (call[2] as { method?: string })?.method === 'DELETE')

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'cinna-catalog-skills-'))
  host.userData = join(root, 'userData')
  agentDir = join(root, 'Local', 'invoices')
  mkdirSync(agentDir, { recursive: true })
  writeManifest()
  located.dir = agentDir
  located.kind = 'managed'
  located.missing = false
  remote.ownRepo = false
  remote.originUrl = null
  remote.cinnaServer = null
  located.other = ''
  libraryTrust._reset(join(root, 'team-library-trust.json'))
  listing.value = { items: [], agents: [] }
  cinnaFetch.mockReset()
  cinnaFetch.mockResolvedValue({})
  cinnaFetchBytes.mockReset()
  refresh.mockClear()
  publishEvent.mockClear()
  catalogSkillCache._reset()
  catalogSkillService._reset()
  catalogLocalInstalls._reset(join(root, 'catalog-device.json'))
})

afterEach(() => {
  removeTree(root)
})

describe('Add to agent', () => {
  it('downloads, checks both digests, caches read-only, writes the pin through the manifest guard and reports the install', async () => {
    const archive = skillTgz('erp-lookup', 'Look things up in the ERP.')
    listing.value = { items: [skillItem(3, archive)], agents: [] }
    serve({ 3: archive })

    // The skill's slots get their credentials once it is pinned (U11), in the background: the verb
    // answers before provision-local does, and what was attached is pushed to the renderer.
    let attach!: (items: unknown[]) => void
    autoAttachSkills.mockImplementationOnce(() => new Promise((resolve) => { attach = resolve }))
    const outcome = await catalogSkillService.addToAgent(USER, AGENT_ID, UUID)
    expect(outcome).toEqual({ ok: true, name: 'erp-lookup', revisionNumber: 3 })
    await vi.waitFor(() => expect(autoAttachSkills).toHaveBeenCalledWith(AGENT_ID))
    expect(publishEvent).not.toHaveBeenCalledWith(SERVICE_CREDENTIALS_CHANGED, expect.anything(), 'all')
    attach([{ slot: 'erp-api', credentialName: 'ERP', skill: true }])
    await vi.waitFor(() => expect(publishEvent).toHaveBeenCalledWith(SERVICE_CREDENTIALS_CHANGED,
      { autoAttached: { agentId: AGENT_ID, items: [{ slot: 'erp-api', credentialName: 'ERP', skill: true }] } }, 'all'))
    expect(cinnaFetchBytes.mock.calls[0].slice(0, 2)).toEqual([PROFILE, `/api/v1/skills/packages/${UUID}/revisions/3/download`])

    expect(manifest().catalog_skills).toEqual([
      {
        package_id: 'test.cinna.skill.erp-lookup',
        package_uuid: UUID,
        name: 'erp-lookup',
        revision_number: 3,
        version: '3.0',
        archive_sha256: sha256Of(archive)
      }
    ])
    // Unknown keys of the manifest survive, and it is still the 2-space JSON every writer keeps.
    expect(manifest().slug).toBe('invoices')

    const skillDir = join(revisionDir(3), 'erp-lookup')
    expect(readFileSync(join(skillDir, 'SKILL.md'), 'utf8')).toContain('name: erp-lookup')
    expect(statSync(join(skillDir, 'SKILL.md')).mode & 0o777).toBe(0o444)
    expect(statSync(join(skillDir, 'scripts', 'run.sh')).mode & 0o777).toBe(0o555)

    // Delivered: the agent's skills now include it, from the cache.
    const delivered = deliverableSkills(agentSkillRows(agentDir, manifest(), catalogSkillCache.resolve))
    expect(delivered.map((skill) => [skill.name, skill.source, skill.path])).toEqual([
      ['erp-lookup', 'catalog', join(skillDir, 'SKILL.md')]
    ])
    expect(publishEvent).toHaveBeenCalledWith('local-agent:changed', { rootId: 'root-1', agentId: AGENT_ID, reason: 'rescan' })

    await vi.waitFor(() => expect(posts()).toHaveLength(1))
    expect(posts()[0].slice(0, 3)).toEqual([
      PROFILE,
      `/api/v1/catalog/items/${UUID}/local-installs`,
      {
        method: 'POST',
        body: { device_id: catalogLocalInstalls.deviceId(), revision_number: 3, host_manifest_id: MANIFEST_ID }
      }
    ])
  })

  it('writes nothing when the bytes do not match the server’s digest or the pin’s', async () => {
    const archive = skillTgz('erp-lookup')
    const before = readFileSync(join(agentDir, 'cinna-agent.json'), 'utf8')

    // The header lies.
    listing.value = { items: [skillItem(3, archive)], agents: [] }
    serve({ 3: archive }, () => 'f'.repeat(64))
    expect(await catalogSkillService.addToAgent(USER, AGENT_ID, UUID)).toMatchObject({ ok: false, code: 'hash_mismatch' })

    // The header and the bytes agree, but not with what the catalog published.
    listing.value = { items: [skillItem(3, archive, { skill: { archive_sha256: 'e'.repeat(64) } })], agents: [] }
    serve({ 3: archive })
    expect(await catalogSkillService.addToAgent(USER, AGENT_ID, UUID)).toMatchObject({ ok: false, code: 'hash_mismatch' })

    expect(readFileSync(join(agentDir, 'cinna-agent.json'), 'utf8')).toBe(before)
    expect(existsSync(join(cacheRoot(), 'https-cinna.test', UUID)) ? readdirSync(join(cacheRoot(), 'https-cinna.test', UUID)) : []).toEqual([])
    expect(posts()).toEqual([])
    // The failure is the row's issue until a download succeeds.
    expect(catalogSkillCache.resolve({ packageUuid: UUID, revisionNumber: 3, name: 'erp-lookup', archiveSha256: 'e'.repeat(64) })).toMatchObject({
      state: 'failed'
    })
  })

  it('refuses a shared agent this person may only use (U9), before any download', async () => {
    const archive = skillTgz('erp-lookup')
    remote.ownRepo = true
    remote.originUrl = `${HOST}/git/r1.git`
    listing.value = {
      items: [skillItem(3, archive)],
      agents: [{ repoId: 'r1', bundleId: 'test.cinna.r1', cloneUrl: `${HOST}/git/r1.git`, access: 'use' }]
    }
    serve({ 3: archive })
    expect(await catalogSkillService.addToAgent(USER, AGENT_ID, UUID)).toMatchObject({ ok: false, code: 'read_only' })
    expect(cinnaFetchBytes).not.toHaveBeenCalled()

    // With edit it may; with no word from the listing it may not.
    ;(listing.value.agents[0] as { access: string }).access = 'edit'
    expect(await catalogSkillService.addToAgent(USER, AGENT_ID, UUID)).toMatchObject({ ok: true })
    listing.value.agents = []
    expect(await catalogSkillService.remove(USER, AGENT_ID, 'erp-lookup')).toMatchObject({ ok: false, code: 'access_unknown' })
  })

  it('falls back to the shared_remote link when git cannot answer: linked with use access, no repo of its own', async () => {
    const archive = skillTgz('erp-lookup')
    mkdirSync(join(agentDir, 'app-data'), { recursive: true })
    writeFileSync(
      join(agentDir, 'app-data', 'desktop.json'),
      JSON.stringify({ shared_remote: { kind: 'cinna', repo_id: 'r1', clone_url: `${HOST}/git/r1.git` } })
    )
    listing.value = {
      items: [skillItem(3, archive)],
      agents: [{ repoId: 'r1', bundleId: 'b', cloneUrl: `${HOST}/git/r1.git`, access: 'use' }]
    }
    serve({ 3: archive })
    expect(await catalogSkillService.addToAgent(USER, AGENT_ID, UUID)).toMatchObject({ ok: false, code: 'read_only' })
    expect(cinnaFetchBytes).not.toHaveBeenCalled()
    // Linked, and the listing does not say how: refused rather than guessed.
    listing.value.agents = []
    expect(await catalogSkillService.addToAgent(USER, AGENT_ID, UUID)).toMatchObject({ ok: false, code: 'access_unknown' })
    // With edit it may.
    listing.value.agents = [{ repoId: 'r1', bundleId: 'b', cloneUrl: `${HOST}/git/r1.git`, access: 'edit' }]
    expect(await catalogSkillService.addToAgent(USER, AGENT_ID, UUID)).toMatchObject({ ok: true })
  })

  it('treats an origin on a server no Cinna instance named as the developer’s own, even with /git/<x>.git', async () => {
    const archive = skillTgz('erp-lookup')
    remote.ownRepo = true
    remote.originUrl = 'https://example.org/git/tools.git'
    listing.value = { items: [skillItem(3, archive)], agents: [] }
    serve({ 3: archive })
    expect(await catalogSkillService.addToAgent(USER, AGENT_ID, UUID)).toMatchObject({ ok: true })
    // The folder says it was shared through Cinna: no longer the developer's own business.
    remote.cinnaServer = HOST
    expect(await catalogSkillService.remove(USER, AGENT_ID, 'erp-lookup')).toMatchObject({ ok: false, code: 'access_unknown' })
    // A git origin the instance itself named in its listing is Cinna's too.
    remote.cinnaServer = null
    libraryTrust.learn(HOST, 'https://git.cinna.test/git/r9.git')
    remote.originUrl = 'https://git.cinna.test/git/r9.git'
    expect(await catalogSkillService.remove(USER, AGENT_ID, 'erp-lookup')).toMatchObject({ ok: false, code: 'access_unknown' })
  })

  it('refuses a name the agent already has: its own skill, the platform’s, or a pin of the package', async () => {
    const archive = skillTgz('erp-lookup')
    listing.value = { items: [skillItem(3, archive)], agents: [] }
    serve({ 3: archive })
    mkdirSync(join(agentDir, 'skills', 'erp-lookup'), { recursive: true })
    expect(await catalogSkillService.addToAgent(USER, AGENT_ID, UUID)).toMatchObject({ ok: false, code: 'clash' })
    rmSync(join(agentDir, 'skills'), { recursive: true })

    const tasks = skillTgz('cinna-tasks')
    listing.value = { items: [skillItem(1, tasks, { name: 'cinna-tasks' })], agents: [] }
    expect(await catalogSkillService.addToAgent(USER, AGENT_ID, UUID)).toMatchObject({ ok: false, code: 'clash' })

    listing.value = { items: [skillItem(3, archive)], agents: [] }
    expect(await catalogSkillService.addToAgent(USER, AGENT_ID, UUID)).toMatchObject({ ok: true })
    expect(await catalogSkillService.addToAgent(USER, AGENT_ID, UUID)).toMatchObject({ ok: false, code: 'already_added' })
    expect(cinnaFetchBytes).toHaveBeenCalledTimes(1)
  })

  it('answers the other refusals as data', async () => {
    expect(await catalogSkillService.addToAgent(USER, AGENT_ID, UUID)).toMatchObject({ ok: false, code: 'not_in_catalog' })
    expect(refresh).toHaveBeenCalled()
    located.kind = 'external'
    expect(await catalogSkillService.addToAgent(USER, AGENT_ID, UUID)).toMatchObject({ ok: false, code: 'not_kit_agent' })
    located.missing = true
    expect(await catalogSkillService.addToAgent(USER, AGENT_ID, UUID)).toMatchObject({ ok: false, code: 'not_found' })
    located.missing = false
    located.kind = 'managed'
    listing.value = { items: [skillItem(3, skillTgz('erp-lookup'))], agents: [] }
    cinnaFetchBytes.mockRejectedValue(new CinnaApiError('reauth_required', 'Cinna 401', '401', 401))
    expect(await catalogSkillService.addToAgent(USER, AGENT_ID, UUID)).toMatchObject({ ok: false, code: 'reauth_required' })
    cinnaFetchBytes.mockResolvedValue({ ok: false, reason: 'too_large' })
    expect(await catalogSkillService.addToAgent(USER, AGENT_ID, UUID)).toMatchObject({ ok: false, code: 'too_large' })
    expect(manifest().catalog_skills).toBeUndefined()
  })

  it('refuses an archive that breaks the unpacking rules, whatever its digest', async () => {
    const wrongFolder = skillTgz('something-else')
    listing.value = { items: [skillItem(3, wrongFolder)], agents: [] }
    serve({ 3: wrongFolder })
    expect(await catalogSkillService.addToAgent(USER, AGENT_ID, UUID)).toMatchObject({ ok: false, code: 'invalid_archive' })
    expect(existsSync(revisionDir(3))).toBe(false)
  })
})

describe('Update and Remove', () => {
  const pinOf = (revision: number, archive: Buffer): Record<string, unknown> => ({
    package_id: 'test.cinna.skill.erp-lookup',
    package_uuid: UUID,
    name: 'erp-lookup',
    revision_number: revision,
    version: `${revision}.0`,
    archive_sha256: sha256Of(archive),
    note: 'kept'
  })

  it('moves the pin to the latest version, keeping the pin’s other keys, and reports the new revision', async () => {
    const v1 = skillTgz('erp-lookup', 'First.')
    const v2 = skillTgz('erp-lookup', 'Second.')
    writeManifest({ catalog_skills: [pinOf(1, v1)] })
    listing.value = { items: [skillItem(2, v2)], agents: [] }
    serve({ 2: v2 })
    autoAttachSkills.mockClear()
    autoAttachSkills.mockImplementationOnce(() => new Promise(() => {}))
    // Answers without waiting for the slots to be filled (provision-local may take its timeout).
    expect(await catalogSkillService.update(USER, AGENT_ID, 'erp-lookup')).toEqual({ ok: true, name: 'erp-lookup', revisionNumber: 2 })
    await vi.waitFor(() => expect(autoAttachSkills).toHaveBeenCalledTimes(1))
    expect(manifest().catalog_skills).toEqual([{ ...pinOf(2, v2) }])
    await vi.waitFor(() => expect(posts()).toHaveLength(1))
    expect((posts()[0][2] as { body: unknown }).body).toEqual({
      device_id: catalogLocalInstalls.deviceId(),
      revision_number: 2,
      host_manifest_id: MANIFEST_ID
    })
    // Already at the latest: nothing to do, nothing fetched again.
    expect(await catalogSkillService.update(USER, AGENT_ID, 'erp-lookup')).toEqual({ ok: true, name: 'erp-lookup', revisionNumber: 2 })
    expect(cinnaFetchBytes).toHaveBeenCalledTimes(1)
  })

  it('drops the pin and tells core this agent no longer holds it', async () => {
    const v1 = skillTgz('erp-lookup')
    writeManifest({ catalog_skills: [pinOf(1, v1)] })
    expect(await catalogSkillService.remove(USER, AGENT_ID, 'erp-lookup')).toEqual({ ok: true, name: 'erp-lookup', revisionNumber: 1 })
    expect(manifest().catalog_skills).toEqual([])
    await vi.waitFor(() => expect(deletes()).toHaveLength(1))
    expect(deletes()[0].slice(0, 2)).toEqual([
      PROFILE,
      `/api/v1/catalog/items/${UUID}/local-installs/${catalogLocalInstalls.deviceId()}?host_manifest_id=${MANIFEST_ID}`
    ])
    expect(await catalogSkillService.remove(USER, AGENT_ID, 'erp-lookup')).toMatchObject({ ok: false, code: 'not_found' })
  })

  it('refuses both on a shared agent this person may only use', async () => {
    writeManifest({ catalog_skills: [pinOf(1, skillTgz('erp-lookup'))] })
    remote.ownRepo = true
    remote.originUrl = `${HOST}/git/r1.git`
    listing.value = {
      items: [skillItem(2, skillTgz('erp-lookup', 'Second.'))],
      agents: [{ repoId: 'r1', bundleId: 'b', cloneUrl: `${HOST}/git/r1.git`, access: 'use' }]
    }
    expect(await catalogSkillService.update(USER, AGENT_ID, 'erp-lookup')).toMatchObject({ ok: false, code: 'read_only' })
    expect(await catalogSkillService.remove(USER, AGENT_ID, 'erp-lookup')).toMatchObject({ ok: false, code: 'read_only' })
    expect((manifest().catalog_skills as unknown[]).length).toBe(1)
  })
})

describe('fetching what an agent pins (U7)', () => {
  it('fetches every missing revision, records a refusal on the row, and never throws', async () => {
    const good = skillTgz('erp-lookup')
    const other = skillTgz('csv-export')
    const otherUuid = '9a9a9a9a-1111-4222-8333-444455556666'
    writeManifest({
      catalog_skills: [
        { package_id: 'p.skill.erp-lookup', package_uuid: UUID, name: 'erp-lookup', revision_number: 2, archive_sha256: sha256Of(good) },
        { package_id: 'p.skill.csv-export', package_uuid: otherUuid, name: 'csv-export', revision_number: 5, archive_sha256: sha256Of(other) }
      ]
    })
    // The teammate is behind: core answers 404 for csv-export.
    serve({ 2: good })

    const result = await catalogSkillService.ensurePinned(USER, AGENT_ID)
    expect(result).toMatchObject({ ok: true, fetched: ['erp-lookup'], failed: [{ name: 'csv-export', code: 'download_failed' }] })
    const rows = agentSkillRows(agentDir, manifest(), catalogSkillCache.resolve)
    expect(rows.map((row) => [row.name, row.deliverable, row.issues.map((issue) => issue.code)])).toEqual([
      ['csv-export', false, ['download_failed']],
      ['erp-lookup', true, []]
    ])
    expect(rows[0].issues[0].message).toMatch(/update it to the team’s latest version/)
    await vi.waitFor(() => expect(posts()).toHaveLength(1))

    // Already here: nothing is fetched again.
    cinnaFetchBytes.mockClear()
    expect(await catalogSkillService.ensurePinned(USER, AGENT_ID)).toMatchObject({ ok: true, fetched: [] })
    expect(cinnaFetchBytes.mock.calls.map((call) => call[1])).toEqual([`/api/v1/skills/packages/${otherUuid}/revisions/5/download`])

    located.missing = true
    expect(await catalogSkillService.ensurePinned(USER, AGENT_ID)).toMatchObject({ ok: false, code: 'not_found' })
  })

  it('fills the skill slots after the background fetch of a sharing verb, never failing it', async () => {
    const good = skillTgz('erp-lookup')
    writeManifest({ catalog_skills: [{ package_id: 'p.skill.erp-lookup', package_uuid: UUID, name: 'erp-lookup', revision_number: 2, archive_sha256: sha256Of(good) }] })
    serve({ 2: good })
    autoAttachSkills.mockClear()
    // Asked only once the revision is cached, so the cached SKILL.md's slots are known.
    let cachedFirst: string | null = null
    autoAttachSkills.mockImplementationOnce(async () => {
      cachedFirst = catalogSkillCache.resolve({ name: 'erp-lookup', packageUuid: UUID, revisionNumber: 2, archiveSha256: sha256Of(good) }).state
      throw new Error('boom')
    })
    catalogSkillService.ensurePinnedInBackground(USER, AGENT_ID)
    await vi.waitFor(() => expect(autoAttachSkills).toHaveBeenCalledWith(AGENT_ID))
    expect(cachedFirst).toBe('ready')
  })
})

describe('downloads in flight', () => {
  it('never shares one download between two pins of a revision with different digests', async () => {
    const good = skillTgz('erp-lookup', 'Good.')
    const otherDir = join(root, 'Local', 'other')
    mkdirSync(otherDir, { recursive: true })
    located.other = otherDir
    const pinWith = (digest: string) => ({ package_id: 'p.skill.erp-lookup', package_uuid: UUID, name: 'erp-lookup', revision_number: 2, archive_sha256: digest })
    writeManifest({ catalog_skills: [pinWith(sha256Of(good))] })
    writeFileSync(join(otherDir, 'cinna-agent.json'), JSON.stringify({ id: 'other', slug: 'other', catalog_skills: [pinWith('d'.repeat(64))] }))
    // Both requests are open at once.
    let release: () => void = () => {}
    const gate = new Promise<void>((resolve) => (release = resolve))
    cinnaFetchBytes.mockImplementation(async () => {
      await gate
      return { ok: true, bytes: good, headers: new Headers({ 'X-Content-SHA256': sha256Of(good) }) }
    })
    const first = catalogSkillService.ensurePinned(USER, AGENT_ID)
    const second = catalogSkillService.ensurePinned(USER, OTHER_AGENT_ID)
    await vi.waitFor(() => expect(cinnaFetchBytes).toHaveBeenCalledTimes(2))
    release()
    expect(await first).toMatchObject({ ok: true, fetched: ['erp-lookup'], failed: [] })
    expect(await second).toMatchObject({ ok: true, fetched: [], failed: [{ name: 'erp-lookup', code: 'hash_mismatch' }] })
  })

  it('asks for nothing for a pin whose package is not a UUID: a failure on its row', async () => {
    writeManifest({
      catalog_skills: [{ package_id: 'p', package_uuid: '../../admin', name: 'erp-lookup', revision_number: 2, archive_sha256: 'a'.repeat(64) }]
    })
    const result = await catalogSkillService.ensurePinned(USER, AGENT_ID)
    expect(result).toMatchObject({ ok: true, fetched: [], failed: [{ name: 'erp-lookup', code: 'download_failed' }] })
    expect(cinnaFetchBytes).not.toHaveBeenCalled()
  })
})

describe('the cache', () => {
  const ref = (archive: Buffer) => ({ packageUuid: UUID, revisionNumber: 4, name: 'erp-lookup', archiveSha256: sha256Of(archive) })

  it('holds a revision complete or not at all: a failed install leaves neither the revision nor its staging', async () => {
    const { readSkillArchive } = await import('../kit/skillArchive')
    const archive = skillTgz('erp-lookup')
    const parsed = readSkillArchive(archive, 'erp-lookup')
    // A file and a folder at one path: the disk refuses half-way through.
    const broken = { dirs: ['x'], files: [...parsed.files, { path: 'x', data: Buffer.from('no'), executable: false }] }
    expect(() => catalogSkillCache.install('https-cinna.test', ref(archive), broken)).toThrow()
    expect(readdirSync(join(cacheRoot(), 'https-cinna.test', UUID))).toEqual([])
    expect(catalogSkillCache.resolve(ref(archive))).toEqual({ state: 'missing' })

    const dir = catalogSkillCache.install('https-cinna.test', ref(archive), parsed)
    expect(readdirSync(join(cacheRoot(), 'https-cinna.test', UUID))).toEqual(['4'])
    expect(catalogSkillCache.resolve(ref(archive))).toEqual({ state: 'ready', dir })
  })

  it('does not count a revision folder whose marker names another digest, and replaces it on install', () => {
    const archive = skillTgz('erp-lookup')
    mkdirSync(join(revisionDir(4), 'erp-lookup'), { recursive: true })
    writeFileSync(join(revisionDir(4), '.cinna-catalog-skill.json'), JSON.stringify({ ...ref(archive), archive_sha256: 'c'.repeat(64) }))
    expect(catalogSkillCache.resolve(ref(archive))).toEqual({ state: 'missing' })
  })

  it('does not count, or write through, a linked <uuid> folder', async () => {
    const { readSkillArchive } = await import('../kit/skillArchive')
    const archive = skillTgz('erp-lookup')
    const parsed = readSkillArchive(archive, 'erp-lookup')
    // A real cached revision, then its <uuid> folder moved elsewhere and linked back.
    catalogSkillCache.install('https-cinna.test', ref(archive), parsed)
    const elsewhere = join(root, 'elsewhere')
    renameSync(join(cacheRoot(), 'https-cinna.test', UUID), elsewhere)
    symlinkSync(elsewhere, join(cacheRoot(), 'https-cinna.test', UUID), 'dir')
    expect(catalogSkillCache.resolve(ref(archive))).toEqual({ state: 'missing' })
    expect(catalogSkillCache.has('https-cinna.test', ref(archive))).toBe(false)
    // Installing another revision refuses to go through the link.
    const before = readdirSync(elsewhere)
    expect(() => catalogSkillCache.install('https-cinna.test', { ...ref(archive), revisionNumber: 5 }, parsed)).toThrow()
    expect(readdirSync(elsewhere)).toEqual(before)
  })

  it('does not count a linked revision folder, and replaces the link on install', async () => {
    const { readSkillArchive } = await import('../kit/skillArchive')
    const archive = skillTgz('erp-lookup')
    const parsed = readSkillArchive(archive, 'erp-lookup')
    catalogSkillCache.install('https-cinna.test', ref(archive), parsed)
    const elsewhere = join(root, 'elsewhere-revision')
    renameSync(revisionDir(4), elsewhere)
    symlinkSync(elsewhere, revisionDir(4), 'dir')
    expect(catalogSkillCache.resolve(ref(archive))).toEqual({ state: 'missing' })
    expect(catalogSkillCache.has('https-cinna.test', ref(archive))).toBe(false)
    const dir = catalogSkillCache.install('https-cinna.test', ref(archive), parsed)
    expect(catalogSkillCache.resolve(ref(archive))).toEqual({ state: 'ready', dir })
    // The link was moved aside and removed; what it pointed at was not touched.
    expect(existsSync(join(elsewhere, 'erp-lookup', 'SKILL.md'))).toBe(true)
  })

  it('remembers a failure for the pin that failed, not for another pin of the same revision', async () => {
    const good = skillTgz('erp-lookup')
    // One agent pins revision 2 with a digest the server's bytes do not match.
    const wrong = { package_id: 'p.skill.erp-lookup', package_uuid: UUID, name: 'erp-lookup', revision_number: 2, archive_sha256: 'e'.repeat(64) }
    writeManifest({ catalog_skills: [wrong] })
    serve({ 2: good })
    const result = await catalogSkillService.ensurePinned(USER, AGENT_ID)
    expect(result).toMatchObject({ ok: true, failed: [{ name: 'erp-lookup', code: 'hash_mismatch' }] })
    expect(catalogSkillCache.resolve({ packageUuid: UUID, revisionNumber: 2, name: 'erp-lookup', archiveSha256: 'e'.repeat(64) })).toMatchObject({
      state: 'failed'
    })
    // The same revision pinned with the right digest has not been tried, so it is only missing.
    expect(catalogSkillCache.resolve({ packageUuid: UUID, revisionNumber: 2, name: 'erp-lookup', archiveSha256: sha256Of(good) })).toEqual({
      state: 'missing'
    })
  })

  it('keys an instance by its origin as one safe folder name', () => {
    expect(catalogSkillCache.instanceKey('https://Cinna.Example.com:8443/')).toBe('https-cinna.example.com-8443')
    expect(catalogSkillCache.instanceKey('http://localhost:8000')).toBe('http-localhost-8000')
    expect(catalogSkillCache.revisionDir('x', { ...ref(skillTgz('a')), packageUuid: '../../etc' })).toBeNull()
  })
})

describe('the update signal (U9)', () => {
  const agentWith = (revision: number) => ({
    path: agentDir,
    skills: [{ name: 'erp-lookup', source: 'catalog', packageUuid: UUID, revisionNumber: revision }]
  })

  it('offers an update when the listing is past the pin and the agent may be changed', () => {
    listing.value = { items: [skillItem(3, skillTgz('erp-lookup'))], agents: [] }
    const out = withCatalogSkillUpdates(agentWith(1) as never)
    expect(out.skills?.[0]).toMatchObject({ latestRevision: 3, updatable: true })
    expect(withCatalogSkillUpdates(agentWith(3) as never).skills?.[0]).toMatchObject({ latestRevision: 3, updatable: false })
  })

  it('names the row by its catalog title and labels the latest version, from the listing', () => {
    listing.value = { items: [skillItem(3, skillTgz('erp-lookup'))], agents: [] }
    expect(withCatalogSkillUpdates(agentWith(1) as never).skills?.[0]).toMatchObject({
      name: 'erp-lookup',
      title: 'ERP lookup',
      latestVersion: '3.0'
    })
    listing.value = { items: [], agents: [] }
    expect(withCatalogSkillUpdates(agentWith(1) as never).skills?.[0]).toMatchObject({ title: null, latestRevision: null, latestVersion: null })
  })

  it('never offers one in a shared agent this person may only use', () => {
    mkdirSync(join(agentDir, 'app-data'), { recursive: true })
    writeFileSync(
      join(agentDir, 'app-data', 'desktop.json'),
      JSON.stringify({ shared_remote: { kind: 'cinna', repo_id: 'r1', clone_url: `${HOST}/git/r1.git` } })
    )
    listing.value = {
      items: [skillItem(3, skillTgz('erp-lookup'))],
      agents: [{ repoId: 'r1', bundleId: 'b', cloneUrl: `${HOST}/git/r1.git`, access: 'use' }]
    }
    expect(withCatalogSkillUpdates(agentWith(1) as never).skills?.[0]).toMatchObject({ latestRevision: 3, updatable: false })
    ;(listing.value.agents[0] as { access: string }).access = 'maintain'
    expect(withCatalogSkillUpdates(agentWith(1) as never).skills?.[0]).toMatchObject({ updatable: true })
  })
})

describe('the Inbox items (Update available for a skill)', () => {
  const agent = (id: string, name: string, rows: Record<string, unknown>[]) => ({ id, name, path: agentDir, skills: rows })
  const row = (over: Record<string, unknown>) => ({
    name: 'erp-lookup', source: 'catalog', packageUuid: UUID, revisionNumber: 1, latestRevision: 3, updatable: true, ...over
  })

  it('lists one item per agent and updatable pin, with the version, who and when from the listing', () => {
    listing.value = {
      items: [skillItem(3, skillTgz('erp-lookup'), {
        latest: { revision_number: 3, version: '3.0', published_at: '2026-09-13T12:00:00Z', published_by: { display_name: 'Anna Berg' }, release_notes: null }
      })],
      agents: []
    }
    const items = catalogSkillUpdateItems([
      agent('folder:a', 'Invoices', [row({}), row({ name: 'own', source: 'authored', updatable: undefined })]),
      agent('folder:b', 'Payroll', [row({ updatable: false })]),
      agent('folder:c', 'Ledger', [row({ revisionNumber: 2 })])
    ] as never)
    expect(items).toEqual([
      {
        kind: 'update_available', target: 'skill', agentId: 'folder:a', agentName: 'Invoices', skillName: 'erp-lookup',
        skillTitle: 'ERP lookup', pinnedRevision: 1, version: 3, versionLabel: '3.0', changedBy: 'Anna Berg',
        changedAt: new Date('2026-09-13T12:00:00Z')
      },
      expect.objectContaining({ agentId: 'folder:c', pinnedRevision: 2, version: 3 })
    ])
  })

  it('names no label, publisher or date when the listing no longer describes that version, and none without a skill', () => {
    listing.value = { items: [], agents: [] }
    expect(catalogSkillUpdateItems([agent('folder:a', 'Invoices', [row({})])] as never)).toEqual([
      expect.objectContaining({ skillTitle: 'erp-lookup', version: 3, versionLabel: null, changedBy: null, changedAt: null })
    ])
    expect(catalogSkillUpdateItems([{ id: 'folder:bare', name: 'Bare', path: agentDir }] as never)).toEqual([])
  })
})
