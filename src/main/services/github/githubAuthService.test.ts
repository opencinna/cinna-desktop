import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { API, WEB, connected, makeService } from './testSupport/fakeGithub'
import { MIN_TOKEN_TTL_MS, VISIBILITY_CACHE_MAX } from './githubAuthService'
import { GITHUB_HTTP_TIMEOUT_MS } from './githubApi'
import { clearCredentialRedaction, redactCredentialText } from '../../security/serviceCredentialRedaction'

const U = 'user-1'
const DEVICE = { device_code: 'dc_secret_device_code_0001', user_code: 'ABCD-1234', verification_uri: `${WEB}/login/device`, expires_in: 900, interval: 5 }
const TOKENS = { access_token: 'ghu_access_NEW_1111111111', expires_in: 28800, refresh_token: 'ghr_refresh_NEW_111111111', refresh_token_expires_in: 15897600, token_type: 'bearer', scope: '' }
const USER = { login: 'alice', id: 42, name: 'Alice\n"Doe"\\' }

beforeEach(() => {
  process.env.CINNA_GITHUB_WEB_URL = WEB
  process.env.CINNA_GITHUB_API_URL = API
})
afterEach(() => {
  delete process.env.CINNA_GITHUB_WEB_URL
  delete process.env.CINNA_GITHUB_API_URL
  clearCredentialRedaction()
})

function install(id: number, login: string, type: 'User' | 'Organization', selection: 'all' | 'selected', ownerId = id * 10) {
  return { id, account: { login, type, id: ownerId }, repository_selection: selection }
}

describe('device flow', () => {
  it('polls at the interval, widens it on slow_down, then persists the account before publishing it', async () => {
    const t = makeService()
    const signedIn = vi.fn()
    t.service.setOnSignedIn(signedIn)
    t.github.on('/login/device/code', { json: DEVICE })
    t.github.on('/login/oauth/access_token', { json: { error: 'authorization_pending' } }, { json: { error: 'slow_down' } }, { json: { error: 'authorization_pending' } }, { json: TOKENS })
    t.github.on('/user', { json: USER })
    t.github.on('/user/installations?per_page=100', { json: { total_count: 0, installations: [] } })

    const dto = await t.service.startDeviceFlow(U)
    expect(dto).toEqual({ userCode: 'ABCD-1234', verificationUri: `${WEB}/login/device`, expiresAt: expect.any(Number), state: 'pending' })
    // A second start while it runs answers the same flow.
    expect((await t.service.startDeviceFlow(U)).userCode).toBe('ABCD-1234')
    expect(t.github.count('/login/device/code')).toBe(1)

    await vi.waitFor(() => expect(signedIn).toHaveBeenCalledWith(U))
    expect(t.waits).toEqual([5000, 5000, 10000, 10000])
    const poll = t.github.requests.find(r => r.url.endsWith('/login/oauth/access_token'))!
    expect(Object.fromEntries(poll.form!)).toEqual({ client_id: 'Iv23liFC50gymAL3DTF1', device_code: DEVICE.device_code, grant_type: 'urn:ietf:params:oauth:grant-type:device_code' })
    const stored = t.storage.record(U)
    expect(stored).toMatchObject({ accessToken: TOKENS.access_token, refreshToken: TOKENS.refresh_token, login: 'alice', id: 42, name: 'AliceDoe', email: '42+alice@users.noreply.github.com', state: 'connected' })
    // The start published before anything was stored; every publish after it sees the stored account.
    expect(t.published[0]).toEqual({ userId: U, stored: false })
    expect(t.published.slice(1).every(p => p.stored)).toBe(true)
    expect(t.published.length).toBeGreaterThan(1)
    const status = await t.service.status(U)
    expect(status).toEqual({ account: { login: 'alice', state: 'connected', coverage: [], coverageFetchedAt: expect.any(Number) }, device: null, needs: [], dismissed: [] })
    expect(JSON.stringify(status)).not.toMatch(/ghu_|ghr_|noreply/)
    // Nothing secret reaches the log, and the redaction registry knows every secret.
    for (const secret of [TOKENS.access_token, TOKENS.refresh_token, DEVICE.device_code, stored.email]) expect(t.log.text()).not.toContain(secret)
    for (const secret of [TOKENS.access_token, TOKENS.refresh_token, DEVICE.device_code]) expect(redactCredentialText(`x ${secret}`)).toBe('x ***REDACTED***')
  })

  it.each([
    ['expired_token', 'expired'],
    ['access_denied', 'denied'],
    ['unsupported_grant_type', 'error']
  ])('ends the flow on %s as %s, storing nothing', async (code, state) => {
    const t = makeService()
    t.github.on('/login/device/code', { json: DEVICE })
    t.github.on('/login/oauth/access_token', { json: { error: 'authorization_pending' } }, { json: { error: code } })
    await t.service.startDeviceFlow(U)
    await vi.waitFor(async () => expect((await t.service.status(U)).device?.state).toBe(state))
    expect(t.storage.rows.size).toBe(0)
    expect((await t.service.status(U)).account).toBeNull()
    // A new start begins a new flow.
    await t.service.startDeviceFlow(U)
    expect(t.github.count('/login/device/code')).toBe(2)
  })

  it('stops polling on cancel', async () => {
    const t = makeService()
    t.github.on('/login/device/code', { json: DEVICE })
    t.github.on('/login/oauth/access_token', { json: { error: 'authorization_pending' } })
    await t.service.startDeviceFlow(U)
    await vi.waitFor(() => expect(t.github.count('/login/oauth/access_token')).toBeGreaterThan(2))
    t.service.cancelDeviceFlow(U)
    const polls = t.github.count('/login/oauth/access_token')
    await new Promise(r => setTimeout(r, 20))
    expect(t.github.count('/login/oauth/access_token')).toBeLessThanOrEqual(polls + 1)
    expect((await t.service.status(U)).device).toBeNull()
  })

  it('logs a failed poll with its status and class only, the first one and then at most every 30 s with a count', async () => {
    let clock = 1_000_000_000_000
    const t = makeService({ now: () => clock })
    const signedIn = vi.fn()
    t.service.setOnSignedIn(signedIn)
    t.github.on('/login/device/code', { json: DEVICE })
    t.github.on('/login/oauth/access_token', new Error('ECONNRESET'), { status: 502, json: {} }, new Error('ECONNRESET'), { status: 503, json: {} }, { json: TOKENS })
    t.github.on('/user', { json: USER })
    t.github.on('/user/installations?per_page=100', { json: { installations: [] } })
    const inner = t.github.fetch.getMockImplementation()!
    let polls = 0
    t.github.fetch.mockImplementation(async (input: string, init?: RequestInit) => {
      // The third and later polls come 31 s apart.
      if (input.endsWith('/login/oauth/access_token') && ++polls >= 3) clock += 31_000
      return inner(input, init)
    })
    await t.service.startDeviceFlow(U)
    await vi.waitFor(() => expect(signedIn).toHaveBeenCalledWith(U))
    const logged = (t.log.text().match(/A GitHub sign-in poll failed; still polling/g) ?? []).length
    // Poll 1 logs, poll 2 (same instant) does not, polls 3 and 4 (31 s apart) do.
    expect(logged).toBe(3)
    expect(t.log.text()).toContain('"status":null,"error":"GithubTransientError","failures":1')
    expect(t.log.text()).toContain('"status":503,"error":"GithubTransientError","failures":4')
    for (const secret of [DEVICE.device_code, DEVICE.user_code, TOKENS.access_token]) expect(t.log.text()).not.toContain(secret)
  })

  it('refuses to start for a profile that cannot serve', async () => {
    const t = makeService({ access: { agentHolder: () => ({ userId: U, chatless: null }), available: () => false } })
    await expect(t.service.startDeviceFlow(U)).rejects.toThrow(/locked/)
    expect(t.github.requests).toHaveLength(0)
  })
})

describe('token and refresh', () => {
  it('hands out a token with ten minutes or more left without refreshing, and never refreshes one without expiry', async () => {
    const t = makeService()
    t.storage.seed(U, connected({ expiresAt: Date.now() + MIN_TOKEN_TTL_MS + 60_000 }))
    expect(await t.service.token(U)).toEqual({ kind: 'token', grant: { token: 'ghu_access_OLD_0000000000', expiresAt: expect.any(Number), login: 'alice', name: 'Alice "A" Doe', email: '42+alice@users.noreply.github.com' } })
    t.storage.seed('user-2', connected({ expiresAt: null, refreshToken: null, refreshExpiresAt: null }))
    expect((await t.service.token('user-2')).kind).toBe('token')
    expect(t.github.requests).toHaveLength(0)
  })

  it('refreshes single-flight below ten minutes and persists the rotated pair before answering anyone', async () => {
    const t = makeService()
    t.storage.seed(U, connected({ expiresAt: Date.now() + MIN_TOKEN_TTL_MS - 1000 }))
    t.github.on('/login/oauth/access_token', { json: TOKENS })
    // Read the stored record first, then hold the sealing of the refreshed pair.
    await t.service.status(U)
    const release = t.storage.hold()
    let answered = 0
    const first = t.service.token(U).then(r => { answered++; return r })
    const second = t.service.token(U).then(r => { answered++; return r })
    await vi.waitFor(() => expect(t.github.count('/login/oauth/access_token')).toBe(1))
    await new Promise(r => setTimeout(r, 20))
    expect(answered).toBe(0)
    expect(t.storage.record(U).accessToken).toBe('ghu_access_OLD_0000000000')
    release()
    const [a, b] = await Promise.all([first, second])
    expect(t.storage.record(U)).toMatchObject({ accessToken: TOKENS.access_token, refreshToken: TOKENS.refresh_token, state: 'connected' })
    expect(a).toEqual(b)
    expect(a).toMatchObject({ kind: 'token', grant: { token: TOKENS.access_token } })
    expect(t.github.count('/login/oauth/access_token')).toBe(1)
    const req = t.github.requests[0]
    expect(Object.fromEntries(req.form!)).toEqual({ client_id: 'Iv23liFC50gymAL3DTF1', grant_type: 'refresh_token', refresh_token: 'ghr_refresh_OLD_000000000' })
    expect(req.form!.has('client_secret')).toBe(false)
    // Fresh now: the next call does not refresh.
    await t.service.token(U)
    expect(t.github.count('/login/oauth/access_token')).toBe(1)
    for (const secret of ['ghu_access_OLD_0000000000', 'ghr_refresh_OLD_000000000', TOKENS.access_token, TOKENS.refresh_token]) expect(t.log.text()).not.toContain(secret)
  })

  it.each(['incorrect_client_credentials', 'bad_refresh_token'])('turns %s into Reconnect: expired and published, tokens dropped, no row until the wrapper reports one', async (code) => {
    const t = makeService()
    t.storage.seed(U, connected({ expiresAt: Date.now() + 1000 }))
    t.github.on('/login/oauth/access_token', { json: { error: code, error_description: 'The refresh token passed is incorrect or expired.' } })
    expect(await t.service.token(U)).toEqual({ kind: 'needed', need: 'reconnect' })
    expect(t.storage.record(U)).toMatchObject({ accessToken: null, refreshToken: null, state: 'expired', login: 'alice' })
    const status = await t.service.status(U)
    expect(status.account).toMatchObject({ login: 'alice', state: 'expired' })
    // The wrapper may still fall back to the user's own gh login: the row comes only from /github/needed.
    expect(status.needs).toEqual([])
    expect(t.published.length).toBeGreaterThan(0)
    await t.service.recordNeed(U, 'reconnect', undefined, 'folder:a')
    expect((await t.service.status(U)).needs).toEqual([{ key: 'account', kind: 'reconnect', agentIds: ['folder:a'] }])
    // Later calls answer reconnect without asking GitHub again.
    expect(await t.service.token(U)).toEqual({ kind: 'needed', need: 'reconnect' })
    expect(t.github.count('/login/oauth/access_token')).toBe(1)
  })

  it('answers unavailable, state unchanged, when GitHub cannot be reached or answers 5xx', async () => {
    const t = makeService()
    t.storage.seed(U, connected({ expiresAt: Date.now() + 1000 }))
    t.github.on('/login/oauth/access_token', new Error('ECONNRESET'), { status: 502, json: {} })
    expect(await t.service.token(U)).toEqual({ kind: 'unavailable' })
    expect(await t.service.token(U)).toEqual({ kind: 'unavailable' })
    expect(t.storage.record(U)).toMatchObject({ accessToken: 'ghu_access_OLD_0000000000', state: 'connected' })
    expect((await t.service.status(U)).needs).toEqual([])
  })

  it('a refresh GitHub never answers gives up after the timeout and answers unavailable', async () => {
    const t = makeService()
    t.storage.seed(U, connected({ expiresAt: Date.now() + 1000 }))
    // The timeout signal the call gets, aborted by the test instead of 20 s of waiting.
    const timeouts: number[] = []
    const controller = new AbortController()
    const spy = vi.spyOn(AbortSignal, 'timeout').mockImplementation((ms: number) => { timeouts.push(ms); return controller.signal })
    try {
      t.github.fetch.mockImplementationOnce((_url: string, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new DOMException('The operation timed out.', 'TimeoutError')))
      }))
      const answer = t.service.token(U)
      await vi.waitFor(() => expect(timeouts).toEqual([GITHUB_HTTP_TIMEOUT_MS]))
      controller.abort()
      expect(await answer).toEqual({ kind: 'unavailable' })
      expect(GITHUB_HTTP_TIMEOUT_MS).toBe(20_000)
      expect(t.storage.record(U)).toMatchObject({ accessToken: 'ghu_access_OLD_0000000000', state: 'connected' })
    } finally { spy.mockRestore() }
  })

  it('every GitHub call carries the timeout signal', async () => {
    const t = makeService()
    t.storage.seed(U, connected({ expiresAt: Date.now() + 1000 }))
    t.github.on('/login/oauth/access_token', { json: TOKENS })
    t.github.on('/user/installations?per_page=100', { json: { installations: [install(2, 'acme', 'Organization', 'selected')] } })
    t.github.on('/user/installations/2/repositories?per_page=100', { json: { repositories: [] } })
    t.github.on('/login/device/code', { json: DEVICE })
    await t.service.checkAgain(U)
    await t.service.startDeviceFlow('user-2')
    await vi.waitFor(() => expect(t.github.count('/login/oauth/access_token')).toBeGreaterThan(1))
    const calls = t.github.fetch.mock.calls as unknown as Array<[string, RequestInit | undefined]>
    expect(calls.length).toBeGreaterThan(3)
    for (const [, init] of calls) expect(init?.signal).toBeInstanceOf(AbortSignal)
    t.service.cancelDeviceFlow('user-2')
  })

  it('answers sign_in for no record and for a profile that cannot serve', async () => {
    let available = true
    const t = makeService({ access: { agentHolder: () => ({ userId: U, chatless: null }), available: () => available } })
    expect(await t.service.token(U)).toEqual({ kind: 'needed', need: 'sign_in' })
    t.storage.seed(U, connected())
    available = false
    expect(await t.service.token(U)).toEqual({ kind: 'needed', need: 'sign_in' })
    expect((await t.service.status(U)).account).toBeNull()
  })

  it('signs out locally: record, coverage and needs gone, no revoke call', async () => {
    const t = makeService()
    t.storage.seed(U, connected())
    await t.service.recordNeed(U, 'install', 'acme/shop', 'folder:a')
    t.service.signOut(U)
    expect(t.storage.rows.has(U)).toBe(false)
    expect(await t.service.status(U)).toEqual({ account: null, device: null, needs: [], dismissed: [] })
    expect(t.github.requests.filter(r => r.method !== 'GET')).toHaveLength(0)
  })
})

describe('coverage', () => {
  function withInstallations(t: ReturnType<typeof makeService>) {
    t.storage.seed(U, connected())
    t.github.on('/user/installations?per_page=100', { json: { installations: [install(1, 'alice', 'User', 'all')] }, headers: { link: `<${API}/user/installations?per_page=100&page=2>; rel="next", <${API}/user/installations?per_page=100&page=2>; rel="last"` } })
    t.github.on('/user/installations?per_page=100&page=2', { json: { installations: [install(2, 'acme', 'Organization', 'selected', 900), install(3, 'bob', 'User', 'selected', 30)] } })
    t.github.on('/user/installations/2/repositories?per_page=100', { json: { repositories: [{ full_name: 'acme/shop' }] }, headers: { link: `<${API}/user/installations/2/repositories?per_page=100&page=2>; rel="next"` } })
    t.github.on('/user/installations/2/repositories?per_page=100&page=2', { json: { repositories: [{ full_name: 'acme/Docs' }] } })
    t.github.on('/user/installations/3/repositories?per_page=100', { json: { repositories: [{ full_name: 'bob/site' }] } })
  }

  it('reads every page and answers covered, repo_not_selected (with the configure page) and not_installed', async () => {
    const t = makeService()
    withInstallations(t)
    expect(await t.service.coverageFor(U, 'ACME/shop')).toEqual({ answer: 'covered', installUrl: expect.any(String) })
    expect((await t.service.coverageFor(U, 'acme/docs'))?.answer).toBe('covered')
    expect((await t.service.coverageFor(U, 'alice/anything'))?.answer).toBe('covered')
    expect(await t.service.coverageFor(U, 'acme/secret')).toEqual({ answer: 'repo_not_selected', installUrl: 'https://github.com/organizations/acme/settings/installations/2' })
    expect(await t.service.coverageFor(U, 'bob/blog')).toEqual({ answer: 'repo_not_selected', installUrl: 'https://github.com/settings/installations/3' })
    expect(await t.service.coverageFor(U, 'carol/x')).toEqual({ answer: 'not_installed', installUrl: 'https://github.com/apps/opencinna/installations/new' })
    const status = await t.service.status(U)
    expect(status.account!.coverage).toEqual([
      { installationId: 1, owner: 'alice', ownerType: 'User', ownerId: 10, selection: 'all', repos: [] },
      { installationId: 2, owner: 'acme', ownerType: 'Organization', ownerId: 900, selection: 'selected', repos: ['acme/shop', 'acme/Docs'] },
      { installationId: 3, owner: 'bob', ownerType: 'User', ownerId: 30, selection: 'selected', repos: ['bob/site'] }
    ])
    expect(t.github.requests.every(r => r.auth === 'Bearer ghu_access_OLD_0000000000')).toBe(true)
  })

  it('keeps a definite visibility for a minute (public; private by 404 or private:true); unknown (403, 401, 5xx, no field, network) is not kept', async () => {
    let clock = 1_000_000_000_000
    const t = makeService({ now: () => clock })
    t.storage.seed(U, connected({ expiresAt: null }))
    t.github.on(`${API}/repos/acme/site`, { json: { full_name: 'acme/site', private: false } })
    t.github.on(`${API}/repos/acme/secret`, { status: 404, json: { message: 'Not Found' } })
    t.github.on(`${API}/repos/acme/limited`, { status: 403, json: { message: 'API rate limit exceeded' } })
    t.github.on(`${API}/repos/acme/unauth`, { status: 401, json: {} })
    t.github.on(`${API}/repos/acme/inner`, { json: { private: true } })
    t.github.on(`${API}/repos/acme/odd`, { json: { full_name: 'acme/odd' } })
    t.github.on(`${API}/repos/acme/flaky`, { status: 502, json: {} })
    t.github.on(`${API}/repos/acme/down`, new Error('ECONNRESET'))
    expect(await Promise.all([t.service.visibilityFor(U, 'acme/site'), t.service.visibilityFor(U, 'ACME/site')])).toEqual(['public', 'public'])
    expect(await t.service.visibilityFor(U, 'acme/secret')).toBe('private')
    expect(await t.service.visibilityFor(U, 'acme/secret')).toBe('private')
    expect(await t.service.visibilityFor(U, 'acme/inner')).toBe('private')
    for (const repo of ['acme/limited', 'acme/unauth', 'acme/odd', 'acme/flaky', 'acme/down']) {
      expect(await t.service.visibilityFor(U, repo)).toBeNull()
      expect(await t.service.visibilityFor(U, repo)).toBeNull()
      expect(t.github.count(`/repos/${repo}`)).toBe(2)
    }
    expect(t.github.count('/repos/acme/site')).toBe(1)
    expect(t.github.count('/repos/acme/secret')).toBe(1)
    expect(t.github.requests.find(r => r.url.endsWith('/repos/acme/site'))?.auth).toBe('Bearer ghu_access_OLD_0000000000')
    clock += 61_000
    await t.service.visibilityFor(U, 'acme/site')
    expect(t.github.count('/repos/acme/site')).toBe(2)
  })

  it('keeps at most VISIBILITY_CACHE_MAX repositories, dropping the oldest', async () => {
    const t = makeService()
    t.storage.seed(U, connected({ expiresAt: null }))
    t.github.fetch.mockImplementation(async () => new Response(JSON.stringify({ private: false }), { status: 200, headers: { 'content-type': 'application/json' } }))
    for (let i = 0; i <= VISIBILITY_CACHE_MAX; i++) await t.service.visibilityFor(U, `acme/r${i}`)
    expect(t.github.fetch).toHaveBeenCalledTimes(VISIBILITY_CACHE_MAX + 1)
    await t.service.visibilityFor(U, `acme/r${VISIBILITY_CACHE_MAX}`)
    expect(t.github.fetch).toHaveBeenCalledTimes(VISIBILITY_CACHE_MAX + 1)
    await t.service.visibilityFor(U, 'acme/r0')
    expect(t.github.fetch).toHaveBeenCalledTimes(VISIBILITY_CACHE_MAX + 2)
  })

  it('the visibility cache is cleared with the coverage cache (an expired sign-in)', async () => {
    let clock = 1_000_000_000_000
    const t = makeService({ now: () => clock })
    t.storage.seed(U, connected({ expiresAt: clock + MIN_TOKEN_TTL_MS + 30_000 }))
    t.github.on(`${API}/repos/acme/site`, { json: { private: false } })
    t.github.on('/login/oauth/access_token', { json: { error: 'bad_refresh_token' } })
    expect(await t.service.visibilityFor(U, 'acme/site')).toBe('public')
    clock += 31_000
    expect(await t.service.visibilityFor(U, 'acme/site')).toBe('public')
    expect(await t.service.token(U)).toEqual({ kind: 'needed', need: 'reconnect' })
    // Within the minute, but the cache went with the sign-in: no answer without a token.
    expect(await t.service.visibilityFor(U, 'acme/site')).toBeNull()
    expect(t.github.count('/repos/acme/site')).toBe(1)
  })

  it('refreshes for an uncovered repo at most once a minute', async () => {
    let clock = 1_000_000_000_000
    const t = makeService({ now: () => clock })
    withInstallations(t)
    t.storage.seed(U, connected({ expiresAt: null }))
    await t.service.coverageFor(U, 'carol/x')
    await t.service.coverageFor(U, 'carol/x')
    await t.service.coverageFor(U, 'acme/shop')
    expect(t.github.count('/user/installations?per_page=100&page=2')).toBe(1)
    clock += 61_000
    await t.service.coverageFor(U, 'carol/x')
    expect(t.github.count('/user/installations?per_page=100&page=2')).toBe(2)
  })
})

describe('coverage just after a sign-in', () => {
  /** Holds every installations read until the returned release is called. */
  function holdInstallations(t: ReturnType<typeof makeService>): () => void {
    const inner = t.github.fetch.getMockImplementation()!
    let release!: () => void
    const gate = new Promise<void>(r => { release = r })
    t.github.fetch.mockImplementation(async (input: string, init?: RequestInit) => {
      if (input.includes('/user/installations')) await gate
      return inner(input, init)
    })
    return release
  }

  it('a lookup or an install need on the empty cache waits for the read in flight, even within a minute of a miss', async () => {
    let clock = 1_000_000_000_000
    const t = makeService({ now: () => clock })
    t.storage.seed(U, connected({ expiresAt: clock + MIN_TOKEN_TTL_MS + 30_000 }))
    t.github.on('/user/installations?per_page=100', { json: { installations: [install(1, 'alice', 'User', 'all')] } })
    t.github.on('/login/oauth/access_token', { json: { error: 'bad_refresh_token' } })
    // A miss starts the once-a-minute window, then the sign-in expires.
    expect((await t.service.coverageFor(U, 'carol/x'))?.answer).toBe('not_installed')
    clock += 31_000
    expect(await t.service.token(U)).toEqual({ kind: 'needed', need: 'reconnect' })
    // Reconnect GitHub: the first installations read after it is held.
    t.github.on('/login/device/code', { json: DEVICE })
    t.github.on('/login/oauth/access_token', { json: TOKENS })
    t.github.on('/user', { json: USER })
    const release = holdInstallations(t)
    await t.service.startDeviceFlow(U)
    await vi.waitFor(async () => expect((await t.service.status(U)).account?.state).toBe('connected'))
    expect((await t.service.status(U)).account?.coverageFetchedAt).toBeNull()
    // Two lookups at once: the first starts the minute's refresh, the second must still wait.
    const lookups = [t.service.coverageFor(U, 'alice/x'), t.service.coverageFor(U, 'alice/z')]
    const need = t.service.recordNeed(U, 'install', 'alice/y', 'folder:a')
    await new Promise(r => setTimeout(r, 20))
    // No Allow access row from the empty cache while the read runs.
    expect((await t.service.status(U)).needs).toEqual([])
    release()
    expect((await Promise.all(lookups)).map(c => c?.answer)).toEqual(['covered', 'covered'])
    await need
    expect((await t.service.status(U)).needs).toEqual([])
  })

  it('the first lookup after a sign-in whose installations read failed reads them again', async () => {
    let clock = 1_000_000_000_000
    const t = makeService({ now: () => clock })
    t.storage.seed(U, connected({ expiresAt: clock + MIN_TOKEN_TTL_MS + 30_000 }))
    t.github.on('/user/installations?per_page=100', { json: { installations: [] } })
    t.github.on('/login/oauth/access_token', { json: { error: 'bad_refresh_token' } })
    await t.service.coverageFor(U, 'alice/x')
    clock += 31_000
    await t.service.token(U)
    t.github.on('/login/device/code', { json: DEVICE })
    t.github.on('/login/oauth/access_token', { json: TOKENS })
    t.github.on('/user', { json: USER })
    t.github.on('/user/installations?per_page=100', { status: 502, json: {} }, { json: { installations: [install(1, 'alice', 'User', 'all')] } })
    const signedIn = vi.fn()
    t.service.setOnSignedIn(signedIn)
    await t.service.startDeviceFlow(U)
    await vi.waitFor(() => expect(signedIn).toHaveBeenCalled())
    expect((await t.service.coverageFor(U, 'alice/x'))?.answer).toBe('covered')
  })

  it('a lookup for an uncovered repo right after the sign-in read answers from it without reading again', async () => {
    const t = makeService()
    t.github.on('/login/device/code', { json: DEVICE })
    t.github.on('/login/oauth/access_token', { json: TOKENS })
    t.github.on('/user', { json: USER })
    t.github.on('/user/installations?per_page=100', { json: { installations: [install(1, 'alice', 'User', 'all')] } })
    await t.service.startDeviceFlow(U)
    await vi.waitFor(async () => expect((await t.service.status(U)).account?.coverageFetchedAt).toEqual(expect.any(Number)))
    const reads = (): number => t.github.fetch.mock.calls.filter(([url]) => String(url).includes('/user/installations')).length
    const before = reads()
    expect((await t.service.coverageFor(U, 'carol/x'))?.answer).toBe('not_installed')
    expect(reads()).toBe(before)
  })

  it('a read started for the previous account never lands as, or is joined by, the new sign-in', async () => {
    const t = makeService()
    t.storage.seed(U, connected())
    t.github.on('/user/installations?per_page=100',
      { json: { installations: [install(1, 'alice', 'User', 'all')] } },
      { json: { installations: [install(2, 'bob', 'User', 'all')] } })
    const release = holdInstallations(t)
    const stale = t.service.coverageFor(U, 'alice/x')
    await vi.waitFor(() => expect(t.github.fetch.mock.calls.some(([url]) => String(url).includes('/user/installations'))).toBe(true))
    t.github.on('/login/device/code', { json: DEVICE })
    t.github.on('/login/oauth/access_token', { json: TOKENS })
    t.github.on('/user', { json: { login: 'bob', id: 7, name: 'Bob' } })
    const signedIn = vi.fn()
    t.service.setOnSignedIn(signedIn)
    await t.service.startDeviceFlow(U)
    await vi.waitFor(async () => expect((await t.service.status(U)).account?.login).toBe('bob'))
    release()
    await stale
    await vi.waitFor(() => expect(signedIn).toHaveBeenCalled())
    expect((await t.service.status(U)).account?.coverage.map(c => c.owner)).toEqual(['bob'])
  })
})

describe('needs', () => {
  it('dedupes per profile and per owner, merges repos and agents, and self-clears', async () => {
    const t = makeService()
    // Signed out: an install report becomes the account need.
    await t.service.recordNeed(U, 'install', 'acme/shop', 'folder:a')
    await t.service.recordNeed(U, 'sign_in', undefined, 'folder:b')
    await t.service.recordNeed(U, 'sign_in', undefined, 'folder:b')
    expect((await t.service.status(U)).needs).toEqual([{ key: 'account', kind: 'sign_in', agentIds: ['folder:a', 'folder:b'] }])

    t.storage.seed('user-2', connected())
    t.github.on('/user/installations?per_page=100', { json: { installations: [install(2, 'acme', 'Organization', 'selected', 900)] } })
    t.github.on('/user/installations/2/repositories?per_page=100', { json: { repositories: [{ full_name: 'acme/other' }] } }, { json: { repositories: [{ full_name: 'acme/shop' }, { full_name: 'acme/docs' }] } })
    await t.service.checkAgain('user-2')
    await t.service.recordNeed('user-2', 'install', 'acme/shop.git', 'folder:a')
    await t.service.recordNeed('user-2', 'install', 'Acme/docs', 'folder:b')
    await t.service.recordNeed('user-2', 'install', 'acme/shop', 'folder:a')
    await t.service.recordNeed('user-2', 'install', 'not a repo', 'folder:a')
    // Signed in: a stale sign-in report records nothing.
    await t.service.recordNeed('user-2', 'sign_in', undefined, 'folder:a')
    expect((await t.service.status('user-2')).needs).toEqual([
      { key: 'install:acme', kind: 'install', owner: 'acme', repos: ['acme/shop', 'Acme/docs'], installUrl: 'https://github.com/organizations/acme/settings/installations/2', agentIds: ['folder:a', 'folder:b'] }
    ])
    // Check again finds both repositories covered now: the need clears itself.
    await t.service.checkAgain('user-2')
    expect((await t.service.status('user-2')).needs).toEqual([])

    t.service.dismiss(U, 'account')
    expect((await t.service.status(U)).needs).toEqual([])
  })

  it('lists dismissed keys apart from resolved ones; recording again or signing out takes them off', async () => {
    const t = makeService()
    t.storage.seed(U, connected())
    t.github.on('/user/installations?per_page=100', { json: { installations: [] } })
    await t.service.checkAgain(U)
    await t.service.recordNeed(U, 'install', 'acme/shop', 'folder:a')
    await t.service.recordNeed(U, 'install', 'bob/site', 'folder:a')
    const before = t.published.length
    t.service.dismiss(U, 'install:acme')
    expect(t.published.length).toBe(before + 1)
    expect(await t.service.status(U)).toMatchObject({ needs: [{ key: 'install:bob' }], dismissed: ['install:acme'] })
    // A second dismiss changes nothing; a key of no need's shape is not remembered.
    t.service.dismiss(U, 'install:acme')
    t.service.dismiss(U, 'anything else')
    expect(t.published.length).toBe(before + 1)
    expect((await t.service.status(U)).dismissed).toEqual(['install:acme'])
    // Recorded again: back in needs, off the dismissed list.
    await t.service.recordNeed(U, 'install', 'acme/shop', 'folder:b')
    expect(await t.service.status(U)).toMatchObject({ needs: [{ key: 'install:bob' }, { key: 'install:acme', agentIds: ['folder:b'] }], dismissed: [] })
    t.service.dismiss(U, 'install:bob')
    expect((await t.service.status(U)).dismissed).toEqual(['install:bob'])
    // Sign-out empties it.
    t.service.signOut(U)
    expect((await t.service.status(U)).dismissed).toEqual([])
    // The account need too.
    await t.service.recordNeed(U, 'sign_in', undefined, 'folder:a')
    t.service.dismiss(U, 'account')
    expect(await t.service.status(U)).toMatchObject({ needs: [], dismissed: ['account'] })
    await t.service.recordNeed(U, 'sign_in', undefined, 'folder:a')
    expect(await t.service.status(U)).toMatchObject({ needs: [{ key: 'account' }], dismissed: [] })
  })

  it('a completed sign-in clears the account need', async () => {
    const t = makeService()
    await t.service.recordNeed(U, 'sign_in', undefined, 'folder:a')
    t.github.on('/login/device/code', { json: DEVICE })
    t.github.on('/login/oauth/access_token', { json: TOKENS })
    t.github.on('/user', { json: USER })
    t.github.on('/user/installations?per_page=100', { json: { installations: [] } })
    await t.service.startDeviceFlow(U)
    await vi.waitFor(async () => expect((await t.service.status(U)).account?.state).toBe('connected'))
    expect((await t.service.status(U)).needs).toEqual([])
  })
})

describe('needs a run with no chat hit (the Inbox items)', () => {
  it('one account item per profile and one install item per owner, however many runs and agents hit them', async () => {
    const t = makeService()
    await t.service.recordNeed(U, 'sign_in', undefined, 'folder:a', 'schedule')
    await t.service.recordNeed(U, 'sign_in', undefined, 'folder:a', 'schedule')
    await t.service.recordNeed(U, 'install', 'acme/shop', 'folder:b', 'command')
    // A chat hit it too: listed among the agents, not among the chatless ones.
    await t.service.recordNeed(U, 'sign_in', undefined, 'folder:c', null)
    expect(t.service.chatlessNeeds(U)).toEqual([{ key: 'account', kind: 'sign_in', agentIds: ['folder:a', 'folder:b', 'folder:c'], chatlessAgentIds: ['folder:a', 'folder:b'] }])

    t.storage.seed('user-2', connected())
    t.github.on('/user/installations?per_page=100', { json: { installations: [install(2, 'acme', 'Organization', 'selected', 900)] } })
    t.github.on('/user/installations/2/repositories?per_page=100', { json: { repositories: [] } }, { json: { repositories: [{ full_name: 'acme/shop' }, { full_name: 'acme/docs' }] } })
    await t.service.checkAgain('user-2')
    await t.service.recordNeed('user-2', 'install', 'acme/shop', 'folder:a', 'schedule')
    await t.service.recordNeed('user-2', 'install', 'acme/docs', 'folder:a', 'schedule')
    await t.service.recordNeed('user-2', 'install', 'acme/shop', 'folder:b', 'command')
    // A need only chats hit is no Inbox item.
    await t.service.recordNeed('user-2', 'install', 'other/x', 'folder:a', null)
    expect(t.service.chatlessNeeds('user-2')).toEqual([
      { key: 'install:acme', kind: 'install', owner: 'acme', repos: ['acme/shop', 'acme/docs'], installUrl: 'https://github.com/organizations/acme/settings/installations/2', agentIds: ['folder:a', 'folder:b'], chatlessAgentIds: ['folder:a', 'folder:b'] }
    ])
    // A coverage read that covers both clears it, as it clears the composer row.
    await t.service.checkAgain('user-2')
    expect(t.service.chatlessNeeds('user-2')).toEqual([])
  })

  it('clears when the sign-in completes, and when dismissed (from any surface); comes back when hit again', async () => {
    const t = makeService()
    await t.service.recordNeed(U, 'sign_in', undefined, 'folder:a', 'command')
    t.service.dismiss(U, 'account')
    expect(t.service.chatlessNeeds(U)).toEqual([])
    expect((await t.service.status(U)).dismissed).toEqual(['account'])
    await t.service.recordNeed(U, 'sign_in', undefined, 'folder:a', 'command')
    expect(t.service.chatlessNeeds(U)).toHaveLength(1)
    t.github.on('/login/device/code', { json: DEVICE })
    t.github.on('/login/oauth/access_token', { json: TOKENS })
    t.github.on('/user', { json: USER })
    t.github.on('/user/installations?per_page=100', { json: { installations: [] } })
    await t.service.startDeviceFlow(U)
    await vi.waitFor(async () => expect((await t.service.status(U)).account?.state).toBe('connected'))
    expect(t.service.chatlessNeeds(U)).toEqual([])
  })

  it('none for a profile that cannot serve', async () => {
    let available = true
    const t = makeService({ access: { agentHolder: () => null, available: () => available } })
    await t.service.recordNeed(U, 'sign_in', undefined, 'folder:a', 'command')
    available = false
    expect(t.service.chatlessNeeds(U)).toEqual([])
  })
})

describe('profile removal', () => {
  it('a profile removed while a sign-in is being sealed is never written back', async () => {
    const t = makeService()
    t.github.on('/login/device/code', { json: DEVICE })
    t.github.on('/login/oauth/access_token', { json: TOKENS })
    t.github.on('/user', { json: USER })
    const release = t.storage.hold()
    await t.service.startDeviceFlow(U)
    // The poll answered and the account is being sealed: remove the profile under it.
    await vi.waitFor(() => expect(t.github.count('/user')).toBe(1))
    await new Promise(r => setTimeout(r, 10))
    t.service.profileRemoved(U)
    release()
    await new Promise(r => setTimeout(r, 20))
    expect(t.storage.log.filter(entry => entry.startsWith('write:'))).toEqual([])
    expect(t.storage.rows.has(U)).toBe(false)
  })

  it('a profile removed while a refreshed pair is being sealed is never written back', async () => {
    const t = makeService()
    t.storage.seed(U, connected({ expiresAt: Date.now() + 1000 }))
    t.github.on('/login/oauth/access_token', { json: TOKENS })
    await t.service.status(U)
    const release = t.storage.hold()
    const answer = t.service.token(U)
    await vi.waitFor(() => expect(t.github.count('/login/oauth/access_token')).toBe(1))
    await new Promise(r => setTimeout(r, 10))
    t.service.profileRemoved(U)
    t.storage.rows.delete(U) // the profile's stored record went with it
    release()
    expect((await answer).kind).not.toBe('token')
    expect(t.storage.log.filter(entry => entry.startsWith('write:'))).toEqual([])
    expect(t.storage.rows.has(U)).toBe(false)
  })
})
