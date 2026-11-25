import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { request as httpRequest } from 'node:http'
import { createCredentialTokenServer, type CredentialTokenServer } from '../serviceCredentials/tokenServer'
import { githubHolderOf, githubLoopbackRoutes, GITHUB_COVERAGE_DEADLINE_MS, GITHUB_MESSAGES, GITHUB_TOKEN_ROUTE_BUDGET_MS } from './githubLoopback'
import { GITHUB_HTTP_TIMEOUT_MS } from './githubApi'
import { GH_TOKEN_MAX_TIME_S } from '../../shell/ghShim'
import { turnLock } from '../localAgents/turnLock'
import { API, WEB, connected, makeService } from './testSupport/fakeGithub'
import { clearCredentialRedaction } from '../../security/serviceCredentialRedaction'

/** A raw request, so Host and Origin are exactly what the test says. */
function call(port: number, options: { path?: string; host?: string; headers?: Record<string, string>; body?: string }): Promise<{ status: number; body: any; headers: Record<string, unknown> }> {
  return new Promise((resolve, reject) => {
    const req = httpRequest({ host: '127.0.0.1', port, method: 'POST', path: options.path ?? '/github/token',
      headers: { host: options.host ?? `127.0.0.1:${port}`, 'content-type': 'application/json', ...options.headers } }, res => {
      const chunks: Buffer[] = []
      res.on('data', c => chunks.push(c))
      res.on('end', () => { const text = Buffer.concat(chunks).toString(); resolve({ status: res.statusCode!, body: text ? JSON.parse(text) : null, headers: res.headers }) })
    })
    req.on('error', reject)
    req.end(options.body ?? '{}')
  })
}

describe('GitHub loopback routes', () => {
  const live = new Set<string>(), locked = new Set<string>(), gone = new Set<string>()
  /** Folder agents are shared; each test agent works for the profile named here. */
  const profileOf: Record<string, string> = { 'folder:a': 'user-a', 'folder:b': 'user-b' }
  let server: CredentialTokenServer, port: number, t: ReturnType<typeof makeService>
  const auth = (agentId: string) => ({ authorization: `Bearer ${server.bearer(agentId)}` })

  beforeEach(async () => {
    process.env.CINNA_GITHUB_WEB_URL = WEB
    process.env.CINNA_GITHUB_API_URL = API
    live.clear(); locked.clear(); gone.clear()
    t = makeService({ access: { agentHolder: id => (profileOf[id] ? { userId: profileOf[id], chatless: null } : null), available: id => !locked.has(id) && !gone.has(id), exists: id => !gone.has(id) } })
    t.storage.seed('user-a', connected())
    t.github.on('/user/installations?per_page=100', { json: { installations: [{ id: 7, account: { login: 'acme', type: 'Organization', id: 70 }, repository_selection: 'selected' }] } })
    t.github.on('/user/installations/7/repositories?per_page=100', { json: { repositories: [{ full_name: 'acme/shop' }] } })
    server = createCredentialTokenServer({ live: id => live.has(id), issue: vi.fn() })
    for (const [path, handle] of Object.entries(githubLoopbackRoutes(t.service))) server.route(path, handle)
    port = Number(new URL(await server.start()).port)
    live.add('folder:a'); live.add('folder:b')
  })
  afterEach(async () => {
    await server.close()
    delete process.env.CINNA_GITHUB_WEB_URL
    delete process.env.CINNA_GITHUB_API_URL
    clearCredentialRedaction()
  })

  it('answers a held agent with its profile’s token and commit identity, no-store, the name made shell-safe', async () => {
    const res = await call(port, { headers: auth('folder:a') })
    expect(res.status).toBe(200)
    expect(res.headers['cache-control']).toBe('no-store')
    expect(res.headers.connection).toBe('close')
    expect(res.body).toEqual({ token: 'ghu_access_OLD_0000000000', expires_at: expect.any(Number), login: 'alice', name: 'Alice A Doe', email: '42+alice@users.noreply.github.com' })
    // Covered repo (with .git, any case): the token. Uncovered: Allow access. Invalid: treated as absent.
    expect((await call(port, { headers: auth('folder:a'), body: '{"repo":"ACME/shop.git"}' })).body.token).toBe('ghu_access_OLD_0000000000')
    expect((await call(port, { headers: auth('folder:a'), body: '{"repo":"acme/private"}' })).body).toEqual({ needed: 'install', message: GITHUB_MESSAGES.install('acme/private'), repo: 'acme/private' })
    expect((await call(port, { headers: auth('folder:a'), body: '{"repo":"acme/x y"}' })).body.token).toBe('ghu_access_OLD_0000000000')
    expect(t.log.text()).not.toContain('ghu_access_OLD_0000000000')
  })

  it('an uncovered public repo: the token for a gh read; Allow access for git, a write, or no via (fail closed); private: Allow access', async () => {
    t.github.on(`${API}/repos/acme/site`, { json: { full_name: 'acme/site', private: false } })
    t.github.on(`${API}/repos/acme/inner`, { json: { full_name: 'acme/inner', private: true } })
    const ask = async (body: Record<string, unknown>) => (await call(port, { headers: auth('folder:a'), body: JSON.stringify(body) })).body
    const install = (repo: string) => ({ needed: 'install', message: GITHUB_MESSAGES.install(repo), repo })
    expect((await ask({ repo: 'acme/site', via: 'gh' })).token).toBe('ghu_access_OLD_0000000000')
    expect((await ask({ repo: 'acme/site', via: 'gh' })).token).toBe('ghu_access_OLD_0000000000')
    expect(await ask({ repo: 'acme/site', via: 'git' })).toEqual(install('acme/site'))
    expect(await ask({ repo: 'acme/site', via: 'write' })).toEqual(install('acme/site'))
    expect(await ask({ repo: 'acme/site' })).toEqual(install('acme/site'))
    expect(await ask({ repo: 'acme/site', via: 'other' })).toEqual(install('acme/site'))
    // Read once for both gh requests.
    expect(t.github.count('/repos/acme/site')).toBe(1)
    // Private: 404 (the fake's default) or private: true.
    expect(await ask({ repo: 'acme/private', via: 'gh' })).toEqual(install('acme/private'))
    expect(await ask({ repo: 'acme/inner', via: 'gh' })).toEqual(install('acme/inner'))
    // Unknown visibility (a 403 rate limit, 5xx) for a gh read: the token, and asked again next time.
    t.github.on(`${API}/repos/acme/limited`, { status: 403, json: { message: 'API rate limit exceeded' } })
    t.github.on(`${API}/repos/acme/flaky`, { status: 503, json: {} })
    for (const repo of ['acme/limited', 'acme/flaky']) {
      expect((await ask({ repo, via: 'gh' })).token).toBe('ghu_access_OLD_0000000000')
      expect((await ask({ repo, via: 'gh' })).token).toBe('ghu_access_OLD_0000000000')
      expect(await ask({ repo, via: 'write' })).toEqual(install(repo))
      expect(t.github.count(`/repos/${repo}`)).toBe(2)
    }
    // A covered repo never asks for its visibility.
    expect((await ask({ repo: 'acme/shop', via: 'git' })).token).toBe('ghu_access_OLD_0000000000')
    expect(t.github.count('/repos/acme/shop')).toBe(0)
    // An install need for a public repo is still recorded as before.
    await call(port, { path: '/github/needed', headers: auth('folder:a'), body: '{"kind":"install","repo":"acme/site"}' })
    expect((await t.service.status('user-a')).needs).toMatchObject([{ key: 'install:acme', repos: ['acme/site'] }])
  })

  it('a dead refresh token: reconnect, the account expired, but no row until the wrapper reports it', async () => {
    t.storage.seed('user-a', connected({ expiresAt: Date.now() + 1000 }))
    t.github.on('/login/oauth/access_token', { json: { error: 'bad_refresh_token' } })
    expect((await call(port, { headers: auth('folder:a') })).body).toEqual({ needed: 'reconnect', message: GITHUB_MESSAGES.reconnect })
    const status = await t.service.status('user-a')
    expect(status.account?.state).toBe('expired')
    expect(status.needs).toEqual([])
    await call(port, { path: '/github/needed', headers: auth('folder:a'), body: '{"kind":"reconnect"}' })
    expect((await t.service.status('user-a')).needs).toEqual([{ key: 'account', kind: 'reconnect', agentIds: ['folder:a'] }])
  })

  describe('the coverage deadline', () => {
    /** Hold every GitHub call whose URL contains `part` until released. */
    function slow(part: string): () => void {
      let release!: () => void
      const gate = new Promise<void>(r => { release = r })
      const original = t.github.fetch.getMockImplementation()!
      t.github.fetch.mockImplementation(async (url: string, init?: RequestInit) => { if (url.includes(part)) await gate; return original(url, init) })
      return release
    }
    const route = (options = { coverageDeadlineMs: 50 }) => githubLoopbackRoutes(t.service, options)['/github/token']

    it('installations not read in time count as unknown coverage: the token, for gh and for git; the read goes on and fills the cache', async () => {
      const release = slow('/user/installations')
      const started = Date.now()
      const [gh, git] = await Promise.all([route()('folder:a', { repo: 'acme/other', via: 'gh' }), route()('folder:a', { repo: 'acme/other', via: 'git' })])
      expect(Date.now() - started).toBeLessThan(2000)
      expect((gh.body as { token?: string }).token).toBe('ghu_access_OLD_0000000000')
      expect((git.body as { token?: string }).token).toBe('ghu_access_OLD_0000000000')
      release()
      await vi.waitFor(async () => expect((await t.service.status('user-a')).account?.coverageFetchedAt).not.toBeNull())
      expect((await route()('folder:a', { repo: 'acme/other', via: 'git' })).body).toMatchObject({ needed: 'install' })
    })

    it('a visibility not read in time counts as unknown coverage for gh: the token; git needs no visibility: Allow access', async () => {
      await t.service.checkAgain('user-a')
      const release = slow('/repos/acme/site')
      t.github.on(`${API}/repos/acme/site`, { json: { private: true } })
      const started = Date.now()
      expect((await route()('folder:a', { repo: 'acme/site', via: 'gh' })).body).toMatchObject({ token: 'ghu_access_OLD_0000000000' })
      expect(Date.now() - started).toBeLessThan(2000)
      expect((await route()('folder:a', { repo: 'acme/site', via: 'git' })).body).toMatchObject({ needed: 'install' })
      release()
      // Read now (cached): private, so Allow access.
      await vi.waitFor(async () => expect((await route()('folder:a', { repo: 'acme/site', via: 'gh' })).body).toMatchObject({ needed: 'install' }))
    })

    it('the deadline is never past the whole route budget, and the defaults fit the wrapper wait', async () => {
      const release = slow('/user/installations')
      // The budget is already spent (a slow refresh): no wait at all.
      expect((await githubLoopbackRoutes(t.service, { coverageDeadlineMs: 60_000, routeBudgetMs: 0 })['/github/token']('folder:a', { repo: 'acme/other' })).body).toMatchObject({ token: expect.any(String) })
      release()
      expect(GITHUB_COVERAGE_DEADLINE_MS).toBe(12_000)
      expect(GITHUB_TOKEN_ROUTE_BUDGET_MS).toBeLessThan(GH_TOKEN_MAX_TIME_S * 1000)
      expect(GITHUB_HTTP_TIMEOUT_MS + GITHUB_COVERAGE_DEADLINE_MS).toBeLessThanOrEqual(GITHUB_TOKEN_ROUTE_BUDGET_MS)
    })
  })

  it('another agent’s bearer reaches only that agent’s profile', async () => {
    const res = await call(port, { headers: auth('folder:b') })
    expect(res.body).toEqual({ needed: 'sign_in', message: GITHUB_MESSAGES.sign_in })
    expect(JSON.stringify(res.body)).not.toContain('ghu_')
  })

  it('a profile that is gone answers as no profile: sign_in, nothing recorded, never the locked sentence', async () => {
    gone.add('user-a')
    expect((await call(port, { headers: auth('folder:a') })).body).toEqual({ needed: 'sign_in', message: GITHUB_MESSAGES.sign_in })
    await call(port, { path: '/github/needed', headers: auth('folder:a'), body: '{"kind":"sign_in"}' })
    gone.delete('user-a')
    expect((await t.service.status('user-a')).needs).toEqual([])
  })

  it('a locked profile is told so (nothing recorded); no active profile needs sign_in', async () => {
    locked.add('user-a')
    expect((await call(port, { headers: auth('folder:a') })).body).toEqual({ unavailable: true, message: GITHUB_MESSAGES.locked })
    expect(GITHUB_MESSAGES.locked).toBe("This agent's Cinna profile is locked. Ask the user to unlock it, then run this command again.")
    await call(port, { path: '/github/needed', headers: auth('folder:a'), body: '{"kind":"sign_in"}' })
    locked.delete('user-a')
    expect((await t.service.status('user-a')).needs).toEqual([])
    live.add('folder:z')
    expect((await call(port, { headers: auth('folder:z') })).body.needed).toBe('sign_in')
  })

  it('answers reconnect for an expired sign-in and unavailable when GitHub cannot refresh', async () => {
    t.storage.seed('user-b', connected({ state: 'expired', accessToken: null, refreshToken: null }))
    expect((await call(port, { headers: auth('folder:b') })).body).toEqual({ needed: 'reconnect', message: GITHUB_MESSAGES.reconnect })
    t.storage.seed('user-a', connected({ expiresAt: Date.now() + 1000 }))
    t.github.on('/login/oauth/access_token', { status: 503, json: {} })
    expect((await call(port, { headers: auth('folder:a') })).body).toEqual({ unavailable: true, message: GITHUB_MESSAGES.unavailable })
  })

  it('keeps the listener’s refusals: no bearer or not held 401, foreign Host or any Origin 403, oversize 413, not an object 422, unknown path 404', async () => {
    expect((await call(port, {})).status).toBe(401)
    expect((await call(port, { headers: { authorization: 'Bearer nope' } })).status).toBe(401)
    live.delete('folder:a')
    expect((await call(port, { headers: auth('folder:a') })).status).toBe(401)
    live.add('folder:a')
    expect((await call(port, { headers: auth('folder:a'), host: `evil.test:${port}` })).status).toBe(403)
    expect((await call(port, { headers: { ...auth('folder:a'), origin: 'http://127.0.0.1' } })).status).toBe(403)
    expect((await call(port, { headers: auth('folder:a'), body: JSON.stringify({ repo: 'x'.repeat(5000) }) })).status).toBe(413)
    expect((await call(port, { headers: auth('folder:a'), body: '[1]' })).status).toBe(422)
    expect((await call(port, { headers: auth('folder:a'), body: 'not json' })).status).toBe(422)
    expect((await call(port, { headers: auth('folder:a'), path: '/github/other' })).status).toBe(404)
    expect((await call(port, { headers: auth('folder:a'), path: '/github/token?x=1' })).status).toBe(404)
  })

  it('records what is needed for the agent’s profile, and passes gh_missing to its hook', async () => {
    const ghMissing = vi.fn(async () => true)
    t.service.setOnGhMissing(ghMissing)
    expect((await call(port, { path: '/github/needed', headers: auth('folder:b'), body: '{"kind":"sign_in"}' })).body).toEqual({ ok: true })
    expect((await t.service.status('user-b')).needs).toEqual([{ key: 'account', kind: 'sign_in', agentIds: ['folder:b'] }])
    expect((await t.service.status('user-a')).needs).toEqual([])
    await t.service.checkAgain('user-a')
    expect((await call(port, { path: '/github/needed', headers: auth('folder:a'), body: '{"kind":"install","repo":"acme/private"}' })).body).toEqual({ ok: true })
    expect((await t.service.status('user-a')).needs).toEqual([{ key: 'install:acme', kind: 'install', owner: 'acme', repos: ['acme/private'], installUrl: 'https://github.com/organizations/acme/settings/installations/7', agentIds: ['folder:a'] }])
    // An install need needs a repo.
    await call(port, { path: '/github/needed', headers: auth('folder:a'), body: '{"kind":"install"}' })
    expect((await t.service.status('user-a')).needs).toHaveLength(1)
    // gh_missing answers whether a managed gh install is running (the wrapper's two sentences).
    expect((await call(port, { path: '/github/needed', headers: auth('folder:a'), body: '{"kind":"gh_missing"}' })).body).toEqual({ ok: true, installing: true })
    expect(ghMissing).toHaveBeenCalledWith('folder:a')
    ghMissing.mockResolvedValueOnce(false)
    expect((await call(port, { path: '/github/needed', headers: auth('folder:a'), body: '{"kind":"gh_missing"}' })).body).toEqual({ ok: true, installing: false })
    ghMissing.mockRejectedValueOnce(new Error('boom'))
    expect((await call(port, { path: '/github/needed', headers: auth('folder:a'), body: '{"kind":"gh_missing"}' })).body).toEqual({ ok: true, installing: false })
    expect((await call(port, { path: '/github/needed', headers: auth('folder:a'), body: '{"kind":"admin"}' })).status).toBe(422)
    live.delete('folder:b')
    expect((await call(port, { path: '/github/needed', headers: auth('folder:b'), body: '{"kind":"sign_in"}' })).status).toBe(401)
  })

  it('every message is safe for the wrapper’s sed: no quote, backslash or newline', () => {
    for (const message of [GITHUB_MESSAGES.sign_in, GITHUB_MESSAGES.reconnect, GITHUB_MESSAGES.unavailable, GITHUB_MESSAGES.otherProfile, GITHUB_MESSAGES.locked, GITHUB_MESSAGES.install('a.b/c_d-e')]) expect(message).not.toMatch(/["\\\n\r]/)
  })
})

/**
 * Folder agents are shared by every profile: a request is served for the profile of what holds the
 * agent now (the hub's wiring: `githubHolderOf(turnLock.sharedOrigins(id), active)`), never for a
 * profile the user switched to while the turn or command was running.
 */
describe('GitHub loopback: the profile of what holds the agent', () => {
  let server: CredentialTokenServer, port: number, t: ReturnType<typeof makeService>
  let active: string | null
  const locked = new Set<string>()
  const A_TOKEN = 'ghu_access_OLD_0000000000', B_TOKEN = 'ghu_access_BOB_0000000000'
  const auth = (agentId: string) => ({ authorization: `Bearer ${server.bearer(agentId)}` })
  const token = async () => (await call(port, { headers: auth('folder:a') })).body

  beforeEach(async () => {
    turnLock.releaseAll()
    active = 'user-a'
    locked.clear()
    t = makeService({ access: { agentHolder: id => githubHolderOf(turnLock.sharedOrigins(id), () => active), available: id => !locked.has(id) } })
    t.storage.seed('user-a', connected())
    t.storage.seed('user-b', connected({ accessToken: B_TOKEN, login: 'bob', id: 43, email: '43+bob@users.noreply.github.com' }))
    // The listener's own held rule, as the credential service installs it.
    server = createCredentialTokenServer({ live: id => turnLock.isLocked(id) && !turnLock.isExclusivelyLocked(id), issue: vi.fn() })
    for (const [path, handle] of Object.entries(githubLoopbackRoutes(t.service))) server.route(path, handle)
    port = Number(new URL(await server.start()).port)
  })
  afterEach(async () => {
    turnLock.releaseAll()
    await server.close()
    clearCredentialRedaction()
  })

  it('a turn started in profile A keeps A’s account when the active profile switches to B mid-turn', async () => {
    const answers = await turnLock.withSharedLock('folder:a', 'turn', async () => {
      const before = await token()
      active = 'user-b'
      return [before, await token()]
    }, undefined, { userId: 'user-a' })
    expect(answers.map(a => a.token)).toEqual([A_TOKEN, A_TOKEN])
    expect(answers.map(a => a.login)).toEqual(['alice', 'alice'])
    expect(JSON.stringify(answers)).not.toContain(B_TOKEN)
  })

  it('a kit command started by A likewise; its need is recorded under A, as one a run with no chat hit', async () => {
    const handle = turnLock.acquireShared('folder:a', 'command', { userId: 'user-a', chatless: 'command' })
    active = 'user-b'
    expect((await token()).token).toBe(A_TOKEN)
    handle.release()
    // Started by C, who never signed in: sign_in for C, never A’s (active) token; the need is C’s.
    active = 'user-a'
    const other = turnLock.acquireShared('folder:a', 'command', { userId: 'user-c', chatless: 'schedule' })
    expect(await token()).toEqual({ needed: 'sign_in', message: GITHUB_MESSAGES.sign_in })
    await call(port, { path: '/github/needed', headers: auth('folder:a'), body: '{"kind":"sign_in"}' })
    other.release()
    expect((await t.service.status('user-c')).needs).toEqual([{ key: 'account', kind: 'sign_in', agentIds: ['folder:a'], chatlessAgentIds: ['folder:a'] }])
    expect((await t.service.status('user-a')).needs).toEqual([])
  })

  it('a chat’s turn records its need with no chatless agent', async () => {
    await turnLock.withSharedLock('folder:a', 'turn', async () => {
      await call(port, { path: '/github/needed', headers: auth('folder:a'), body: '{"kind":"sign_in"}' })
    }, undefined, { userId: 'user-c' })
    expect((await t.service.status('user-c')).needs).toEqual([{ key: 'account', kind: 'sign_in', agentIds: ['folder:a'] }])
    expect(t.service.chatlessNeeds('user-c')).toEqual([])
  })

  it('a hold that recorded no profile answers for the active profile', async () => {
    active = 'user-b'
    const bare = turnLock.acquireShared('folder:a', 'command')
    expect((await token()).token).toBe(B_TOKEN)
    bare.release()
    const unnamed = turnLock.acquireShared('folder:a', 'turn', { userId: null })
    expect((await token()).token).toBe(B_TOKEN)
    unnamed.release()
  })

  it('holds working for two profiles at once: the token is refused as unavailable, and no need is recorded', async () => {
    t.storage.seed('user-a', connected({ state: 'expired', accessToken: null, refreshToken: null }))
    const first = turnLock.acquireShared('folder:a', 'turn', { userId: 'user-a' })
    const second = turnLock.acquireShared('folder:a', 'command', { userId: 'user-b', chatless: 'command' })
    expect(await token()).toEqual({ unavailable: true, message: GITHUB_MESSAGES.otherProfile })
    await call(port, { path: '/github/needed', headers: auth('folder:a'), body: '{"kind":"reconnect"}' })
    expect((await t.service.status('user-a')).needs).toEqual([])
    expect((await t.service.status('user-b')).needs).toEqual([])
    second.release()
    // One profile again: its turn is served.
    expect(await token()).toEqual({ needed: 'reconnect', message: GITHUB_MESSAGES.reconnect })
    first.release()
  })

  it('a newest hold that recorded no origin works for the active profile, not an older hold’s', async () => {
    const turn = turnLock.acquireShared('folder:a', 'turn', { userId: 'user-a' })
    const plain = turnLock.acquireShared('folder:a', 'dashboard')
    active = 'user-b'
    expect((await token()).message).toBe(GITHUB_MESSAGES.otherProfile)
    active = 'user-a'
    expect((await token()).token).toBe(A_TOKEN)
    plain.release(); turn.release()
  })

  it('several holds of one profile: served, and chatless only when no hold is a chat turn', async () => {
    t.storage.seed('user-a', connected({ state: 'expired', accessToken: null, refreshToken: null }))
    const turn = turnLock.acquireShared('folder:a', 'turn', { userId: 'user-a' })
    const command = turnLock.acquireShared('folder:a', 'command', { userId: 'user-a', chatless: 'schedule' })
    active = 'user-b'
    // A chat's turn holds it too (older): the chat shows the row, no Inbox card.
    await call(port, { path: '/github/needed', headers: auth('folder:a'), body: '{"kind":"reconnect"}' })
    expect((await t.service.status('user-a')).needs).toEqual([{ key: 'account', kind: 'reconnect', agentIds: ['folder:a'] }])
    turn.release()
    // Only chatless holds now.
    const refresh = turnLock.acquireShared('folder:a', 'command', { userId: 'user-a', chatless: 'command' })
    await call(port, { path: '/github/needed', headers: auth('folder:a'), body: '{"kind":"reconnect"}' })
    expect((await t.service.status('user-a')).needs).toEqual([{ key: 'account', kind: 'reconnect', agentIds: ['folder:a'], chatlessAgentIds: ['folder:a'] }])
    command.release(); refresh.release()
  })

  it('a recorded profile that cannot serve is told it is locked, never given the active profile’s token', async () => {
    locked.add('user-a')
    active = 'user-b'
    const handle = turnLock.acquireShared('folder:a', 'turn', { userId: 'user-a' })
    expect(await token()).toEqual({ unavailable: true, message: GITHUB_MESSAGES.locked })
    // Nor is a need recorded for anyone.
    await call(port, { path: '/github/needed', headers: auth('folder:a'), body: '{"kind":"sign_in"}' })
    handle.release()
    expect((await t.service.status('user-b')).needs).toEqual([])
  })
})
