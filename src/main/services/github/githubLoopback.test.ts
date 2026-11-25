import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { request as httpRequest } from 'node:http'
import { createCredentialTokenServer, type CredentialTokenServer } from '../serviceCredentials/tokenServer'
import { githubLoopbackRoutes, GITHUB_MESSAGES } from './githubLoopback'
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
  const live = new Set<string>(), locked = new Set<string>()
  /** Folder agents are shared; each test agent works for the profile named here. */
  const profileOf: Record<string, string> = { 'folder:a': 'user-a', 'folder:b': 'user-b' }
  let server: CredentialTokenServer, port: number, t: ReturnType<typeof makeService>
  const auth = (agentId: string) => ({ authorization: `Bearer ${server.bearer(agentId)}` })

  beforeEach(async () => {
    process.env.CINNA_GITHUB_WEB_URL = WEB
    process.env.CINNA_GITHUB_API_URL = API
    live.clear(); locked.clear()
    t = makeService({ access: { agentProfile: id => profileOf[id] ?? null, available: id => !locked.has(id) } })
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

  it('another agent’s bearer reaches only that agent’s profile', async () => {
    const res = await call(port, { headers: auth('folder:b') })
    expect(res.body).toEqual({ needed: 'sign_in', message: GITHUB_MESSAGES.sign_in })
    expect(JSON.stringify(res.body)).not.toContain('ghu_')
  })

  it('a locked profile, or no active profile, needs sign_in', async () => {
    locked.add('user-a')
    expect((await call(port, { headers: auth('folder:a') })).body).toEqual({ needed: 'sign_in', message: GITHUB_MESSAGES.sign_in })
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
    const ghMissing = vi.fn()
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
    expect((await call(port, { path: '/github/needed', headers: auth('folder:a'), body: '{"kind":"gh_missing"}' })).body).toEqual({ ok: true })
    expect(ghMissing).toHaveBeenCalledWith('folder:a')
    expect((await call(port, { path: '/github/needed', headers: auth('folder:a'), body: '{"kind":"admin"}' })).status).toBe(422)
    live.delete('folder:b')
    expect((await call(port, { path: '/github/needed', headers: auth('folder:b'), body: '{"kind":"sign_in"}' })).status).toBe(401)
  })

  it('every message is safe for the wrapper’s sed: no quote, backslash or newline', () => {
    for (const message of [GITHUB_MESSAGES.sign_in, GITHUB_MESSAGES.reconnect, GITHUB_MESSAGES.unavailable, GITHUB_MESSAGES.install('a.b/c_d-e')]) expect(message).not.toMatch(/["\\\n\r]/)
  })
})
