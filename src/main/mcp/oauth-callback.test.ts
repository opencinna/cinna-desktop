import http from 'node:http'
import { describe, expect, it } from 'vitest'
import { startOAuthCallback } from './oauth-callback'

function get(url: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => {
      let body = ''
      res.on('data', (chunk) => { body += chunk })
      res.on('end', () => resolve({ status: res.statusCode!, body }))
    }).on('error', reject)
  })
}

describe('bound OAuth callback', () => {
  it('preserves issuer and Cinna client parameters for the actual authorization owner', async () => {
    const listener = await startOAuthCallback('expected')
    const response = await get(`${listener.redirectUrl}?state=expected&code=code&iss=https%3A%2F%2Fissuer.test&client_id=client`)
    expect(response.status).toBe(200)
    expect(response.body).toContain('Return to Cinna')
    expect(response.body).not.toMatch(/success/i)
    const result = await listener.promise
    expect(listener.isPending()).toBe(false)
    expect(Object.fromEntries(result.searchParams)).toEqual({ state: 'expected', code: 'code', iss: 'https://issuer.test', client_id: 'client' })
    await expect(get(listener.redirectUrl)).rejects.toThrow()
  })

  it.each(['code=code', 'state=wrong&code=code', 'state=expected&state=expected&code=code',
    'state=expected&code=a&code=b', 'state=expected&code=code&iss=a&iss=b'])('rejects invalid callback %s', async (query) => {
    const listener = await startOAuthCallback('expected')
    const rejection = expect(listener.promise).rejects.toThrow(/did not match/)
    expect((await get(`${listener.redirectUrl}?${query}`)).status).toBe(400)
    await rejection
  })

  it('returns neutral HTML for OAuth errors and never inserts callback-controlled markup', async () => {
    const listener = await startOAuthCallback('expected')
    const response = await get(`${listener.redirectUrl}?state=expected&error=access_denied&error_description=%3Cscript%3Eevil%3C%2Fscript%3E`)
    expect(response.body).not.toContain('<script>')
    expect(response.body).not.toContain('access_denied')
    expect((await listener.promise).params.error).toBe('access_denied')
  })

  it('ignores unrelated paths without consuming the pending flow', async () => {
    const listener = await startOAuthCallback('expected')
    expect((await get(new URL('/unrelated', listener.redirectUrl).href)).status).toBe(404)
    await get(`${listener.redirectUrl}?state=expected&code=code`)
    expect((await listener.promise).code).toBe('code')
  })

  it('aborts idempotently and closes the bound server', async () => {
    const listener = await startOAuthCallback('expected')
    expect(listener.isPending()).toBe(true)
    listener.abort(); listener.abort()
    expect(listener.isPending()).toBe(false)
    await expect(listener.promise).rejects.toThrow(/aborted/)
    await expect(get(listener.redirectUrl)).rejects.toThrow()
  })

  it('times out and closes the bound server', async () => {
    const listener = await startOAuthCallback('expected', 10)
    await expect(listener.promise).rejects.toThrow(/timed out/)
    expect(listener.isPending()).toBe(false)
    await expect(get(listener.redirectUrl)).rejects.toThrow()
  })
})
