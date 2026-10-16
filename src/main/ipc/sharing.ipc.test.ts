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
const itemPeople = vi.hoisted(() => vi.fn())
const setItemPeople = vi.hoisted(() => vi.fn())
const beginAdoption = vi.hoisted(() => vi.fn())
const setAdoptionChat = vi.hoisted(() => vi.fn())
const finishAdoption = vi.hoisted(() => vi.fn())
const discardAdoption = vi.hoisted(() => vi.fn())
const dismissTeamChanges = vi.hoisted(() => vi.fn())
vi.mock('../services/localAgents/sharingService', () => ({
  sharingService: {
    useTeamVersion,
    update,
    itemPeople,
    setItemPeople,
    beginAdoption,
    setAdoptionChat,
    finishAdoption,
    discardAdoption,
    dismissTeamChanges
  }
}))

const { registerSharingHandlers } = await import('./sharing.ipc')
registerSharingHandlers()

const answer = (done: boolean) => ({ done, refusal: done ? null : 'failed', detail: null, status: null, agentId: null })

beforeEach(() => {
  retire.mockReset()
  useTeamVersion.mockReset()
  update.mockReset()
  itemPeople.mockReset()
  setItemPeople.mockReset()
  for (const fn of [beginAdoption, setAdoptionChat, finishAdoption, discardAdoption, dismissTeamChanges]) fn.mockReset()
})

describe('the adoption session', () => {
  it('hands each verb the ids as strings and answers the service’s result as data, retiring nothing', async () => {
    beginAdoption.mockResolvedValue({ ...answer(true), brief: 'The team changed this agent…' })
    expect(await handlers.get('sharing:begin-adoption')!({}, { agentId: 'folder:a1' })).toEqual({
      success: true,
      value: { ...answer(true), brief: 'The team changed this agent…' }
    })
    expect(beginAdoption).toHaveBeenCalledWith('__default__', 'folder:a1')
    setAdoptionChat.mockResolvedValue(answer(true))
    await handlers.get('sharing:adoption-chat')!({}, { agentId: 'folder:a1', chatId: 'c1' })
    expect(setAdoptionChat).toHaveBeenCalledWith('__default__', 'folder:a1', 'c1')
    await handlers.get('sharing:adoption-chat')!({}, { agentId: 'folder:a1', chatId: 42 })
    expect(setAdoptionChat).toHaveBeenLastCalledWith('__default__', 'folder:a1', '')
    const rest: Array<[string, ReturnType<typeof vi.fn>]> = [
      ['sharing:finish-adoption', finishAdoption],
      ['sharing:discard-adoption', discardAdoption],
      ['sharing:dismiss-team-changes', dismissTeamChanges]
    ]
    for (const [channel, fn] of rest) {
      fn.mockResolvedValue(answer(false))
      expect(await handlers.get(channel)!({}, { agentId: 'folder:a1' })).toEqual({ success: true, value: answer(false) })
      expect(fn).toHaveBeenCalledWith('__default__', 'folder:a1')
    }
    expect(retire).not.toHaveBeenCalled()
  })
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

describe('a catalog skill\'s people', () => {
  it('passes only a string uuid on, and the list as sent for main to check', async () => {
    itemPeople.mockResolvedValue(null)
    expect(await handlers.get('sharing:item-people')!({}, { itemUuid: 'pkg-1' })).toEqual({ success: true, value: null })
    expect(itemPeople).toHaveBeenLastCalledWith('pkg-1')
    await handlers.get('sharing:item-people')!({}, { itemUuid: 42 })
    expect(itemPeople).toHaveBeenLastCalledWith('')
    setItemPeople.mockResolvedValue({ ...answer(true), people: null })
    const people = [{ principal: { kind: 'everyone' }, access: 'use' }]
    await handlers.get('sharing:set-item-people')!({}, { itemUuid: 'pkg-1', people })
    expect(setItemPeople).toHaveBeenLastCalledWith('pkg-1', people)
    await handlers.get('sharing:set-item-people')!({}, undefined)
    expect(setItemPeople).toHaveBeenLastCalledWith('', undefined)
  })
})
