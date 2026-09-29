import { describe, it, expect, beforeEach, vi } from 'vitest'
import type { IpcMainInvokeEvent } from 'electron'
import { SESSION_TELEMETRY_CHANGED_CHANNEL, type SessionTelemetryChange } from '../../shared/sessionTelemetry'

/**
 * Session telemetry reaches only the active profile: a `get` for another
 * profile's chat (or a trashed one) answers as data, and a push for one never
 * leaves main.
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
    isTrashed: vi.fn((chatId: string) => owned.trashed.has(chatId))
  }
}))
const rows = vi.hoisted(() => new Map<string, unknown>())
vi.mock('../db/sessionTelemetry', () => ({
  sessionTelemetryRepo: {
    get: (chatId: string) => rows.get(chatId) ?? null,
    save: (t: { chatId: string }) => { rows.set(t.chatId, t) },
    delete: (chatId: string) => { rows.delete(chatId) }
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

const { registerSessionTelemetryHandlers } = await import('./session_telemetry.ipc')
const { sessionTelemetryService } = await import('../agents/telemetry/sessionTelemetryService')

const event = {} as IpcMainInvokeEvent
const invoke = (channel: string, ...args: unknown[]): unknown => handlers.get(channel)!(event, ...args)
const auth = (label: string): SessionTelemetryChange =>
  ({ type: 'auth', engine: 'claude', auth: { kind: 'subscription', label } })

registerSessionTelemetryHandlers()

beforeEach(() => {
  owned.chats = new Set(['mine'])
  owned.trashed = new Set()
  owned.activated = true
  owned.profile = 'profile-1'
  for (const chatId of ['mine', 'theirs', 'binned']) sessionTelemetryService.forget(chatId)
  send.mockClear()
})

describe('sessionTelemetry:get', () => {
  it('answers the telemetry of a chat the active profile owns, and null before it has any', () => {
    expect(invoke('sessionTelemetry:get', 'mine')).toEqual({ ok: true, telemetry: null })
    sessionTelemetryService.report('mine', auth('Claude Max'))
    expect(invoke('sessionTelemetry:get', 'mine')).toEqual({
      ok: true, telemetry: expect.objectContaining({ chatId: 'mine', auth: { kind: 'subscription', label: 'Claude Max' } })
    })
  })

  it.each([['another profile\'s chat', 'theirs'], ['a non-string id', 42]])('refuses %s as data', (_label, chatId) => {
    sessionTelemetryService.report('theirs', auth('secret'))
    expect(invoke('sessionTelemetry:get', chatId)).toEqual({ ok: false, code: 'chat_not_found' })
  })

  it('refuses a trashed chat, and a chat once the profile switches', () => {
    owned.chats.add('binned')
    owned.trashed.add('binned')
    expect(invoke('sessionTelemetry:get', 'binned')).toEqual({ ok: false, code: 'chat_not_found' })
    owned.profile = 'profile-2'
    expect(invoke('sessionTelemetry:get', 'mine')).toEqual({ ok: false, code: 'chat_not_found' })
  })

  it('requires an activated session', () => {
    owned.activated = false
    expect(() => invoke('sessionTelemetry:get', 'mine')).toThrow('Session not activated')
  })
})

describe('the session telemetry push', () => {
  it('sends a change of an owned chat to the window', () => {
    sessionTelemetryService.report('mine', auth('Claude Max'))
    expect(send).toHaveBeenCalledTimes(1)
    expect(send).toHaveBeenCalledWith(SESSION_TELEMETRY_CHANGED_CHANNEL, {
      chatId: 'mine', telemetry: expect.objectContaining({ chatId: 'mine' })
    })
  })

  it('drops a report for a trashed chat instead of sending or keeping it', () => {
    owned.chats.add('binned')
    owned.trashed.add('binned')
    sessionTelemetryService.report('binned', auth('late'))
    expect(send).not.toHaveBeenCalled()
    expect(sessionTelemetryService.get('binned')).toBeNull()
    expect(rows.has('binned')).toBe(false)
  })

  it('keeps another profile\'s chats, and everything while signed out, in main', () => {
    sessionTelemetryService.report('theirs', auth('x'))
    owned.activated = false
    sessionTelemetryService.report('mine', auth('y'))
    expect(send).not.toHaveBeenCalled()
  })
})
