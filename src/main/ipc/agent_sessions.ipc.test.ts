import { describe, it, expect, beforeEach, vi } from 'vitest'
import type { IpcMainInvokeEvent } from 'electron'

/**
 * `agentSessions:active` is an adapter: the active profile's running sessions,
 * and "no profile yet" as data rather than a thrown error.
 */

const handlers = vi.hoisted(() => new Map<string, (...args: unknown[]) => unknown>())
vi.mock('./_wrap', () => ({
  ipcHandle: (channel: string, handler: (...args: unknown[]) => unknown) => { handlers.set(channel, handler) }
}))
const activated = vi.hoisted(() => ({ value: true }))
vi.mock('../auth/activation', () => ({ userActivation: { isActivated: () => activated.value } }))
vi.mock('../auth/scope', () => ({ getProfileScopeUserId: () => 'profile-1' }))
const activeAgentSessions = vi.hoisted(() => vi.fn(() => [{ agentId: 'agent-a', chatId: 'c-1', title: 'Reconcile August' }]))
vi.mock('../services/activeAgentSessions', () => ({ activeAgentSessions }))

const { registerAgentSessionHandlers } = await import('./agent_sessions.ipc')

function invoke(): Promise<unknown> {
  return (handlers.get('agentSessions:active') as (event: IpcMainInvokeEvent) => Promise<unknown>)({} as IpcMainInvokeEvent)
}

beforeEach(() => {
  vi.clearAllMocks()
  handlers.clear()
  activated.value = true
  registerAgentSessionHandlers()
})

describe('agentSessions:active', () => {
  it('answers with the active profile’s running sessions', async () => {
    await expect(invoke()).resolves.toEqual({ ok: true, sessions: [{ agentId: 'agent-a', chatId: 'c-1', title: 'Reconcile August' }] })
    expect(activeAgentSessions).toHaveBeenCalledWith('profile-1')
  })

  it('answers before activation as data, reading nothing', async () => {
    activated.value = false
    await expect(invoke()).resolves.toMatchObject({ ok: false, code: 'not_activated' })
    expect(activeAgentSessions).not.toHaveBeenCalled()
  })
})
