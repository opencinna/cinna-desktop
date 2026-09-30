vi.mock('../host/runtimeHost', async () => {
  const { createDesktopHost } = await import('../host/desktop/runtimeHost')
  return { runtimeHost: createDesktopHost() }
})
import { describe, it, expect, beforeEach, vi } from 'vitest'

/**
 * The order of the two refreshes behind one button, which is the whole of this
 * file's subject.
 *
 * Settings → Local Agents → **Refresh** re-detects the user's tools, and since
 * the Claude engine's readiness gained a second half it re-asks the login too.
 * The two look independent and are not: `claudeAuthProbe` resolves its path
 * through `toolDetectionService.get`, which reads the memoized `detection`
 * promise **synchronously** — no `await` between the probe's entry and that
 * read. Started before `toolDetectionService.refresh()`, it therefore answers
 * from the cache that call is about to discard.
 *
 * The user it fails is the one the button exists for: someone who has just
 * installed Claude Code. Detection comes back correct, the login probe answers
 * `unknown` off the stale cache, and that `unknown` is then held for the
 * probe's own window — so a fresh install that is *logged out* withholds the
 * one alarm the feature was built to raise, for the whole of it.
 */

const handlers = vi.hoisted(() => new Map<string, (...args: unknown[]) => unknown>())
vi.mock('./_wrap', () => ({
  ipcHandle: (channel: string, fn: (...args: unknown[]) => unknown) => {
    handlers.set(channel, fn)
  }
}))

vi.mock('../auth/activation', () => ({
  userActivation: { requireActivated: () => {} }
}))

/**
 * A fake of the real memoization, kept faithful in the one way that matters:
 * `list()` is **not** async, so `detection` is read on the caller's own tick.
 * An `async list()` here would swallow the bug this file is about.
 */
const detect = vi.hoisted(() => {
  const state = { generation: 0, installed: false, detection: null as Promise<string | null> | null }
  return {
    state,
    list(): Promise<string | null> {
      state.detection ??= Promise.resolve(state.installed ? `/usr/local/bin/claude#${state.generation}` : null)
      return state.detection
    },
    refresh(): Promise<string | null> {
      state.detection = null
      state.generation += 1
      return this.list()
    }
  }
})

vi.mock('../services/localAgents/toolDetectionService', () => ({
  toolDetectionService: {
    list: () => detect.list(),
    refresh: () => detect.refresh(),
    get: async () => {
      const path = await detect.list()
      return path ? { id: 'claude', path, available: true } : { id: 'claude', path: null, available: false }
    }
  }
}))

/** Records the path each probe resolved, so staleness is visible in the result. */
const probed = vi.hoisted(() => ({ paths: [] as (string | null)[] }))
const logins = vi.hoisted(() => {
  const make = (engine: string) => ({
    start: vi.fn(async () => ({ outcome: 'logged_in', command: `'/opt/${engine}' login` })),
    cancel: vi.fn(() => true),
    running: vi.fn((): 'preparing' | 'waiting' | null => null)
  })
  return { claude: make('claude'), codex: make('codex') }
})
vi.mock('../agents/drivers', () => ({
  engineLogins: logins,
  codexAuthProbe: { status: async () => ({ state: 'unknown' }), refresh: async () => ({ state: 'unknown' }) },
  claudeAuthProbe: {
    status: async () => ({ state: 'unknown', authMethod: null, subscriptionType: null }),
    refresh: async () => {
      // The real probe's first act, and the line that reads the cache.
      const path = (await detect.list().then((p) => p)) as string | null
      probed.paths.push(path)
      return { state: path ? 'logged_in' : 'unknown', authMethod: null, subscriptionType: null }
    }
  }
}))

vi.mock('../services/localAgents/openInService', () => ({ openInService: { openIn: async () => {} } }))
/**
 * The registrar subscribes to installer progress and forwards it to the window,
 * so both of those have to exist for the module to load at all. Neither is this
 * file's subject — it is about the order of two refreshes — and `../index` is
 * the whole main entry point, which pulls Electron in.
 */
vi.mock('../services/localAgents/toolInstallService', () => ({
  toolInstallService: {
    onProgress: () => () => {},
    plans: () => [],
    install: async () => ({ id: 'claude', state: 'done', line: null, error: null })
  }
}))
vi.mock('../index', () => ({ getMainWindow: () => null }))
/**
 * The registrar also settles this machine's Default runtime at startup, which
 * reads the settings store and the agents table. Neither is this file's subject
 * — it is about the order of two refreshes — and `lockIfUnset` returning null
 * (already decided) is the state every launch but the first is in.
 */
vi.mock('../services/localAgents/defaultEngineService', () => ({
  defaultEngineService: { lockIfUnset: async () => null }
}))
vi.mock('../services/localAgents/localAgentService', () => ({
  localAgentService: { rescan: () => [] }
}))
vi.mock('../auth/scope', () => ({ getSettingsScopeUserId: () => '__default__' }))
vi.mock('electron', () => ({ app: { on: () => undefined }, shell: {} }))
vi.mock('../logger/logger', () => ({
  createLogger: () => ({ debug: () => {}, info: () => {}, warn: () => {}, error: () => {} })
}))

const { registerLocalToolsHandlers } = await import('./local_tools.ipc')
registerLocalToolsHandlers()

beforeEach(() => {
  probed.paths.length = 0
  detect.state.generation = 0
  detect.state.installed = false
  detect.state.detection = null
})

async function refresh(): Promise<unknown> {
  const handler = handlers.get('local-tools:refresh')
  if (!handler) throw new Error('local-tools:refresh was never registered')
  return handler({})
}

describe('local-tools:refresh', () => {
  it('re-asks the login against the detection it just refreshed, not the one it discarded', async () => {
    // The app has been running with no Claude Code; the user installs it and
    // presses Refresh.
    await detect.list()
    expect(detect.state.detection).not.toBeNull()
    detect.state.installed = true

    await refresh()
    // Let the fire-and-forget probe run.
    await Promise.resolve()
    await Promise.resolve()

    expect(probed.paths).toHaveLength(1)
    // Generation 1 is the post-refresh pass. `null` would be the stale cache —
    // the machine as it was before the user installed anything.
    expect(probed.paths[0]).toBe('/usr/local/bin/claude#1')
  })

  it('still answers with the detected tools when the login probe fails', async () => {
    detect.state.installed = true
    const tools = await refresh()
    expect(tools).toBe('/usr/local/bin/claude#1')
  })
})

/**
 * The in-app login: the renderer sends an engine id and nothing else, and main
 * runs a command it owns. Anything that is not one of the two literals starts
 * nothing.
 */
describe('local-tools:engine-login', () => {
  const call = (channel: string, ...args: unknown[]): unknown => {
    const handler = handlers.get(channel)
    if (!handler) throw new Error(`${channel} was never registered`)
    return handler({}, ...args)
  }

  beforeEach(() => {
    for (const login of [logins.claude, logins.codex]) {
      login.start.mockClear()
      login.cancel.mockClear()
      login.running.mockClear()
    }
  })

  it('starts the login for a known engine and answers with its outcome', async () => {
    await expect(call('local-tools:engine-login', 'codex')).resolves.toEqual({
      outcome: 'logged_in',
      command: "'/opt/codex' login"
    })
    expect(logins.codex.start).toHaveBeenCalledTimes(1)
    expect(logins.claude.start).not.toHaveBeenCalled()
  })

  it.each([['opencode'], ['claude; rm -rf /'], [{ engine: 'claude' }], [undefined], ['__proto__']])(
    'refuses %j as data and starts nothing',
    async (engine) => {
      await expect(call('local-tools:engine-login', engine)).resolves.toMatchObject({ outcome: 'failed', command: null })
      expect(call('local-tools:engine-login-cancel', engine)).toBe(false)
      expect(logins.claude.start).not.toHaveBeenCalled()
      expect(logins.codex.start).not.toHaveBeenCalled()
      expect(logins.claude.cancel).not.toHaveBeenCalled()
      expect(logins.codex.cancel).not.toHaveBeenCalled()
    }
  )

  it('cancels only the named engine', () => {
    expect(call('local-tools:engine-login-cancel', 'claude')).toBe(true)
    expect(logins.claude.cancel).toHaveBeenCalledTimes(1)
    expect(logins.codex.cancel).not.toHaveBeenCalled()
  })

  it('reports which logins are running, with their phase', () => {
    logins.codex.running.mockReturnValueOnce('preparing')
    expect(call('local-tools:engine-login-running')).toEqual({ claude: null, codex: 'preparing' })
    logins.claude.running.mockReturnValueOnce('waiting')
    expect(call('local-tools:engine-login-running')).toEqual({ claude: 'waiting', codex: null })
  })
})
