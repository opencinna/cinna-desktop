import { describe, it, expect, beforeEach, vi } from 'vitest'

/**
 * What the sharing adapter does beyond delegating: after Use the team's
 * version, the agent's warm process — whose working directory is now the
 * kept `<slug>-mine` copy — is retired, as `local-agent:delete` retires one.
 * Only when the swap happened; a refusal or a rollback moved nothing.
 */

const handlers = vi.hoisted(() => new Map<string, (...args: unknown[]) => unknown>())
vi.mock('./_wrap', () => ({
  ipcHandle: (channel: string, fn: (...args: unknown[]) => unknown) => {
    handlers.set(channel, fn)
  }
}))
vi.mock('../auth/activation', () => ({ userActivation: { requireActivated: () => {} } }))
vi.mock('../auth/scope', () => ({ getSettingsScopeUserId: () => '__default__' }))
vi.mock('../logger/logger', () => ({
  createLogger: () => ({ debug: () => {}, info: () => {}, warn: () => {}, error: () => {} })
}))
vi.mock('../auth/cinna-oauth', () => ({ CinnaReauthRequired: class extends Error {} }))

const retire = vi.hoisted(() => vi.fn())
vi.mock('../agents/drivers', () => ({ acpProcessPool: { retire } }))

const useTeamVersion = vi.hoisted(() => vi.fn())
const update = vi.hoisted(() => vi.fn())
vi.mock('../services/localAgents/sharingService', () => ({
  sharingService: { useTeamVersion, update }
}))

const { registerSharingHandlers } = await import('./sharing.ipc')
registerSharingHandlers()

const answer = (done: boolean) => ({ done, refusal: done ? null : 'failed', detail: null, status: null, agentId: null })

beforeEach(() => {
  retire.mockReset()
  useTeamVersion.mockReset()
  update.mockReset()
})

describe('sharing:use-team-version', () => {
  it('retires the agent\'s warm process once the team version is in place', async () => {
    useTeamVersion.mockResolvedValue(answer(true))
    const outcome = await handlers.get('sharing:use-team-version')!({}, { agentId: 'folder:a1' })
    expect(outcome).toEqual({ success: true, value: answer(true) })
    expect(retire).toHaveBeenCalledWith('folder:a1')
  })

  it('leaves it alone when nothing moved', async () => {
    useTeamVersion.mockResolvedValue(answer(false))
    await handlers.get('sharing:use-team-version')!({}, { agentId: 'folder:a1' })
    expect(retire).not.toHaveBeenCalled()
  })
})

describe('sharing:update', () => {
  it('does not retire: like a git update it changes files in place', async () => {
    update.mockResolvedValue(answer(true))
    await handlers.get('sharing:update')!({}, { agentId: 'folder:a1' })
    expect(retire).not.toHaveBeenCalled()
  })
})
