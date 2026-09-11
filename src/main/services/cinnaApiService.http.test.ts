import { beforeEach, afterEach, describe, it, expect, vi } from 'vitest'

const fetchMock = vi.hoisted(() => vi.fn<typeof fetch>())
const tokenMock = vi.hoisted(() => vi.fn(async () => 'fake-token'))
const account = vi.hoisted(() => ({ server: 'https://service.test' }))
const registered = vi.hoisted(() => new Map<string, (...args: unknown[]) => Promise<unknown>>())
const notifyReauth = vi.hoisted(() => vi.fn())
vi.mock('electron', () => ({ net: { fetch: fetchMock }, ipcMain: {
  handle: (channel: string, handler: (...args: unknown[]) => Promise<unknown>) => registered.set(channel, handler)
} }))
vi.mock('../auth/reauth-notify', () => ({ broadcastReauthRequired: notifyReauth }))
vi.mock('../db/users', () => ({ userRepo: { get: () => ({ type: 'cinna_user', cinnaServerUrl: account.server }) } }))
vi.mock('../auth/cinna-tokens', () => ({ getCinnaAccessToken: tokenMock }))
vi.mock('../auth/cinna-oauth', () => ({ CinnaReauthRequired: class extends Error {} }))
vi.mock('../logger/logger', () => ({ createLogger: () => ({ error: vi.fn(), warn: vi.fn() }) }))

const { cinnaApiFetch } = await import('./cinnaApiService')
const { invalidateCinnaSession } = await import('../auth/cinna-session')
const { CinnaSessionChanged } = await import('../auth/cinna-session')
const { CinnaReauthRequired } = await import('../auth/cinna-oauth')
const { ipcHandle } = await import('../ipc/_wrap')

beforeEach(() => { fetchMock.mockReset(); notifyReauth.mockClear(); tokenMock.mockReset().mockResolvedValue('fake-token'); account.server = 'https://service.test' })
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers() })

describe('task adapter HTTP transport', () => {
  it('does not reopen sign-in for a replaced session, while real expiry still does', async () => {
    ipcHandle('test:stale', () => { throw new CinnaSessionChanged() })
    await expect(registered.get('test:stale')!({})).rejects.toBeInstanceOf(CinnaSessionChanged)
    expect(notifyReauth).not.toHaveBeenCalled()
    ipcHandle('test:expired', () => { throw new CinnaReauthRequired('Expired') })
    await expect(registered.get('test:expired')!({})).rejects.toBeInstanceOf(CinnaReauthRequired)
    expect(notifyReauth).toHaveBeenCalledWith('test:expired')
  })
  it.each(['session', 'server'])('does not send after the %s changes while credentials are resolving', async (change) => {
    let finish!: (token: string) => void
    tokenMock.mockReturnValueOnce(new Promise((resolve) => { finish = resolve }))
    const pending = cinnaApiFetch('user', '/api/v1/tasks/task/execute', { method: 'POST' })
    if (change === 'session') invalidateCinnaSession('user')
    else account.server = 'https://replacement.test'
    finish('replacement-token')
    await expect(pending).rejects.toMatchObject({ name: 'CinnaSessionChanged' })
    expect(fetchMock).not.toHaveBeenCalled()
  })
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
