import { describe, it, expect, beforeEach, vi } from 'vitest'

/**
 * The activation guard's placement, which is the whole of this file's subject.
 *
 * `userActivation.requireActivated()` throws a **plain** `Error`
 * (`activation.ts:113`) and `ipcHandle` re-throws, so a guard sitting *outside*
 * the try makes the invoke reject — and a rejection loses its code at two IPC
 * boundaries, which is why `_wrap.ts` says to return the code as data rather
 * than throw it. Downstream, the renderer's typed-error check missed a plain
 * `Error` and the hook reported `error: null` with `data: []`: an inactive
 * session rendered as "No agents have reported status yet."
 *
 * The renderer half of that fix is pinned in `useAgentStatus.test.tsx`. This
 * file pins the main-process half: the handler resolves with a failure result
 * instead of rejecting.
 */

const handlers = vi.hoisted(() => new Map<string, (...args: unknown[]) => unknown>())
vi.mock('./_wrap', () => ({
  ipcHandle: (channel: string, fn: (...args: unknown[]) => unknown) => {
    handlers.set(channel, fn)
  }
}))

const activated = vi.hoisted(() => ({ current: true }))
vi.mock('../auth/activation', () => ({
  userActivation: {
    requireActivated: () => {
      if (!activated.current) {
        throw new Error('Session not activated — user must authenticate first')
      }
    }
  }
}))

const scopeThrows = vi.hoisted(() => ({ current: false }))
vi.mock('../auth/scope', () => ({
  getSettingsScopeUserId: () => '__default__',
  getProfileScopeUserId: () => {
    if (scopeThrows.current) throw new Error('no session')
    return 'u-named-profile'
  }
}))

const listMock = vi.hoisted(() => vi.fn())
const getMock = vi.hoisted(() => vi.fn())
vi.mock('../services/agentStatusService', () => ({
  agentStatusService: { list: listMock, get: getMock }
}))

vi.mock('electron', () => ({ net: { fetch: vi.fn() }, shell: {}, app: { on: () => undefined } }))
vi.mock('../logger/logger', () => ({
  createLogger: () => ({ debug: () => {}, info: () => {}, warn: () => {}, error: () => {} })
}))

const { registerAgentStatusHandlers } = await import('./agent_status.ipc')

beforeEach(() => {
  vi.clearAllMocks()
  handlers.clear()
  activated.current = true
  scopeThrows.current = false
  listMock.mockResolvedValue({ items: [], remoteError: null })
  getMock.mockResolvedValue(null)
  registerAgentStatusHandlers()
})

function invoke(channel: string, ...args: unknown[]): Promise<unknown> {
  const fn = handlers.get(channel)
  if (!fn) throw new Error(`test bug: ${channel} not registered`)
  return Promise.resolve(fn({} as never, ...args))
}

describe('agent-status:list — an inactive session is a result, not a rejection', () => {
  it('resolves with a failure result rather than rejecting', async () => {
    activated.current = false

    const result = (await invoke('agent-status:list')) as {
      success: boolean
      code?: string
      error?: string
    }

    // Consequence first: the renderer gets something it can render. A rejection
    // here arrived as `error: null, data: []` and printed a healthy panel.
    expect(result.success).toBe(false)
    expect(result.error).toContain('Session not activated')
    expect(result.code).toBeTruthy()
    // And the service was never asked, which is the point of the guard.
    expect(listMock).not.toHaveBeenCalled()
  })

  it('does not reject when reading the session itself fails', async () => {
    // `statusScope()` reads the current user, so it moved inside the try too.
    scopeThrows.current = true
    const result = (await invoke('agent-status:list')) as { success: boolean; error?: string }
    expect(result.success).toBe(false)
    expect(result.error).toContain('no session')
  })

  it('still answers normally when the session is active', async () => {
    listMock.mockResolvedValue({ items: [{ agentId: 'folder:alpha' }], remoteError: null })
    const result = (await invoke('agent-status:list')) as {
      success: boolean
      items: unknown[]
    }
    expect(result.success).toBe(true)
    expect(result.items).toHaveLength(1)
  })
})

describe('agent-status:get — the same guard, the same placement', () => {
  it('resolves with a failure result rather than rejecting', async () => {
    activated.current = false

    const result = (await invoke('agent-status:get', { agentId: 'folder:alpha' })) as {
      success: boolean
      error?: string
    }

    expect(result.success).toBe(false)
    expect(result.error).toContain('Session not activated')
    expect(getMock).not.toHaveBeenCalled()
  })

  it('still answers normally when the session is active', async () => {
    getMock.mockResolvedValue({ agentId: 'folder:alpha' })
    const result = (await invoke('agent-status:get', { agentId: 'folder:alpha' })) as {
      success: boolean
      item: unknown
    }
    expect(result.success).toBe(true)
    expect(result.item).toEqual({ agentId: 'folder:alpha' })
  })
})
