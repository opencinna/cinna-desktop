import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import type { ChildProcess } from 'node:child_process'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { EngineLogin, engineLoginCommand, shellQuote, type EngineLoginDeps } from './engineLogin'

const log = vi.hoisted(() => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }))
vi.mock('../../../logger/logger', () => ({ createLogger: () => log }))

afterEach(() => {
  vi.useRealTimers()
  vi.clearAllMocks()
})

/**
 * The in-app login, driven with a fake child — no real `claude auth login` or
 * `codex login` ever runs here.
 */

interface FakeChild {
  child: ChildProcess
  kills: string[]
  stdout: PassThrough
  stderr: PassThrough
  exit(code: number | null, signal?: string | null): void
}

function fakeChild(options: { exitOnKill?: string[] } = {}): FakeChild {
  const emitter = new EventEmitter() as ChildProcess & EventEmitter
  const stdout = new PassThrough()
  const stderr = new PassThrough()
  const kills: string[] = []
  let exited = false
  const exit = (code: number | null, signal: string | null = null): void => {
    if (exited) return
    exited = true
    emitter.emit('exit', code, signal)
  }
  Object.assign(emitter, {
    stdout,
    stderr,
    kill: (signal: string) => {
      kills.push(signal)
      if ((options.exitOnKill ?? ['SIGTERM', 'SIGKILL']).includes(signal)) queueMicrotask(() => exit(null, signal))
      return true
    }
  })
  return { child: emitter, kills, stdout, stderr, exit }
}

function setup(overrides: Partial<EngineLoginDeps> = {}, childOptions?: { exitOnKill?: string[] }) {
  const children: FakeChild[] = []
  const spawn = vi.fn((_cmd: string, _args: readonly string[], _opts: unknown) => {
    const fake = fakeChild(childOptions)
    children.push(fake)
    return fake.child
  })
  const refresh = vi.fn(async () => ({ state: 'logged_out' }))
  const env = { HOME: '/home/test', PATH: '/usr/bin', CINNA_MARK: 'probe-env' }
  const login = new EngineLogin({
    engine: 'claude',
    binary: async () => ({ path: '/opt/cinna/runtimes/claude-2.1.276/claude' }),
    env: async () => env,
    refresh,
    spawn,
    platform: 'darwin',
    ...overrides
  })
  const spawned = async (): Promise<FakeChild> => {
    await vi.waitFor(() => expect(children.length).toBeGreaterThan(0))
    return children[children.length - 1]
  }
  return { login, spawn, refresh, env, children, spawned }
}

describe('engineLoginCommand', () => {
  it('quotes the absolute binary and appends the fixed subcommand', () => {
    expect(engineLoginCommand('claude', '/opt/App Support/claude', 'darwin')).toBe("'/opt/App Support/claude' auth login")
    expect(engineLoginCommand('codex', '/opt/codex', 'linux')).toBe("'/opt/codex' login")
  })

  it('survives a quote inside the path', () => {
    expect(shellQuote("/opt/o'brien/claude", 'darwin')).toBe(`'/opt/o'\\''brien/claude'`)
  })
})

describe('EngineLogin', () => {
  it('spawns the resolved binary with the fixed args, the probe env verbatim and no stdin', async () => {
    const { login, spawn, env, spawned } = setup()
    const result = login.start()
    const child = await spawned()
    expect(spawn).toHaveBeenCalledTimes(1)
    const [cmd, args, opts] = spawn.mock.calls[0]
    expect(cmd).toBe('/opt/cinna/runtimes/claude-2.1.276/claude')
    expect(args).toEqual(['auth', 'login'])
    expect((opts as { env: unknown }).env).toBe(env)
    expect((opts as { stdio: unknown }).stdio).toEqual(['ignore', 'pipe', 'pipe'])
    child.exit(0)
    await result
  })

  it('runs `login` for codex', async () => {
    const { login, spawn, spawned } = setup({ engine: 'codex', binary: async () => ({ path: '/opt/codex' }) })
    const result = login.start()
    ;(await spawned()).exit(1)
    expect(spawn.mock.calls[0][1]).toEqual(['login'])
    expect(await result).toEqual({ outcome: 'failed', command: "'/opt/codex' login" })
  })

  it('decides the outcome from the refreshed status, not the exit code', async () => {
    const loggedIn = setup({ refresh: vi.fn(async () => ({ state: 'logged_in' })) })
    const a = loggedIn.login.start()
    ;(await loggedIn.spawned()).exit(1)
    expect((await a).outcome).toBe('logged_in')

    const loggedOut = setup()
    const b = loggedOut.login.start()
    ;(await loggedOut.spawned()).exit(0)
    expect(await b).toEqual({
      outcome: 'failed',
      command: "'/opt/cinna/runtimes/claude-2.1.276/claude' auth login"
    })
    expect(loggedOut.refresh).toHaveBeenCalledTimes(1)
  })

  it('joins a login already in flight instead of starting a second', async () => {
    const { login, spawn, spawned } = setup()
    const first = login.start()
    const second = login.start()
    expect(second).toBe(first)
    expect(login.running()).not.toBeNull()
    ;(await spawned()).exit(0)
    await first
    expect(spawn).toHaveBeenCalledTimes(1)
    expect(login.running()).toBeNull()
  })

  it('cancel kills the child and reports cancelled, after refreshing the probe', async () => {
    const { login, refresh, spawned } = setup()
    const result = login.start()
    const child = await spawned()
    expect(login.cancel()).toBe(true)
    expect(child.kills).toEqual(['SIGTERM'])
    expect((await result).outcome).toBe('cancelled')
    expect(refresh).toHaveBeenCalledTimes(1)
  })

  it('escalates to SIGKILL when SIGTERM is ignored', async () => {
    const { login, spawned } = setup({ killGraceMs: 20 }, { exitOnKill: ['SIGKILL'] })
    const result = login.start()
    const child = await spawned()
    login.cancel()
    expect((await result).outcome).toBe('cancelled')
    expect(child.kills).toEqual(['SIGTERM', 'SIGKILL'])
  })

  it('kills the child on timeout and reports timeout', async () => {
    const { login, refresh, spawned } = setup({ timeoutMs: 20 })
    const result = login.start()
    const child = await spawned()
    expect((await result).outcome).toBe('timeout')
    expect(child.kills).toContain('SIGTERM')
    expect(refresh).toHaveBeenCalledTimes(1)
  })

  it('a cancel while the binary is still resolving settles cancelled at once, and the late binary spawns nothing', async () => {
    let release!: (value: { path: string }) => void
    const { login, spawn, refresh } = setup({ binary: () => new Promise((resolve) => { release = resolve }) })
    const result = login.start()
    expect(login.running()).toBe('preparing')
    expect(login.cancel()).toBe(true)
    // Settled while `binary()` is still pending — the download is not awaited.
    expect(await result).toEqual({ outcome: 'cancelled', command: null })
    expect(login.running()).toBeNull()
    // Nothing ran, so the probe's answer still stands.
    expect(refresh).not.toHaveBeenCalled()
    release({ path: '/opt/claude' })
    await new Promise((resolve) => setTimeout(resolve, 5))
    expect(spawn).not.toHaveBeenCalled()
    expect(refresh).not.toHaveBeenCalled()
  })

  it('a new login after an early cancel is a fresh one, not the abandoned download', async () => {
    let release!: (value: { path: string }) => void
    let calls = 0
    const { login, spawn, spawned } = setup({
      binary: () => (++calls === 1 ? new Promise((resolve) => { release = resolve }) : Promise.resolve({ path: '/opt/claude' }))
    })
    const first = login.start()
    login.cancel()
    await first
    const second = login.start()
    expect(second).not.toBe(first)
    const child = await spawned()
    // The abandoned first run finishing must not clear the second one.
    release({ path: '/opt/claude' })
    await new Promise((resolve) => setTimeout(resolve, 5))
    expect(login.running()).toBe('waiting')
    child.exit(1)
    expect((await second).outcome).toBe('failed')
    expect(spawn).toHaveBeenCalledTimes(1)
  })

  it('reports its phase: preparing, then waiting once the child runs', async () => {
    let release!: (value: { path: string }) => void
    const { login, spawned } = setup({ binary: () => new Promise((resolve) => { release = resolve }) })
    expect(login.running()).toBeNull()
    const result = login.start()
    expect(login.running()).toBe('preparing')
    release({ path: '/opt/claude' })
    const child = await spawned()
    expect(login.running()).toBe('waiting')
    child.exit(0)
    await result
    expect(login.running()).toBeNull()
  })

  it('an error after the child spawned (a failed kill) does not end the login; exit does', async () => {
    const { login, refresh, spawned } = setup({ refresh: vi.fn(async () => ({ state: 'logged_in' })) })
    const result = login.start()
    const child = await spawned()
    child.child.emit('spawn')
    child.child.emit('error', new Error('kill EPERM'))
    let settled = false
    void result.then(() => { settled = true })
    await new Promise((resolve) => setTimeout(resolve, 5))
    expect(settled).toBe(false)
    expect(refresh).not.toHaveBeenCalled()
    child.exit(0)
    expect((await result).outcome).toBe('logged_in')
  })

  it('a binary that cannot be resolved is failed with its reason and no command', async () => {
    const { login, spawn } = setup({ binary: async () => ({ error: 'Claude Code could not be installed.' }) })
    expect(await login.start()).toEqual({
      outcome: 'failed',
      command: null,
      reason: 'Claude Code could not be installed.'
    })
    expect(spawn).not.toHaveBeenCalled()
  })

  it('a spawn error is failed, and the probe is still refreshed', async () => {
    const { login, refresh, spawned } = setup()
    const result = login.start()
    const child = await spawned()
    child.child.emit('error', new Error('ENOENT'))
    expect((await result).outcome).toBe('failed')
    expect(refresh).toHaveBeenCalledTimes(1)
  })

  it('never rejects when the refresh does', async () => {
    const { login, spawned } = setup({ refresh: vi.fn(async () => { throw new Error('boom') }) })
    const result = login.start()
    ;(await spawned()).exit(0)
    expect((await result).outcome).toBe('failed')
  })

  it('shutdown kills a running login and does not ask the probe again', async () => {
    const { login, refresh, spawned } = setup()
    const result = login.start()
    const child = await spawned()
    await login.shutdown()
    expect(child.kills).toEqual(['SIGTERM'])
    expect((await result).outcome).toBe('cancelled')
    expect(refresh).not.toHaveBeenCalled()
  })

  it('shutdown while the binary resolves resolves at once and spawns nothing', async () => {
    let release!: (value: { path: string }) => void
    const { login, spawn, refresh } = setup({ binary: () => new Promise((resolve) => { release = resolve }) })
    const result = login.start()
    await login.shutdown()
    expect((await result).outcome).toBe('cancelled')
    release({ path: '/opt/claude' })
    await new Promise((resolve) => setTimeout(resolve, 5))
    expect(spawn).not.toHaveBeenCalled()
    expect(refresh).not.toHaveBeenCalled()
  })

  it('never logs, returns or retains what the child printed', async () => {
    const { login, spawned } = setup()
    const result = login.start()
    const child = await spawned()
    const secret = 'Paste code here if prompted > https://platform.claude.com/oauth/code/callback?code=SECRET-sk-123'
    child.stdout.write(secret)
    child.stderr.write('Logged in using an API key - sk-SECRET')
    await new Promise((resolve) => setTimeout(resolve, 5))
    child.exit(0)
    const outcome = await result
    const everything = JSON.stringify([
      outcome,
      log.debug.mock.calls,
      log.info.mock.calls,
      log.warn.mock.calls,
      log.error.mock.calls
    ])
    expect(everything).not.toMatch(/SECRET|oauth|Paste code/)
    expect(log.info).toHaveBeenCalledWith('engine login finished', expect.objectContaining({ exitCode: 0 }))
  })
})
