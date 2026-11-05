import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * What a skill link offers (README §4), over a real agent folder and manifest
 * and the real `catalogSkillService` checks, with only the profiles, the
 * listing, the agent index and the git origin faked — as
 * `catalogSkillService.test.ts` fakes them. The case that matters most is the
 * first: the answer comes from a fresh listing, never the cache.
 */

const PROFILE = 'profile-cinna'
const OTHER = 'profile-other'
const HOST = 'https://cinna.test'
const OTHER_HOST = 'https://other.test'
const USER = '__default__'
const AGENT_ID = 'folder:11111111-2222-4333-8444-555566667777'
const UUID = '0b6f3c1e-1111-4222-8333-444455556666'
const PACKAGE_ID = 'test.cinna.skill.erp-lookup'
const DIGEST = 'a'.repeat(64)

const host = vi.hoisted(() => ({ userData: '' }))
const located = vi.hoisted(() => ({ dir: '', kind: 'managed' as string, missing: false, explode: false }))
const remote = vi.hoisted(() => ({ ownRepo: false, originUrl: null as string | null, cinnaServer: null as string | null }))
type Listing = { host: string; items: unknown[]; agents: unknown[]; available: boolean; fetchedAt: Date }
/** The cache and the fresh read, apart: a test sets one to disagree with the other. */
const listings = vi.hoisted(() => ({ cached: {} as Record<string, Listing | null>, fresh: null as Listing | null }))
const refresh = vi.hoisted(() => vi.fn(async (_profile: string): Promise<unknown> => listings.fresh))
const users = vi.hoisted(() => ({ rows: [] as { id: string; type: string; displayName: string; cinnaServerUrl: string | null }[] }))
const hosts = vi.hoisted(() => ({ active: 'https://cinna.test' as string | null }))

vi.mock('../host/runtimeHost', () => ({ runtimeHost: { getPath: () => host.userData } }))
vi.mock('../logger/logger', () => ({
  createLogger: () => ({ debug: () => {}, info: () => {}, warn: () => {}, error: () => {} })
}))
vi.mock('../auth/scope', () => ({ getProfileScopeUserId: () => PROFILE, getSettingsScopeUserId: () => USER }))
vi.mock('../host/events', () => ({ publishEvent: vi.fn() }))
vi.mock('./cinna-http', () => ({ cinnaFetch: vi.fn(), cinnaFetchBytes: vi.fn() }))
vi.mock('../db/users', () => ({ userRepo: { list: () => users.rows } }))
const broadcastReauthRequired = vi.hoisted(() => vi.fn())
vi.mock('../auth/reauth-notify', () => ({ broadcastReauthRequired }))
/** Each server's discovery document, by the URL it is asked with; a missing one is a failed fetch, a `hang` one never answers. */
const discovery = vi.hoisted(() => ({ docs: {} as Record<string, unknown>, hang: new Set<string>() }))
const discover = vi.hoisted(() =>
  vi.fn(async (serverUrl: string, _signal?: AbortSignal): Promise<unknown> => {
    if (discovery.hang.has(serverUrl)) return new Promise(() => {})
    const doc = discovery.docs[serverUrl]
    if (doc === undefined) throw new Error(`HTTP 404 from ${serverUrl}`)
    return doc
  })
)
vi.mock('../auth/cinna-oauth', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../auth/cinna-oauth')>()),
  discoverCinnaEndpoints: discover
}))
vi.mock('./libraryService', () => ({
  catalogItemPath: (uuid: string) => `/api/v1/catalog/items/${encodeURIComponent(uuid)}`,
  libraryService: {
    hostOf: (profile: string) => (profile === PROFILE ? hosts.active : null),
    knownHosts: () => new Set([HOST]),
    cached: (profile: string) => listings.cached[profile] ?? null,
    refresh
  }
}))
vi.mock('./localAgents/localAgentService', async () => {
  const { LocalAgentError } = await import('../errors')
  return {
    localAgentService: {
      // A bare folder's DTO carries no `skills`.
      get: () => {
        if (located.explode) throw new Error('index exploded')
        if (located.missing) throw new LocalAgentError('not_found', 'gone')
        return { rootId: 'root-1', name: 'Invoices', path: located.dir, ...(located.kind === 'external' ? {} : { skills: [] }) }
      }
    }
  }
})
vi.mock('./localAgents/scannerService', () => ({
  scannerService: { markAllRootsDirty: () => {}, scanRootCached: () => ({ agents: [] }) }
}))
vi.mock('../db/agents', () => ({ agentRepo: { listFolder: () => [] } }))
vi.mock('../db/agentRoots', () => ({ agentRootRepo: { list: () => [] } }))
vi.mock('./localAgents/gitService', () => ({
  gitService: { readShareRemote: async () => ({ ...remote, refusal: null }) }
}))

const { skillLinkService } = await import('./skillLinkService')
const { CinnaReauthRequired } = await import('../auth/cinna-oauth')
const { CinnaApiError } = await import('../errors')
const { DISCOVERY_WAIT_MS } = await import('./cinnaServerOrigins')
const { removeTree } = await import('./catalogSkillCache')
const { libraryTrust } = await import('./libraryTrust')

let root: string
let agentDir: string

/** A skill package as the listing sends it, latest revision `revision`. */
function skillItem(revision: number, over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    kind: 'skill',
    runs_on: null,
    uuid: UUID,
    id: PACKAGE_ID,
    name: 'erp-lookup',
    display_name: 'ERP lookup',
    description: 'Look things up in the ERP.',
    publisher: { user_id: 'u1', display_name: 'Ada' },
    access: 'use',
    latest: { revision_number: revision, version: `${revision}.0`, published_at: '', published_by: null, release_notes: null },
    required_credential_specs: [{ slot: 'erp-api', type: 'api_key' }],
    skill: { frontmatter: {}, archive_sha256: DIGEST, size_bytes: 10 },
    ...over
  }
}

const listingOf = (items: unknown[], over: Partial<Listing> = {}): Listing => ({
  host: HOST,
  items,
  agents: [],
  available: true,
  fetchedAt: new Date(),
  ...over
})

function writeManifest(extra: Record<string, unknown> = {}): void {
  writeFileSync(
    join(agentDir, 'cinna-agent.json'),
    `${JSON.stringify({ id: '11111111-2222-4333-8444-555566667777', slug: 'invoices', name: 'Invoices', ...extra }, null, 2)}\n`
  )
}

const pinOf = (revision: number): Record<string, unknown> => ({
  package_id: PACKAGE_ID,
  package_uuid: UUID,
  name: 'erp-lookup',
  revision_number: revision,
  archive_sha256: DIGEST
})

const resolve = (agentId: string | null = AGENT_ID, origin: string | null = HOST) =>
  skillLinkService.resolve(USER, { origin, packageId: PACKAGE_ID, agentId })

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'cinna-skill-link-'))
  host.userData = join(root, 'userData')
  agentDir = join(root, 'Local', 'invoices')
  mkdirSync(agentDir, { recursive: true })
  writeManifest()
  located.dir = agentDir
  located.kind = 'managed'
  located.missing = false
  located.explode = false
  remote.ownRepo = false
  remote.originUrl = null
  remote.cinnaServer = null
  libraryTrust._reset(join(root, 'team-library-trust.json'))
  hosts.active = HOST
  users.rows = [{ id: PROFILE, type: 'cinna_user', displayName: 'Me at work', cinnaServerUrl: `${HOST}/` }]
  listings.cached = {}
  listings.fresh = listingOf([skillItem(3)])
  refresh.mockReset()
  refresh.mockImplementation(async () => listings.fresh)
  broadcastReauthRequired.mockReset()
  discovery.docs = {}
  discovery.hang = new Set()
  discover.mockClear()
})

afterEach(() => {
  removeTree(root)
})

describe('skillLinkService.resolve', () => {
  it('answers from a fresh listing: the cache says present, the fresh read says absent → no_access', async () => {
    listings.cached[PROFILE] = listingOf([skillItem(3)])
    listings.fresh = listingOf([])
    expect(await resolve()).toEqual({ state: 'no_access', host: 'cinna.test', origin: HOST })
    expect(refresh).toHaveBeenCalledWith(PROFILE)
  })

  it('ok: the skill as the listing describes it, and the agent can take it', async () => {
    expect(await resolve()).toEqual({
      state: 'ok',
      host: 'cinna.test',
      origin: HOST,
      serverGiven: true,
      skill: {
        packageUuid: UUID,
        packageId: PACKAGE_ID,
        title: 'ERP lookup',
        name: 'erp-lookup',
        revisionNumber: 3,
        versionLabel: '3.0',
        publisher: 'Ada',
        description: 'Look things up in the ERP.',
        requiredCredentialSpecs: [{ slot: 'erp-api', type: 'api_key' }]
      },
      target: { agentId: AGENT_ID, agentName: 'Invoices', verdict: 'ok' }
    })
  })

  it('a link without a server resolves against the active profile, and says so', async () => {
    const answer = await resolve(AGENT_ID, null)
    expect(answer).toMatchObject({ state: 'ok', origin: HOST, host: 'cinna.test', serverGiven: false })
  })

  it('matches the package id exactly, and only a skill', async () => {
    listings.fresh = listingOf([
      skillItem(3, { id: PACKAGE_ID.toUpperCase() }),
      skillItem(3, { kind: 'agent', id: PACKAGE_ID })
    ])
    expect(await resolve()).toMatchObject({ state: 'no_access' })
  })

  it('other_profile: another Cinna profile is on that server, with the title from its cached listing', async () => {
    users.rows.push({ id: OTHER, type: 'cinna_user', displayName: 'Me at Acme', cinnaServerUrl: OTHER_HOST })
    listings.cached[OTHER] = listingOf([skillItem(2, { display_name: 'ERP (Acme)' })], { host: OTHER_HOST })
    expect(await resolve(AGENT_ID, OTHER_HOST)).toEqual({
      state: 'other_profile',
      host: 'other.test',
      origin: OTHER_HOST,
      profileId: OTHER,
      profileName: 'Me at Acme',
      title: 'ERP (Acme)'
    })
    expect(refresh).not.toHaveBeenCalled()
    listings.cached[OTHER] = null
    expect(await resolve(AGENT_ID, OTHER_HOST)).toMatchObject({ state: 'other_profile', title: null })
  })

  it('not_connected: no profile is on that server', async () => {
    users.rows.push({ id: 'local', type: 'local_user', displayName: 'Local', cinnaServerUrl: OTHER_HOST })
    // The active server answers its discovery, naming only itself.
    discovery.docs[`${HOST}/`] = { authorization_endpoint: `${HOST}/a`, token_endpoint: `${HOST}/t`, userinfo_endpoint: `${HOST}/u` }
    expect(await resolve(AGENT_ID, OTHER_HOST)).toEqual({ state: 'not_connected', host: 'other.test', origin: OTHER_HOST })
    expect(refresh).not.toHaveBeenCalled()
  })

  it('not_connected: a server-less link with no Cinna profile active', async () => {
    hosts.active = null
    expect(await resolve(AGENT_ID, null)).toEqual({ state: 'not_connected', host: null, origin: null })
  })

  it('not_connected: the fresh read says the profile is not a Cinna one', async () => {
    refresh.mockResolvedValueOnce(null)
    expect(await resolve()).toEqual({ state: 'not_connected', host: 'cinna.test', origin: HOST })
  })

  it('no_access: an unavailable listing, or a package with no version to pin', async () => {
    listings.fresh = listingOf([skillItem(3)], { available: false })
    expect(await resolve()).toMatchObject({ state: 'no_access' })
    listings.fresh = listingOf([skillItem(3, { latest: null })])
    expect(await resolve()).toMatchObject({ state: 'no_access' })
  })

  it('offline: the fresh read throws — never the cache instead', async () => {
    listings.cached[PROFILE] = listingOf([skillItem(3)])
    refresh.mockRejectedValueOnce(new Error('ECONNREFUSED'))
    expect(await resolve()).toEqual({ state: 'offline', host: 'cinna.test', origin: HOST })
    expect(broadcastReauthRequired).not.toHaveBeenCalled()
  })

  it('reauth_required: a lost session is not offline, and raises the sign-in prompt', async () => {
    listings.cached[PROFILE] = listingOf([skillItem(3)])
    refresh.mockRejectedValueOnce(new CinnaReauthRequired())
    expect(await resolve()).toEqual({ state: 'reauth_required', host: 'cinna.test', origin: HOST })
    expect(broadcastReauthRequired).toHaveBeenCalledWith('skill-link:resolve')
    refresh.mockRejectedValueOnce(new CinnaApiError('reauth_required', 'Cinna 401', '401', 401))
    expect(await resolve()).toEqual({ state: 'reauth_required', host: 'cinna.test', origin: HOST })
    expect(broadcastReauthRequired).toHaveBeenCalledTimes(2)
  })

  it('offline: an unexpected failure past the listing is data, not a throw', async () => {
    located.explode = true
    expect(await resolve()).toEqual({ state: 'offline', host: 'cinna.test', origin: HOST })
  })

  it('not_kit_agent: a manifest that cannot be read', async () => {
    writeFileSync(join(agentDir, 'cinna-agent.json'), '{ not json')
    expect(await resolve()).toMatchObject({ state: 'ok', target: { verdict: 'not_kit_agent' } })
  })

  it('already_added: behind when the pin is older than the latest, not when it is the latest', async () => {
    writeManifest({ catalog_skills: [pinOf(2)] })
    expect(await resolve()).toMatchObject({
      state: 'already_added',
      target: { agentId: AGENT_ID, agentName: 'Invoices', verdict: 'already_added', pinName: 'erp-lookup', pinnedRevision: 2, behind: true }
    })
    writeManifest({ catalog_skills: [pinOf(3)] })
    expect(await resolve()).toMatchObject({
      state: 'already_added',
      target: { verdict: 'already_added', pinnedRevision: 3, behind: false }
    })
  })

  it('already_added before changeability: a use-only agent that pins it says so, with no Update to offer', async () => {
    remote.ownRepo = true
    remote.originUrl = `${HOST}/git/r1.git`
    listings.fresh = listingOf([skillItem(3)], {
      agents: [{ repoId: 'r1', bundleId: 'test.cinna.r1', cloneUrl: `${HOST}/git/r1.git`, access: 'use' }]
    })
    writeManifest({ catalog_skills: [pinOf(2)] })
    expect(await resolve()).toMatchObject({
      state: 'already_added',
      target: { agentId: AGENT_ID, agentName: 'Invoices', verdict: 'already_added', pinnedRevision: 2, behind: false }
    })
    // Access unknown is no Update either.
    listings.fresh = listingOf([skillItem(3)])
    expect(await resolve()).toMatchObject({ state: 'already_added', target: { pinnedRevision: 2, behind: false } })
  })

  it('read_only: a shared agent this person may only use', async () => {
    remote.ownRepo = true
    remote.originUrl = `${HOST}/git/r1.git`
    listings.fresh = listingOf([skillItem(3)], {
      agents: [{ repoId: 'r1', bundleId: 'test.cinna.r1', cloneUrl: `${HOST}/git/r1.git`, access: 'use' }]
    })
    expect(await resolve()).toMatchObject({ state: 'ok', target: { agentId: AGENT_ID, agentName: 'Invoices', verdict: 'read_only' } })
    // Decided on the fresh listing's agents, not the cache's.
    listings.cached[PROFILE] = listingOf([skillItem(3)], {
      agents: [{ repoId: 'r1', bundleId: 'test.cinna.r1', cloneUrl: `${HOST}/git/r1.git`, access: 'edit' }]
    })
    expect(await resolve()).toMatchObject({ target: { verdict: 'read_only' } })
    listings.fresh = listingOf([skillItem(3)])
    expect(await resolve()).toMatchObject({ target: { verdict: 'access_unknown' } })
  })

  it('not_kit_agent: a bare folder, or an agent that is gone', async () => {
    located.kind = 'external'
    expect(await resolve()).toMatchObject({ state: 'ok', target: { agentId: AGENT_ID, agentName: 'Invoices', verdict: 'not_kit_agent' } })
    located.missing = true
    expect(await resolve()).toMatchObject({ state: 'ok', target: { agentId: AGENT_ID, agentName: null, verdict: 'not_kit_agent' } })
  })

  it('no_agent: no agent picked', async () => {
    expect(await resolve(null)).toMatchObject({ state: 'ok', target: { agentId: null, agentName: null, verdict: 'no_agent' } })
    expect(await skillLinkService.resolve(USER, { origin: HOST, packageId: PACKAGE_ID })).toMatchObject({ target: { verdict: 'no_agent' } })
  })

  it('clash: the agent already has a skill of that name', async () => {
    mkdirSync(join(agentDir, 'skills', 'erp-lookup'), { recursive: true })
    expect(await resolve()).toMatchObject({ state: 'ok', target: { verdict: 'clash' } })
  })

  it('refuses an origin or package id the grammar would not have produced, without reading', async () => {
    expect(await resolve(AGENT_ID, 'http://cinna.test')).toEqual({ state: 'not_connected', host: null, origin: null })
    expect(await skillLinkService.resolve(USER, { origin: HOST, packageId: '../x', agentId: AGENT_ID })).toEqual({
      state: 'no_access',
      host: 'cinna.test',
      origin: HOST
    })
    expect(refresh).not.toHaveBeenCalled()
  })
})

describe('skillLinkService.resolve on a server with two origins (web app and backend)', () => {
  const BACKEND = 'http://localhost:8000'
  const WEB = 'http://localhost:5173'
  /** What core's `/.well-known/cinna-desktop` sends: endpoints on both origins, `web_origin` on newer cores. */
  const docOf = (over: Record<string, unknown> = {}) => ({
    authorization_endpoint: `${WEB}/oauth/authorize`,
    token_endpoint: `${BACKEND}/api/v1/oauth/token`,
    userinfo_endpoint: `${BACKEND}/api/v1/oauth/userinfo`,
    web_origin: WEB,
    ...over
  })
  const discoveredUrls = () => discover.mock.calls.map(([url]) => url)
  /** Endpoints that name `origin` only, for a server with no second origin. */
  const plainDoc = (origin: string) => ({ authorization_endpoint: `${origin}/a`, token_endpoint: `${origin}/t`, userinfo_endpoint: `${origin}/u` })
  const onServer = (stored: string, doc: unknown = docOf()) => {
    hosts.active = stored
    users.rows = [{ id: PROFILE, type: 'cinna_user', displayName: 'Me at work', cinnaServerUrl: `${stored}/` }]
    discovery.docs[`${stored}/`] = doc
  }

  it('exact match asks no discovery at all', async () => {
    onServer(BACKEND)
    expect(await resolve(AGENT_ID, BACKEND)).toMatchObject({ state: 'ok', origin: BACKEND })
    users.rows.push({ id: OTHER, type: 'cinna_user', displayName: 'Me at Acme', cinnaServerUrl: OTHER_HOST })
    expect(await resolve(AGENT_ID, OTHER_HOST)).toMatchObject({ state: 'other_profile' })
    expect(discover).not.toHaveBeenCalled()
  })

  it('a web-app link on a profile stored as the backend → ok, naming the profile’s server', async () => {
    onServer(BACKEND)
    expect(await resolve(AGENT_ID, WEB)).toMatchObject({ state: 'ok', origin: BACKEND, host: 'localhost:8000', serverGiven: true, target: { verdict: 'ok' } })
    expect(refresh).toHaveBeenCalledWith(PROFILE)
    // Only the profile's own server was asked, never the origin the link names.
    expect(discoveredUrls()).toEqual([`${BACKEND}/`])
  })

  it('a backend link on a profile stored as the web app → ok through the endpoints, even without web_origin', async () => {
    onServer(WEB, docOf({ web_origin: undefined }))
    expect(await resolve(AGENT_ID, BACKEND)).toMatchObject({ state: 'ok', origin: WEB, host: 'localhost:5173' })
    expect(discoveredUrls()).toEqual([`${WEB}/`])
  })

  it('already_added keeps the profile’s server too', async () => {
    onServer(BACKEND)
    writeManifest({ catalog_skills: [pinOf(3)] })
    expect(await resolve(AGENT_ID, WEB)).toMatchObject({ state: 'already_added', origin: BACKEND, host: 'localhost:8000' })
  })

  it('other_profile: another profile’s server answers on the link’s origin', async () => {
    users.rows.push({ id: OTHER, type: 'cinna_user', displayName: 'Me at Acme', cinnaServerUrl: `${BACKEND}/` })
    discovery.docs[`${HOST}/`] = docOf({ authorization_endpoint: `${HOST}/a`, token_endpoint: `${HOST}/t`, userinfo_endpoint: `${HOST}/u`, web_origin: undefined })
    discovery.docs[`${BACKEND}/`] = docOf()
    expect(await resolve(AGENT_ID, WEB)).toEqual({
      state: 'other_profile',
      host: 'localhost:8000',
      origin: BACKEND,
      profileId: OTHER,
      profileName: 'Me at Acme',
      title: null
    })
    expect(refresh).not.toHaveBeenCalled()
    expect(discoveredUrls().sort()).toEqual([`${BACKEND}/`, `${HOST}/`])
  })

  it('offline, not not_connected, when the active profile’s discovery fails: Try again on its server', async () => {
    hosts.active = BACKEND
    users.rows = [{ id: PROFILE, type: 'cinna_user', displayName: 'Me at work', cinnaServerUrl: `${BACKEND}/` }]
    expect(await resolve(AGENT_ID, WEB)).toEqual({ state: 'offline', host: 'localhost:8000', origin: BACKEND })
    expect(discoveredUrls()).toEqual([`${BACKEND}/`])
    expect(refresh).not.toHaveBeenCalled()
  })

  it('offline on the active server, not other_profile, when the active profile’s discovery fails and another profile claims the origin', async () => {
    users.rows.push({ id: OTHER, type: 'cinna_user', displayName: 'Me at Acme', cinnaServerUrl: `${BACKEND}/` })
    discovery.docs[`${BACKEND}/`] = docOf()
    expect(await resolve(AGENT_ID, WEB)).toMatchObject({ state: 'offline', origin: HOST })
    expect(discoveredUrls()).toContain(`${HOST}/`)
  })

  it('offline on the link’s origin when only another profile’s discovery fails', async () => {
    onServer(BACKEND, plainDoc(BACKEND))
    users.rows.push({ id: OTHER, type: 'cinna_user', displayName: 'Me at Acme', cinnaServerUrl: OTHER_HOST })
    expect(await resolve(AGENT_ID, WEB)).toEqual({ state: 'offline', host: 'localhost:5173', origin: WEB })
  })

  it('not_connected when the profile’s server names other origins only', async () => {
    onServer(BACKEND, docOf({ web_origin: 'https://dashboard.example.com', authorization_endpoint: `${BACKEND}/a` }))
    expect(await resolve(AGENT_ID, WEB)).toEqual({ state: 'not_connected', host: 'localhost:5173', origin: WEB })
  })

  it('authorization_endpoint alone does not claim an origin: a shared identity provider is no match', async () => {
    onServer(BACKEND, plainDoc(BACKEND))
    discovery.docs[`${BACKEND}/`] = { ...plainDoc(BACKEND), authorization_endpoint: `${WEB}/oauth/authorize` }
    expect(await resolve(AGENT_ID, WEB)).toEqual({ state: 'not_connected', host: 'localhost:5173', origin: WEB })
  })

  it('two other profiles claiming the link’s origin match neither: not_connected, never first-wins', async () => {
    onServer(HOST, plainDoc(HOST))
    users.rows.push(
      { id: OTHER, type: 'cinna_user', displayName: 'Me at Acme', cinnaServerUrl: `${BACKEND}/` },
      { id: 'profile-third', type: 'cinna_user', displayName: 'Me at Beta', cinnaServerUrl: OTHER_HOST }
    )
    discovery.docs[`${BACKEND}/`] = docOf()
    discovery.docs[OTHER_HOST] = { ...plainDoc(OTHER_HOST), web_origin: WEB }
    expect(await resolve(AGENT_ID, WEB)).toEqual({ state: 'not_connected', host: 'localhost:5173', origin: WEB })
  })

  it('the active profile’s claim wins over other profiles claiming the same origin', async () => {
    onServer(BACKEND)
    users.rows.push({ id: OTHER, type: 'cinna_user', displayName: 'Me at Acme', cinnaServerUrl: OTHER_HOST })
    discovery.docs[OTHER_HOST] = { ...plainDoc(OTHER_HOST), web_origin: WEB }
    expect(await resolve(AGENT_ID, WEB)).toMatchObject({ state: 'ok', origin: BACKEND })
  })

  it('offline, not a hang, when the profile’s discovery never answers', async () => {
    onServer(BACKEND)
    discovery.hang.add(`${BACKEND}/`)
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    try {
      const answer = resolve(AGENT_ID, WEB)
      await vi.advanceTimersByTimeAsync(DISCOVERY_WAIT_MS)
      expect(await answer).toEqual({ state: 'offline', host: 'localhost:8000', origin: BACKEND })
    } finally {
      vi.useRealTimers()
    }
  })

  it('asks every profile’s server at once: two that never answer cost one wait, not two', async () => {
    onServer(BACKEND)
    users.rows.push({ id: OTHER, type: 'cinna_user', displayName: 'Me at Acme', cinnaServerUrl: OTHER_HOST })
    discovery.hang.add(`${BACKEND}/`).add(OTHER_HOST)
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    try {
      let settled = false
      const answer = resolve(AGENT_ID, WEB).finally(() => {
        settled = true
      })
      await vi.advanceTimersByTimeAsync(DISCOVERY_WAIT_MS)
      expect(settled).toBe(true)
      expect(await answer).toEqual({ state: 'offline', host: 'localhost:8000', origin: BACKEND })
      // Each request was handed a signal, and it was aborted at the wait.
      expect(discover.mock.calls.map(([, signal]) => signal?.aborted)).toEqual([true, true])
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('skillLinkService.installOrigin', () => {
  it('the web app’s origin when the server sends one, else the stored origin', async () => {
    users.rows = [{ id: PROFILE, type: 'cinna_user', displayName: 'Me at work', cinnaServerUrl: 'http://localhost:8000/' }]
    discovery.docs['http://localhost:8000/'] = {
      authorization_endpoint: 'http://localhost:8000/a',
      token_endpoint: 'http://localhost:8000/t',
      userinfo_endpoint: 'http://localhost:8000/u',
      web_origin: 'http://localhost:5173'
    }
    expect(await skillLinkService.installOrigin()).toEqual({ origin: 'http://localhost:5173', fromDiscovery: true })
    discovery.docs = {}
    // A fallback, said to be one, so the renderer asks again later.
    expect(await skillLinkService.installOrigin()).toEqual({ origin: 'http://localhost:8000', fromDiscovery: false })
  })

  it('null with no Cinna profile active', async () => {
    users.rows = [{ id: PROFILE, type: 'local_user', displayName: 'Local', cinnaServerUrl: null }]
    expect(await skillLinkService.installOrigin()).toEqual({ origin: null, fromDiscovery: false })
    expect(discover).not.toHaveBeenCalled()
  })
})
