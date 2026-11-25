import { expect, it, vi } from 'vitest'

const seen = vi.hoisted(() => ({ opened: [] as string[], logs: [] as unknown[], callback: {} as Record<string, string> }))
vi.mock('../host/runtimeHost', () => ({ runtimeHost: {
  getVersion: () => '0.0.0',
  shell: { openExternal: async (url: string) => { seen.opened.push(url) } },
  http: { fetch: async () => new Response(JSON.stringify({
    authorization_endpoint: 'https://core.test/api/v1/desktop-auth/authorize', token_endpoint: 'https://core.test/t', userinfo_endpoint: 'https://core.test/u'
  }), { status: 200, headers: { 'Content-Type': 'application/json' } }) }
} }))
vi.mock('../mcp/oauth-callback', () => ({ startOAuthCallback: vi.fn(async (state: string) => ({
  promise: Promise.resolve({ code: seen.callback.code ?? null, state, params: seen.callback }), abort: () => {}, redirectUrl: 'http://127.0.0.1:1/cb'
})) }))
vi.mock('../logger/logger', () => ({ createLogger: () => { const log = (...args: unknown[]) => { seen.logs.push(args) }; return { debug: log, info: log, warn: log, error: log } } }))
const { cinnaAuthorizeUrl, redactAuthorizeUrl, startCinnaOAuthFlow, CinnaAuthorizationDenied } = await import('./cinna-oauth')

it('re-auth opens the browser with the hint, never logs it, and a declined consent is CinnaAuthorizationDenied', async () => {
  seen.callback = { error: 'access_denied' }
  await expect(startCinnaOAuthFlow('https://core.test', { expectedEmail: 'alice@corp.test' })).rejects.toBeInstanceOf(CinnaAuthorizationDenied)
  expect(new URL(seen.opened.at(-1)!).searchParams.get('login_hint')).toBe('alice@corp.test')
  expect(JSON.stringify(seen.logs)).not.toContain('alice')
  seen.callback = { error: 'server_error' }
  const other = startCinnaOAuthFlow('https://core.test')
  await expect(other).rejects.toThrow('Cinna authorization was not completed.')
  await expect(other).rejects.not.toBeInstanceOf(CinnaAuthorizationDenied)
  expect(new URL(seen.opened.at(-1)!).searchParams.has('login_hint')).toBe(false)
})

const base = () => new URLSearchParams({ redirect_uri: 'http://127.0.0.1:1/cb', state: 's' })

it('adds a trimmed login_hint only when an expected account is given', () => {
  const plain = new URL(cinnaAuthorizeUrl('https://core.test/api/v1/desktop-auth/authorize', base()))
  expect(plain.searchParams.has('login_hint')).toBe(false)
  for (const blank of [null, '', '   ']) expect(cinnaAuthorizeUrl('https://core.test/a', base(), blank)).not.toContain('login_hint')
  const hinted = new URL(cinnaAuthorizeUrl('https://core.test/a', base(), '  Alice+x@Corp.test '))
  expect(hinted.searchParams.get('login_hint')).toBe('Alice+x@Corp.test')
  expect(hinted.searchParams.get('state')).toBe('s')
})

it('redacts the hint for the log and leaves a URL without one as it is', () => {
  const url = cinnaAuthorizeUrl('https://core.test/a', base(), 'alice@corp.test')
  const logged = redactAuthorizeUrl(url)
  expect(logged).not.toContain('alice')
  expect(new URL(logged).searchParams.get('login_hint')).toBe('redacted')
  const plain = cinnaAuthorizeUrl('https://core.test/a', base())
  expect(redactAuthorizeUrl(plain)).toBe(plain)
})
