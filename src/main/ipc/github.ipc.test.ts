import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * The `github:*` handlers are transport: activation first, the active profile (never a user id
 * from the renderer), refusals as data, and only github.com pages opened, two of them by fixed
 * name and an install page only from the need main stored.
 */

const handlers = vi.hoisted(() => new Map<string, (...args: unknown[]) => unknown>())
const requireActivated = vi.hoisted(() => vi.fn())
const profile = vi.hoisted(() => ({ id: 'alice' }))
const openExternal = vi.hoisted(() => vi.fn(async (_url: string): Promise<void> => {}))
const service = vi.hoisted(() => ({
  status: vi.fn(async (_userId: string) => ({ account: null, device: null, needs: [] as unknown[] })),
  startDeviceFlow: vi.fn(async (_userId: string) => ({ userCode: 'ABCD-1234', verificationUri: 'https://github.com/login/device', expiresAt: 1, state: 'pending' })),
  cancelDeviceFlow: vi.fn(),
  signOut: vi.fn(),
  checkAgain: vi.fn(async (_userId: string) => ({ account: null, device: null, needs: [] })),
  dismiss: vi.fn()
}))

vi.mock('./_wrap', () => ({ ipcHandle: (channel: string, fn: (...args: unknown[]) => unknown) => handlers.set(channel, fn) }))
vi.mock('../auth/activation', () => ({ userActivation: { requireActivated } }))
vi.mock('../auth/scope', () => ({ getProfileScopeUserId: () => profile.id }))
vi.mock('../host/runtimeHost', () => ({ runtimeHost: { shell: { openExternal } } }))
vi.mock('../services/github/githubAuthService', () => ({ githubAuthService: service }))

const { registerGithubHandlers } = await import('./github.ipc')
registerGithubHandlers()
const call = (channel: string, ...args: unknown[]): Promise<unknown> => handlers.get(channel)!({}, ...args) as Promise<unknown>

beforeEach(() => {
  vi.clearAllMocks()
  requireActivated.mockImplementation(() => {})
  profile.id = 'alice'
})

describe('github IPC', () => {
  it('answers for the active profile, after activation', async () => {
    profile.id = 'bob'
    expect(await call('github:status')).toEqual({ ok: true, value: { account: null, device: null, needs: [] } })
    expect(requireActivated).toHaveBeenCalled()
    expect(service.status).toHaveBeenCalledWith('bob')
    await call('github:sign-out')
    expect(service.signOut).toHaveBeenCalledWith('bob')
    await call('github:dismiss', 'account')
    expect(service.dismiss).toHaveBeenCalledWith('bob', 'account')
  })

  it('returns a refusal as data, never a throw', async () => {
    requireActivated.mockImplementation(() => { throw new Error('Session not activated') })
    expect(await call('github:status')).toEqual({ ok: false, error: 'Session not activated' })
    expect(service.status).not.toHaveBeenCalled()
    requireActivated.mockImplementation(() => {})
    service.startDeviceFlow.mockRejectedValueOnce(new Error('This profile is locked. Unlock it to sign in to GitHub.'))
    expect(await call('github:sign-in')).toEqual({ ok: false, error: 'This profile is locked. Unlock it to sign in to GitHub.' })
    expect(openExternal).not.toHaveBeenCalled()
  })

  it('starts the device flow and opens its github.com page', async () => {
    const answer = await call('github:sign-in')
    expect(answer).toMatchObject({ ok: true, value: { userCode: 'ABCD-1234' } })
    expect(service.startDeviceFlow).toHaveBeenCalledWith('alice')
    expect(openExternal).toHaveBeenCalledWith('https://github.com/login/device')
  })

  it('never opens a verification page that is not github.com', async () => {
    service.startDeviceFlow.mockResolvedValueOnce({ userCode: 'X', verificationUri: 'https://evil.example/login', expiresAt: 1, state: 'pending' })
    expect(await call('github:sign-in')).toMatchObject({ ok: false })
    expect(openExternal).not.toHaveBeenCalled()
  })

  it('opens only the two fixed pages by name', async () => {
    expect(await call('github:open-url', 'manage')).toEqual({ ok: true, value: null })
    expect(openExternal).toHaveBeenLastCalledWith('https://github.com/apps/opencinna/installations/new')
    expect(await call('github:open-url', 'applications')).toEqual({ ok: true, value: null })
    expect(openExternal).toHaveBeenLastCalledWith('https://github.com/settings/applications')
    openExternal.mockClear()
    for (const target of ['https://evil.example', 'toString', '__proto__', 'constructor', '', null, 42, { manage: 1 }]) {
      expect(await call('github:open-url', target)).toMatchObject({ ok: false })
    }
    expect(openExternal).not.toHaveBeenCalled()
  })

  it('opens an install page only from the need main stored, by key', async () => {
    service.status.mockResolvedValue({
      account: null, device: null,
      needs: [
        { key: 'install:acme', kind: 'install', owner: 'acme', repos: ['acme/shop'], installUrl: 'https://github.com/organizations/acme/settings/installations/7', agentIds: ['a1'] },
        { key: 'install:bad', kind: 'install', owner: 'bad', installUrl: 'file:///etc/passwd', agentIds: ['a1'] },
        { key: 'account', kind: 'sign_in', agentIds: ['a1'] }
      ]
    })
    expect(await call('github:open-install', 'install:acme')).toEqual({ ok: true, value: null })
    expect(openExternal).toHaveBeenCalledWith('https://github.com/organizations/acme/settings/installations/7')
    openExternal.mockClear()
    for (const key of ['install:bad', 'account', 'install:none', 7]) expect(await call('github:open-install', key)).toMatchObject({ ok: false })
    expect(openExternal).not.toHaveBeenCalled()
  })

  it('says when the browser did not open', async () => {
    openExternal.mockRejectedValueOnce(new Error('no handler'))
    expect(await call('github:open-url', 'manage')).toEqual({ ok: false, error: 'Couldn’t open your browser. Go to https://github.com/apps/opencinna/installations/new yourself.' })
  })

  it('reads the installations at most once per 10 s per profile', async () => {
    vi.useFakeTimers()
    try {
      vi.setSystemTime(1_000_000)
      profile.id = 'carol'
      await call('github:check-again')
      await call('github:check-again')
      expect(service.checkAgain).toHaveBeenCalledTimes(1)
      expect(service.status).toHaveBeenCalledWith('carol')
      profile.id = 'dave'
      await call('github:check-again')
      expect(service.checkAgain).toHaveBeenCalledTimes(2)
      profile.id = 'carol'
      vi.setSystemTime(1_010_001)
      await call('github:check-again')
      expect(service.checkAgain).toHaveBeenCalledTimes(3)
    } finally {
      vi.useRealTimers()
    }
  })
})
