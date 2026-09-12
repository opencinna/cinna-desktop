import { beforeEach, describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({ current: '', reload: vi.fn(), disconnect: vi.fn(), start: vi.fn(), syncStart: vi.fn() }))
vi.mock('./session', () => ({ setCurrentUser: (id: string) => { state.current = id } }))
vi.mock('./scope', () => ({ getSettingsScopeUserId: () => 'settings' }))
vi.mock('./reload', () => ({ reloadUserProviders: state.reload }))
vi.mock('../llm/registry', () => ({ clearAllAdapters() {} }))
vi.mock('../mcp/manager', () => ({ mcpManager: { disconnectAll: state.disconnect } }))
vi.mock('../agents/remote-sync', () => ({ runSyncOnce() {}, startPeriodicSync() {}, stopPeriodicSync() {} }))
vi.mock('../services/account-config-sync', () => ({ runAccountConfigSyncOnce() {}, startAccountConfigPeriodicSync() {}, stopAccountConfigPeriodicSync() {} }))
vi.mock('../services/syncService', () => ({ syncService: { ensureActivated() {}, onProfileSwitch() {} } }))
vi.mock('../services/taskSyncScheduler', () => ({ taskSyncScheduler: { stop() {}, start: state.syncStart } }))
vi.mock('../services/localScheduleScheduler', () => ({ localScheduleScheduler: { stop() {}, start: state.start } }))
vi.mock('../localdev/localDevService', () => ({ localDevService: { clear() {}, reconcile() {} } }))
vi.mock('../db/users', () => ({ userRepo: { get: () => ({ type: 'local_user' }) } }))
const flush = async () => { for (let i = 0; i < 8; i++) await Promise.resolve() }

describe('profile activation admission', () => {
  beforeEach(() => { vi.resetModules(); vi.clearAllMocks(); state.current = ''; state.disconnect.mockResolvedValue(undefined); state.reload.mockResolvedValue(undefined) })
  it('serializes provider reloads and only activates the latest profile', async () => {
    const { userActivation } = await import('./activation')
    let finish = () => {}
    let oldCurrent: () => boolean = () => true
    state.reload.mockImplementationOnce((current) => { oldCurrent = current; return new Promise<void>((resolve) => { finish = resolve }) })
    const first = userActivation.activate('a'); await flush()
    const second = userActivation.activate('b'); await flush()
    expect(state.reload).toHaveBeenCalledTimes(1)
    expect(oldCurrent()).toBe(false)
    expect(() => userActivation.requireActivated()).toThrow()
    finish(); await Promise.all([first, second])
    expect(state.current).toBe('b')
    expect(state.start.mock.calls).toEqual([[{ profileUserId: 'b', settingsUserId: 'settings' }]])
    expect(state.syncStart.mock.calls).toEqual([['b']])
  })
  it('does not let a pending activation reopen the gate after deactivation', async () => {
    const { userActivation } = await import('./activation')
    let finish = () => {}
    state.reload.mockImplementationOnce(() => new Promise<void>((resolve) => { finish = resolve }))
    const first = userActivation.activate('a'); await flush()
    const stopped = userActivation.deactivate()
    finish(); await Promise.all([first, stopped])
    expect(state.start).not.toHaveBeenCalled()
    expect(() => userActivation.requireActivated()).toThrow()
  })
  it('does not let old deactivation overwrite a newer profile or dedupe its activation away', async () => {
    const { userActivation } = await import('./activation')
    let finish = () => {}
    state.reload.mockImplementationOnce(() => new Promise<void>((resolve) => { finish = resolve }))
    const first = userActivation.activate('a'); await flush()
    const stopped = userActivation.deactivate()
    const resumed = userActivation.activate('a')
    finish(); await Promise.all([first, stopped, resumed])
    expect(state.current).toBe('a')
    expect(state.reload).toHaveBeenCalledTimes(2)
    expect(state.start).toHaveBeenCalledTimes(1)
    expect(() => userActivation.requireActivated()).not.toThrow()
  })
})
