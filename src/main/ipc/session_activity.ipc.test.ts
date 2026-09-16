import { describe, it, expect, beforeEach, vi } from 'vitest'
import type { IpcMainInvokeEvent } from 'electron'
import { SESSION_ACTIVITY_CHANGED_CHANNEL } from '../../shared/sessionActivity'

/**
 * Session activity reaches only the active profile: a `get` for another
 * profile's chat answers as data, and a push for one never leaves main.
 */

const handlers = vi.hoisted(() => new Map<string, (...args: unknown[]) => unknown>())
vi.mock('./_wrap', () => ({
  ipcHandle: (channel: string, handler: (...args: unknown[]) => unknown) => { handlers.set(channel, handler) }
}))
const owned = vi.hoisted(() => ({ chats: new Set<string>(), trashed: new Set<string>(), activated: true, profile: 'profile-1' }))
vi.mock('../db/chats', () => ({
  chatRepo: {
    getOwned: vi.fn((userId: string, chatId: string) =>
      userId === 'profile-1' && owned.chats.has(chatId)
        ? { id: chatId, deletedAt: owned.trashed.has(chatId) ? new Date(1) : null }
        : undefined),
    // Any profile's chat.
    isTrashed: vi.fn((chatId: string) => owned.trashed.has(chatId))
  }
}))
vi.mock('../logger/logger', () => ({
  createLogger: () => ({ debug: () => {}, info: () => {}, warn: () => {}, error: () => {} })
}))
vi.mock('../auth/activation', () => ({
  userActivation: {
    isActivated: () => owned.activated,
    requireActivated: () => { if (!owned.activated) throw new Error('Session not activated') }
  }
}))
vi.mock('../auth/scope', () => ({ getProfileScopeUserId: () => owned.profile }))
const send = vi.hoisted(() => vi.fn())
vi.mock('../index', () => ({ getMainWindow: () => ({ isDestroyed: () => false, webContents: { send } }) }))

const { registerSessionActivityHandlers } = await import('./session_activity.ipc')
const { sessionActivityHub } = await import('../services/sessionActivityHub')
const { installSessionActivityStopper } = await import('../services/sessionActivityStop')

const event = {} as IpcMainInvokeEvent
const invoke = (channel: string, ...args: unknown[]): unknown => handlers.get(channel)!(event, ...args)
const start = (id: string) => ({ type: 'upsert' as const, id, kind: 'background' as const, title: id })

registerSessionActivityHandlers()

beforeEach(() => {
  send.mockClear()
  owned.chats = new Set(['mine'])
  owned.trashed = new Set()
  owned.activated = true
  owned.profile = 'profile-1'
  sessionActivityHub.clear('mine')
  sessionActivityHub.clear('theirs')
  sessionActivityHub.clear('binned')
  send.mockClear()
})

describe('sessionActivity:get', () => {
  it('answers the snapshot of a chat the active profile owns', () => {
    sessionActivityHub.report('mine', 'agent', start('x'))
    expect(invoke('sessionActivity:get', 'mine')).toEqual({
      ok: true,
      snapshot: { chatId: 'mine', items: [expect.objectContaining({ id: 'x', state: 'running' })] }
    })
  })

  it.each([['another profile\'s chat', 'theirs'], ['a non-string id', 42]])('refuses %s as data', (_label, chatId) => {
    sessionActivityHub.report('theirs', 'agent', start('secret'))
    expect(invoke('sessionActivity:get', chatId)).toEqual({ ok: false, code: 'chat_not_found' })
  })

  it('refuses a chat once the profile switches', () => {
    owned.profile = 'profile-2'
    expect(invoke('sessionActivity:get', 'mine')).toEqual({ ok: false, code: 'chat_not_found' })
  })

  it('requires an activated session', () => {
    owned.activated = false
    expect(() => invoke('sessionActivity:get', 'mine')).toThrow('Session not activated')
  })
})

describe('the session activity push', () => {
  it('sends a change of an owned chat to the window', () => {
    sessionActivityHub.report('mine', 'agent', start('x'))
    expect(send).toHaveBeenCalledTimes(1)
    expect(send).toHaveBeenCalledWith(SESSION_ACTIVITY_CHANGED_CHANNEL, {
      chatId: 'mine',
      snapshot: { chatId: 'mine', items: [expect.objectContaining({ id: 'x' })] }
    })
  })

  it('drops a report for a trashed chat instead of sending or keeping it', () => {
    owned.chats.add('binned')
    owned.trashed.add('binned')
    sessionActivityHub.report('binned', 'agent', start('late'))

    expect(send).not.toHaveBeenCalled()
    expect(sessionActivityHub.snapshot('binned').items).toEqual([])
    expect(sessionActivityHub.hasRunning({ agentId: 'agent', chatId: 'binned' })).toBe(false)
  })

  it('drops a report for another profile\'s trashed chat, and while signed out, too', () => {
    // `binned` is not the active profile's: `getOwned` does not find it.
    owned.trashed.add('binned')
    sessionActivityHub.report('binned', 'agent', start('late'))
    expect(sessionActivityHub.hasRunning({ agentId: 'agent', chatId: 'binned' })).toBe(false)

    owned.activated = false
    sessionActivityHub.report('binned', 'agent', start('later'))
    expect(sessionActivityHub.snapshot('binned').items).toEqual([])
    expect(send).not.toHaveBeenCalled()
  })

  it('keeps another profile\'s chats, and everything while signed out, in main', () => {
    sessionActivityHub.report('theirs', 'agent', start('x'))
    owned.activated = false
    sessionActivityHub.report('mine', 'agent', start('y'))
    expect(send).not.toHaveBeenCalled()
  })
})

describe('sessionActivity:stop', () => {
  const stops: [string, string][] = []
  const stoppable = (id: string) => ({ ...start(id), canStop: true })
  installSessionActivityStopper('test', {
    stop: async (chatId, item) => { stops.push([chatId, item.id]); return 'stopped' }
  })
  beforeEach(() => { stops.length = 0 })

  it('stops an owned chat\'s running item through its provider', async () => {
    sessionActivityHub.report('mine', 'agent', stoppable('bg'))
    expect(await invoke('sessionActivity:stop', 'mine', 'bg')).toEqual({ ok: true })
    expect(stops).toEqual([['mine', 'bg']])
  })

  it.each([
    ['another profile\'s chat', 'theirs'],
    ['a non-string chat id', 42]
  ])('refuses %s as data, stopping nothing', async (_label, chatId) => {
    sessionActivityHub.report('theirs', 'agent', stoppable('bg'))
    expect(await invoke('sessionActivity:stop', chatId, 'bg')).toEqual({
      ok: false, code: 'chat_not_found', reason: 'This chat is no longer available.'
    })
    expect(stops).toEqual([])
  })

  it('refuses a trashed chat as chat_not_found', async () => {
    sessionActivityHub.report('mine', 'agent', stoppable('bg'))
    owned.trashed.add('mine')
    expect(await invoke('sessionActivity:stop', 'mine', 'bg')).toMatchObject({ ok: false, code: 'chat_not_found' })
    expect(stops).toEqual([])
  })

  it.each([['an unknown item', 'nope'], ['a non-string item id', 7]])('refuses %s as not_stoppable', async (_label, itemId) => {
    sessionActivityHub.report('mine', 'agent', stoppable('bg'))
    expect(await invoke('sessionActivity:stop', 'mine', itemId)).toMatchObject({
      ok: false, code: 'not_stoppable', reason: 'This process can no longer be stopped from here.'
    })
    expect(stops).toEqual([])
  })

  it('answers already_ended for an item that has ended', async () => {
    sessionActivityHub.report('mine', 'agent', stoppable('bg'))
    sessionActivityHub.report('mine', 'agent', { type: 'end', id: 'bg', state: 'completed' })
    expect(await invoke('sessionActivity:stop', 'mine', 'bg')).toMatchObject({ ok: false, code: 'already_ended' })
  })

  it('requires an activated session', async () => {
    owned.activated = false
    await expect(async () => invoke('sessionActivity:stop', 'mine', 'bg')).rejects.toThrow('Session not activated')
  })
})
