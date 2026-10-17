import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { request as httpRequest } from 'node:http'
import { createCredentialTokenServer, parseTokenBody, type CredentialTokenServer } from './tokenServer'

/** A raw request, so Host and Origin are exactly what the test says (fetch would set its own). */
function call(port: number, options: { method?: string; path?: string; host?: string; headers?: Record<string, string>; body?: string }): Promise<{ status: number; body: any; headers: Record<string, unknown> }> {
  return new Promise((resolve, reject) => {
    const req = httpRequest({ host: '127.0.0.1', port, method: options.method ?? 'POST', path: options.path ?? '/credentials/cred-1/access-token',
      headers: { host: options.host ?? `127.0.0.1:${port}`, 'content-type': 'application/json', ...options.headers } }, res => {
      const chunks: Buffer[] = []
      res.on('data', c => chunks.push(c))
      res.on('end', () => { const text = Buffer.concat(chunks).toString(); resolve({ status: res.statusCode!, body: text ? JSON.parse(text) : null, headers: res.headers }) })
    })
    req.on('error', reject)
    req.end(options.body ?? '{"min_ttl": 600, "known_expires_at": 123}')
  })
}

describe('credential token endpoint', () => {
  const live = new Set<string>()
  const issue = vi.fn()
  let server: CredentialTokenServer, port: number, bearer: string
  beforeEach(async () => {
    live.clear(); issue.mockReset()
    issue.mockResolvedValue({ status: 200, body: { access_token: 'ya29.fixture-token', token_type: 'Bearer', expires_at: 2000, refreshed: true } })
    server = createCredentialTokenServer({ live: id => live.has(id), issue })
    const origin = await server.start()
    port = Number(new URL(origin).port)
    bearer = server.bearer('agent-a')
    live.add('agent-a')
  })
  afterEach(async () => { await server.close() })

  it('keeps one port and one bearer per agent for the session', async () => {
    expect(await server.start()).toBe(`http://127.0.0.1:${port}`)
    expect(server.bearer('agent-a')).toBe(bearer)
    expect(server.bearer('agent-b')).not.toBe(bearer)
    expect(Buffer.from(bearer, 'base64url')).toHaveLength(32)
  })

  it('answers a live agent through the handler, no-store, with the clamped body', async () => {
    const res = await call(port, { headers: { authorization: `Bearer ${bearer}` }, body: '{"min_ttl": 99999, "known_expires_at": 1700000000.7}' })
    expect(res.status).toBe(200)
    expect(res.body).toEqual({ access_token: 'ya29.fixture-token', token_type: 'Bearer', expires_at: 2000, refreshed: true })
    expect(res.headers['cache-control']).toBe('no-store')
    expect(issue).toHaveBeenCalledWith({ agentId: 'agent-a', credentialId: 'cred-1', minTtl: 1800, knownExpiresAt: 1700000000 })
    // `localhost:<port>` names the same listener.
    expect((await call(port, { host: `localhost:${port}`, headers: { authorization: `Bearer ${bearer}` } })).status).toBe(200)
  })

  it('refuses a wrong or missing bearer, and an agent with no live turn, with 401', async () => {
    for (const authorization of [undefined, `Bearer ${bearer.slice(0, -1)}x`, `Bearer ${bearer}x`, bearer]) {
      const res = await call(port, { headers: authorization ? { authorization } : {} })
      expect(res.status).toBe(401)
    }
    live.delete('agent-a')
    expect((await call(port, { headers: { authorization: `Bearer ${bearer}` } })).status).toBe(401)
    expect(issue).not.toHaveBeenCalled()
  })

  it('refuses another Host and any Origin before anything else', async () => {
    const auth = { authorization: `Bearer ${bearer}` }
    expect((await call(port, { host: `evil.test:${port}`, headers: auth })).status).toBe(403)
    expect((await call(port, { host: '127.0.0.1:1', headers: auth })).status).toBe(403)
    expect((await call(port, { headers: { ...auth, origin: `http://127.0.0.1:${port}` } })).status).toBe(403)
    expect((await call(port, { headers: { ...auth, origin: 'null' } })).status).toBe(403)
    expect(issue).not.toHaveBeenCalled()
  })

  it('has one route: anything else is 404', async () => {
    const auth = { authorization: `Bearer ${bearer}` }
    for (const [method, path] of [['GET', '/credentials/cred-1/access-token'], ['POST', '/credentials/cred-1/access-token?x=1'], ['POST', '/credentials/../x/access-token'], ['POST', '/mcp'], ['POST', '/credentials/cred-1']]) {
      expect((await call(port, { method, path, headers: auth })).status).toBe(404)
    }
    expect(issue).not.toHaveBeenCalled()
  })

  it('refuses a malformed or oversized body, and passes Core’s refusal and Retry-After through', async () => {
    const auth = { authorization: `Bearer ${bearer}` }
    expect((await call(port, { headers: auth, body: '[1]' })).status).toBe(422)
    expect((await call(port, { headers: auth, body: '{"min_ttl": "soon"}' })).status).toBe(422)
    expect((await call(port, { headers: auth, body: JSON.stringify({ pad: 'x'.repeat(5000) }) })).status).toBe(413)
    issue.mockResolvedValue({ status: 502, body: { detail: { code: 'refresh_in_progress', message: 'busy' } }, retryAfter: '2' })
    const res = await call(port, { headers: auth })
    expect(res).toMatchObject({ status: 502, body: { detail: { code: 'refresh_in_progress' } } })
    expect(res.headers['retry-after']).toBe('2')
  })

  it('forgets every bearer when closed', async () => {
    await server.close()
    const origin = await server.start()
    port = Number(new URL(origin).port)
    expect((await call(port, { headers: { authorization: `Bearer ${bearer}` } })).status).toBe(401)
  })
})

describe('parseTokenBody', () => {
  it('defaults as Core does and clamps min_ttl', () => {
    expect(parseTokenBody('')).toEqual({ minTtl: 300, knownExpiresAt: null })
    expect(parseTokenBody('{"min_ttl": -5}')).toEqual({ minTtl: 0, knownExpiresAt: null })
    expect(parseTokenBody('{"known_expires_at": null, "min_ttl": 60}')).toEqual({ minTtl: 60, knownExpiresAt: null })
    expect(parseTokenBody('{"known_expires_at": "x"}')).toBeNull()
    expect(parseTokenBody('nope')).toBeNull()
  })
})
