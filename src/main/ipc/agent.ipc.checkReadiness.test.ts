vi.mock('../host/runtimeHost', async () => {
  const { createDesktopHost } = await import('../host/desktop/runtimeHost')
  return { runtimeHost: createDesktopHost() }
})
import { describe, it, expect, vi, beforeEach } from 'vitest'

/**
 * `agent:check-readiness` — the composer's *Check again* and the Settings
 * card's Test.
 *
 * The one fact worth pinning here is easy to lose and invisible when lost: the
 * check is **fresh**. The Claude driver answers a list-time check from its
 * login probe's cache and the tool detection memo; only a fresh check goes past
 * them. This channel once called `refresh` without the option while every
 * layer below it had learned to carry it, and nothing failed — *Check again*
 * after `claude login` simply kept refusing. `registration.test.ts` proves the
 * channel exists; this proves what it asks for.
 */

const handlers = new Map<string, (...args: unknown[]) => unknown>()
vi.mock('./_wrap', () => ({
  ipcHandle: (channel: string, handler: (...args: unknown[]) => unknown) => {
    handlers.set(channel, handler)
  }
}))
vi.mock('electron', () => ({ ipcMain: { on: () => undefined, handle: () => undefined } }))
vi.mock('../logger/logger', () => ({
  createLogger: () => ({ debug: () => {}, info: () => {}, warn: () => {}, error: () => {} })
}))
vi.mock('../index', () => ({ getMainWindow: () => null }))
vi.mock('../auth/activation', () => ({
  userActivation: { isActivated: () => true, requireActivated: () => undefined }
}))
vi.mock('../auth/scope', () => ({
  getProfileScopeUserId: () => 'profile-user',
  getSettingsScopeUserId: () => 'settings-user'
}))
vi.mock('../auth/cinna-oauth', () => ({
  CinnaReauthRequired: class CinnaReauthRequired extends Error {}
}))
vi.mock('../agents/remote-sync', () => ({ notifyRemoteSyncComplete: vi.fn() }))
vi.mock('./agent_a2a.ipc', () => ({ registerA2AHandlers: vi.fn() }))

const driverReadiness = vi.fn(async () => ({ state: 'ok' as const, reason: null }))
vi.mock('../agents/drivers', () => ({
  driverFor: () => ({ readiness: (...args: unknown[]) => driverReadiness(...(args as [])) })
}))

type Deps = { probe: (userId: string, row: unknown, options?: { fresh?: boolean }) => Promise<unknown> }
const installed: { deps: Deps | null } = { deps: null }
const refresh = vi.fn(async () => ({ state: 'ok' as const, reason: null }))
vi.mock('../services/agentReadinessService', () => ({
  agentReadinessService: {
    install: (deps: Deps) => {
      installed.deps = deps
    },
    refresh: (...args: unknown[]) => refresh(...(args as []))
  }
}))

const ROW = { id: 'folder:c', name: 'Claude agent', driver: 'claude', source: 'folder' }
const findAgent = vi.fn((): unknown => ({ row: ROW, userId: 'settings-user' }))
vi.mock('../services/agentService', () => ({
  agentService: {
    findAgent: (...args: unknown[]) => findAgent(...(args as [])),
    listMerged: vi.fn(() => [])
  }
}))


const { registerAgentHandlers } = await import('./agent.ipc')
const { installAgentReadiness } = await import('../hub/agentReadiness')

beforeEach(() => {
  handlers.clear()
  refresh.mockClear()
  driverReadiness.mockClear()
  findAgent.mockClear()
  installAgentReadiness()
  registerAgentHandlers()
})

const check = (agentId: string): Promise<unknown> =>
  Promise.resolve(handlers.get('agent:check-readiness')?.({}, agentId))

describe('agent:check-readiness', () => {
  it('checks the named agent in the scope that owns it, and asks for a fresh answer', async () => {
    // Mutation: drop `{ fresh: true }` from the handler (what it first did)
    // fails this.
    await check('folder:c')
    expect(findAgent).toHaveBeenCalledWith('settings-user', 'profile-user', 'folder:c')
    expect(refresh).toHaveBeenCalledWith('settings-user', ROW, { fresh: true })
  })

  it('answers null for an agent it cannot find, and checks nothing', async () => {
    findAgent.mockReturnValueOnce(null)
    expect(await check('folder:gone')).toBeNull()
    expect(refresh).not.toHaveBeenCalled()
  })

  it('installs a probe that hands the options through to the agent’s driver', async () => {
    // The service passes `fresh` to the probe; the probe must not drop it on
    // the way to the driver. Mutation: `probe: (userId, row) => …` fails this.
    await installed.deps?.probe('settings-user', ROW, { fresh: true })
    expect(driverReadiness).toHaveBeenCalledWith('settings-user', ROW, { fresh: true })
  })
})


it('deletes remote agents in the active profile scope', async () => {
})
