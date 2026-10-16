import { describe, expect, it, vi } from 'vitest'
import type { EngineBinaryState, EngineLoginId, EngineLoginResult, RuntimeSetupEvent } from '../../../shared/engine'

/**
 * **Runtime setup**: a card's Install chip, or a pick of an installed runtime,
 * becomes install → login check → in-app login, in main. Nothing downloads
 * without `install`, and only a definite `logged_out` opens a login.
 */

vi.mock('../../host/events', () => ({ publishEvent: () => {} }))
vi.mock('../../agents/drivers', () => ({ claudeAuthProbe: {}, codexAuthProbe: {}, antigravityAuthProbe: {}, engineLogins: {} }))
vi.mock('../../engine/engineBinaryService', () => ({ claudeBinaryService: {}, codexBinaryService: {}, antigravityBinaryService: {} }))
vi.mock('../../managed/managedAsset', () => ({ ManagedAssetError: class extends Error {} }))
vi.mock('../../agents/drivers/acp/acpLaunchers', () => ({ CLAUDE_NOT_INSTALLED: 'no claude' }))
vi.mock('../../agents/drivers/acp/codexLauncher', () => ({ CODEX_NOT_INSTALLED: 'no codex' }))
vi.mock('../../agents/drivers/acp/antigravityEnv', () => ({ ANTIGRAVITY_NOT_INSTALLED: 'no antigravity' }))
vi.mock('../../logger/logger', () => ({
  createLogger: () => ({ debug: () => {}, info: () => {}, warn: () => {}, error: () => {} })
}))

const { createRuntimeSetup } = await import('./runtimeSetupService')

function deps(overrides: {
  binary?: EngineBinaryState
  auth?: string | Promise<string>
  login?: EngineLoginResult | Promise<EngineLoginResult>
  ensure?: () => Promise<void>
} = {}) {
  const calls = { peek: [] as string[], ensure: [] as string[], auth: [] as string[], login: [] as string[], cancel: [] as string[] }
  const events: RuntimeSetupEvent[] = []
  return {
    calls,
    events,
    deps: {
      peek: async (engine: EngineLoginId) => {
        calls.peek.push(engine)
        return overrides.binary ?? ({ state: 'ready', path: '/bin/x', source: 'managed', version: '1' } as EngineBinaryState)
      },
      ensure: async (engine: EngineLoginId) => {
        calls.ensure.push(engine)
        await overrides.ensure?.()
      },
      refreshAuth: async (engine: EngineLoginId) => {
        calls.auth.push(engine)
        return { state: await (overrides.auth ?? 'logged_in') }
      },
      login: async (engine: EngineLoginId) => {
        calls.login.push(engine)
        return overrides.login ?? { outcome: 'logged_in' as const, command: null }
      },
      cancelLogin: (engine: EngineLoginId) => {
        calls.cancel.push(engine)
        return true
      },
      publish: (event: RuntimeSetupEvent) => {
        events.push(event)
      }
    }
  }
}

const NOT_ON_DISK: EngineBinaryState = { state: 'unresolved' }

describe('runtime setup', () => {
  it('reports needs_install without downloading when the binary is not on disk and install is false', async () => {
    const { calls, deps: d } = deps({ binary: NOT_ON_DISK, auth: 'logged_out' })
    expect(await createRuntimeSetup(d).setup('codex', { install: false })).toEqual({ outcome: 'needs_install' })
    expect(calls.ensure).toEqual([])
    expect(calls.auth).toEqual([])
    expect(calls.login).toEqual([])
  })

  it('treats a failed earlier install as not on disk too', async () => {
    const { calls, deps: d } = deps({ binary: { state: 'failed', error: 'offline' } })
    expect(await createRuntimeSetup(d).setup('claude')).toEqual({ outcome: 'needs_install' })
    expect(calls.ensure).toEqual([])
  })

  it('installs on request, then starts the login on a definite logged_out', async () => {
    const { calls, deps: d } = deps({ binary: NOT_ON_DISK, auth: 'logged_out' })
    expect(await createRuntimeSetup(d).setup('antigravity', { install: true })).toEqual({ outcome: 'ready' })
    expect(calls).toMatchObject({ ensure: ['antigravity'], auth: ['antigravity'], login: ['antigravity'] })
  })

  it('starts the login for an installed engine without install', async () => {
    const { calls, deps: d } = deps({ auth: 'logged_out' })
    expect(await createRuntimeSetup(d).setup('claude', { install: false })).toEqual({ outcome: 'ready' })
    expect(calls.login).toEqual(['claude'])
  })

  it('never starts a login on an unknown probe', async () => {
    const { calls, deps: d } = deps({ auth: 'unknown' })
    expect(await createRuntimeSetup(d).setup('claude')).toEqual({ outcome: 'auth_unknown' })
    expect(calls.login).toEqual([])
  })

  it('starts no login when already logged in', async () => {
    const { calls, deps: d } = deps({ auth: 'logged_in' })
    expect(await createRuntimeSetup(d).setup('codex')).toEqual({ outcome: 'ready' })
    expect(calls.login).toEqual([])
  })

  it('reports a failed install with its reason and goes no further', async () => {
    const { calls, deps: d } = deps({ binary: NOT_ON_DISK, ensure: () => Promise.reject(new Error('download refused')) })
    expect(await createRuntimeSetup(d).setup('codex', { install: true })).toEqual({ outcome: 'install_failed', reason: 'download refused' })
    expect(calls.auth).toEqual([])
    expect(calls.login).toEqual([])
  })

  it('reports a failed login as data', async () => {
    const login: EngineLoginResult = { outcome: 'timeout', command: 'codex login' }
    const { deps: d } = deps({ auth: 'logged_out', login })
    expect(await createRuntimeSetup(d).setup('codex')).toEqual({ outcome: 'login_failed', login })
  })

  it('joins concurrent calls for one engine, reports the phase meanwhile and pushes the end', async () => {
    let finishLogin!: (result: EngineLoginResult) => void
    const { calls, events, deps: d } = deps({
      auth: 'logged_out',
      login: new Promise((resolve) => { finishLogin = resolve })
    })
    const service = createRuntimeSetup(d)
    expect(service.running()).toEqual({ claude: null, codex: null, antigravity: null })
    const first = service.setup('claude', { install: true })
    const second = service.setup('claude', { install: false })
    await vi.waitFor(() => expect(service.running().claude).toBe('signing_in'))
    finishLogin({ outcome: 'logged_in', command: null })
    expect(await first).toEqual({ outcome: 'ready' })
    expect(await second).toEqual({ outcome: 'ready' })
    expect(calls.ensure).toEqual(['claude'])
    expect(calls.login).toEqual(['claude'])
    expect(service.running().claude).toBeNull()
    expect(events.map((event) => event.running.claude)).toEqual(['installing', 'checking', 'signing_in', null])
    expect(events.at(-1)?.ended).toEqual({ engine: 'claude', result: { outcome: 'ready' } })
  })

  it('cancel stops the login and ends the run cleanly', async () => {
    let finishLogin!: (result: EngineLoginResult) => void
    const { calls, events, deps: d } = deps({
      auth: 'logged_out',
      login: new Promise((resolve) => { finishLogin = resolve })
    })
    d.cancelLogin = (engine: EngineLoginId) => {
      calls.cancel.push(engine)
      finishLogin({ outcome: 'cancelled', command: null })
      return true
    }
    const service = createRuntimeSetup(d)
    const run = service.setup('antigravity')
    await vi.waitFor(() => expect(service.running().antigravity).toBe('signing_in'))
    expect(service.cancel('antigravity')).toBe(true)
    expect(await run).toEqual({ outcome: 'cancelled' })
    expect(calls.cancel).toEqual(['antigravity'])
    expect(service.running().antigravity).toBeNull()
    expect(events.at(-1)?.ended).toEqual({ engine: 'antigravity', result: { outcome: 'cancelled' } })
  })

  it('cancel during the install ends the run before any login', async () => {
    let finishInstall!: () => void
    const { calls, deps: d } = deps({
      binary: NOT_ON_DISK,
      auth: 'logged_out',
      ensure: () => new Promise<void>((resolve) => { finishInstall = resolve })
    })
    const service = createRuntimeSetup(d)
    const run = service.setup('codex', { install: true })
    await vi.waitFor(() => expect(service.running().codex).toBe('installing'))
    service.cancel('codex')
    finishInstall()
    expect(await run).toEqual({ outcome: 'cancelled' })
    expect(calls.login).toEqual([])
  })

  it('a caller that joins with install while the look runs gets the install', async () => {
    let finishPeek!: (state: EngineBinaryState) => void
    const { calls, deps: d } = deps({ auth: 'logged_in' })
    d.peek = (engine: EngineLoginId) => {
      calls.peek.push(engine)
      return new Promise((resolve) => { finishPeek = resolve })
    }
    const service = createRuntimeSetup(d)
    const first = service.setup('codex', { install: false })
    const second = service.setup('codex', { install: true })
    finishPeek(NOT_ON_DISK)
    expect(await first).toEqual({ outcome: 'ready' })
    expect(await second).toEqual({ outcome: 'ready' })
    expect(calls.ensure).toEqual(['codex'])
    expect(calls.peek).toEqual(['codex'])
  })

  it('a forced login (the user pressed Log in) logs in on an unknown probe', async () => {
    const { calls, deps: d } = deps({ auth: 'unknown' })
    expect(await createRuntimeSetup(d).setup('claude', { install: false, login: 'force' })).toEqual({ outcome: 'ready' })
    expect(calls.login).toEqual(['claude'])
  })

  it('a forced login still skips the login when already logged in', async () => {
    const { calls, deps: d } = deps({ auth: 'logged_in' })
    expect(await createRuntimeSetup(d).setup('claude', { login: 'force' })).toEqual({ outcome: 'ready' })
    expect(calls.login).toEqual([])
  })

  it('refuses an unknown engine without doing anything', async () => {
    const { calls, deps: d } = deps()
    expect((await createRuntimeSetup(d).setup('opencode')).outcome).toBe('install_failed')
    expect(calls.peek).toEqual([])
  })
})
