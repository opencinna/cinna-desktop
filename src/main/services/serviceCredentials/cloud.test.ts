import { beforeEach, expect, it, vi } from 'vitest'
const world = vi.hoisted(() => ({ fetch: vi.fn(), token: vi.fn(), servers: {} as Record<string, string> }))
vi.mock('../../host/runtimeHost', () => ({ runtimeHost: { http: { fetch: world.fetch } } }))
vi.mock('../../db/users', () => ({ userRepo: { get: (id: string) => ({ type: 'cinna_user', cinnaServerUrl: world.servers[id] ?? `https://${id}.example.test` }) } }))
vi.mock('../../auth/cinna-tokens', () => ({ getCinnaAccessToken: world.token }))
vi.mock('../../auth/cinna-oauth', () => ({ CinnaReauthRequired: class extends Error {} }))
import { serviceCredentialCloud } from './cloud'
beforeEach(() => {
  world.fetch.mockReset(); world.token.mockReset()
  world.servers = {}
  world.token.mockResolvedValue('fixture-token')
  world.fetch.mockImplementation(async () => new Response(JSON.stringify({ items: [] }), { headers: { 'content-type': 'application/json' } }))
})
it('does not send a refreshed token to the former host when a profile is rebound', async () => {
  let finish!: (token: string) => void
  world.token.mockReturnValue(new Promise<string>(resolve => { finish = resolve }))
  const pending = serviceCredentialCloud.list('rebound')
  const rejected = expect(pending).rejects.toThrow('account changed')
  world.servers.rebound = 'http://localhost:5173'
  finish('replacement-fixture-token')
  await rejected
  expect(world.fetch).not.toHaveBeenCalled()
})
it('requests only the selected profile and bypasses Electron cache for metadata and values', async () => {
  await serviceCredentialCloud.list('local-core')
  await serviceCredentialCloud.materialize('local-core', ['fixture'])
  expect(world.token.mock.calls.map(([id]) => id)).toEqual(['local-core', 'local-core'])
  expect(world.fetch.mock.calls.map(([url]) => url)).toEqual([
    'https://local-core.example.test/api/v1/external/credentials',
    'https://local-core.example.test/api/v1/external/credentials/materialize'
  ])
  for (const [, options] of world.fetch.mock.calls) {
    expect(options.cache).toBe('no-store')
    expect(options.signal).toBeInstanceOf(AbortSignal)
  }
})
it('does not issue a request after the profile retires while token refresh is pending', async () => {
  let finish!: (token: string) => void
  world.token.mockReturnValue(new Promise<string>(resolve => { finish = resolve }))
  const controller = new AbortController()
  const pending = serviceCredentialCloud.list('old-profile', controller.signal)
  const rejected = expect(pending).rejects.toThrow()
  controller.abort(); finish('old-fixture-token')
  await rejected
  expect(world.fetch).not.toHaveBeenCalled()
})
