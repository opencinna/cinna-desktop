import { beforeEach, afterEach, describe, it, expect, vi } from 'vitest'

const fetchMock = vi.hoisted(() => vi.fn<typeof fetch>())
vi.mock('electron', () => ({ net: { fetch: fetchMock } }))
vi.mock('../db/users', () => ({ userRepo: { get: () => ({ type: 'cinna_user', cinnaServerUrl: 'https://service.test' }) } }))
vi.mock('../auth/cinna-tokens', () => ({ getCinnaAccessToken: async () => 'fake-token' }))
vi.mock('../auth/cinna-oauth', () => ({ CinnaReauthRequired: class extends Error {} }))
vi.mock('../logger/logger', () => ({ createLogger: () => ({ error: vi.fn(), warn: vi.fn() }) }))

const { cinnaApiFetch } = await import('./cinnaApiService')

beforeEach(() => { fetchMock.mockReset() })
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers() })

describe('task adapter HTTP transport', () => {
  it('aborts an unresponsive request so a later inbox poll can try again', async () => {
    vi.useFakeTimers()
    // Native AbortSignal.timeout uses Node's internal timers. Route that timer
    // through the fake clock while retaining real AbortController semantics.
    vi.spyOn(AbortSignal, 'timeout').mockImplementation((delay) => {
      const controller = new AbortController()
      setTimeout(() => controller.abort(new DOMException('Timed out', 'TimeoutError')), delay)
      return controller.signal
    })
    fetchMock.mockImplementation((_url, init) => new Promise((_resolve, reject) => {
      init!.signal!.addEventListener('abort', () => reject(init!.signal!.reason), { once: true })
    }))
    const request = cinnaApiFetch('user', '/api/v1/tasks/')
    const rejected = expect(request).rejects.toMatchObject({ code: 'request_failed', message: 'Timed out' })
    await vi.advanceTimersByTimeAsync(30_000)
    await rejected
    fetchMock.mockResolvedValue(new Response('{"data":[]}'))
    expect(await cinnaApiFetch('user', '/api/v1/tasks/')).toEqual({ data: [] })
  })

  it('keeps empty successful responses and precise ownership errors intact', async () => {
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 204 }))
    expect(await cinnaApiFetch('user', '/empty')).toBeUndefined()
    fetchMock.mockResolvedValueOnce(new Response('{"detail":"Not enough permissions"}', { status: 400 }))
    await expect(cinnaApiFetch('user', '/denied')).rejects.toMatchObject({
      code: 'request_failed', status: 400, detail: 'Not enough permissions'
    })
  })
})
