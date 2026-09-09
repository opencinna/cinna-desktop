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
vi.mock('../services/agentTurn', () => ({
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
