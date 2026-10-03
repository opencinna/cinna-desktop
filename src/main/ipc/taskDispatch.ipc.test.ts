import { describe, it, expect, beforeEach, vi } from 'vitest'
import type { IpcMainInvokeEvent } from 'electron'

/**
 * `taskDispatch:*` is an adapter: it resolves the profile, checks activation,
 * narrows the payload and hands everything else to the dispatcher. Refusals
 * come back as data.
 */

const handlers = vi.hoisted(() => new Map<string, (...args: unknown[]) => unknown>())
vi.mock('./_wrap', () => ({
  ipcHandle: (channel: string, handler: (...args: unknown[]) => unknown) => { handlers.set(channel, handler) }
}))
const requireActivated = vi.hoisted(() => vi.fn())
vi.mock('../auth/activation', () => ({ userActivation: { requireActivated } }))
vi.mock('../auth/scope', () => ({ getProfileScopeUserId: () => 'profile-1', getSettingsScopeUserId: () => 'settings-1' }))
const dispatcher = vi.hoisted(() => ({
  list: vi.fn(async () => []),
  get: vi.fn(async () => null),
  setMode: vi.fn(async () => ({ ok: true })),
  resume: vi.fn(async () => ({ ok: true })),
  runNext: vi.fn(async () => ({ ok: true, gate: 'dgate_1' }))
}))
vi.mock('../services/taskDispatchService', () => ({ taskDispatchService: dispatcher }))

const { registerTaskDispatchHandlers } = await import('./taskDispatch.ipc')
const SCOPE = { profileUserId: 'profile-1', settingsUserId: 'settings-1' }

async function invoke(channel: string, ...args: unknown[]): Promise<unknown> {
  const handler = handlers.get(channel)
  expect(handler, `${channel} is not registered`).toBeTruthy()
  return (handler as (...a: unknown[]) => unknown)({} as IpcMainInvokeEvent, ...args)
}

beforeEach(() => {
  vi.clearAllMocks()
  handlers.clear()
  registerTaskDispatchHandlers()
})

describe('taskDispatch channels', () => {
  it.each([
    ['taskDispatch:list', [], 'list', [SCOPE]],
    ['taskDispatch:get', ['agent-a'], 'get', [SCOPE, 'agent-a']],
    ['taskDispatch:set-mode', ['agent-a', 'one'], 'setMode', [SCOPE, 'agent-a', 'one']],
    ['taskDispatch:resume', ['agent-a'], 'resume', [SCOPE, 'agent-a']],
    ['taskDispatch:run-next', ['agent-a', 't-1'], 'runNext', [SCOPE, 'agent-a', 't-1']]
  ] as const)('%s requires activation and calls the dispatcher in the active profile', async (channel, args, method, expected) => {
    await invoke(channel, ...args)
    expect(requireActivated).toHaveBeenCalled()
    expect(dispatcher[method]).toHaveBeenCalledWith(...expected)
  })

  it('answers a mode it does not know as data', async () => {
    await expect(invoke('taskDispatch:set-mode', 'agent-a', 'up_to_3')).resolves.toMatchObject({ ok: false, code: 'invalid_input' })
    expect(dispatcher.setMode).not.toHaveBeenCalled()
  })

  it('returns the gate Run next answered with', async () => {
    await expect(invoke('taskDispatch:run-next', 'agent-a')).resolves.toEqual({ ok: true, gate: 'dgate_1' })
  })
})
