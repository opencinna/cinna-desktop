import { chatRepo } from '../db/chats'
import { userActivation } from '../auth/activation'
import { getProfileScopeUserId } from '../auth/scope'
import { sessionActivityHub } from '../services/sessionActivityHub'
import { stopSessionActivity } from '../services/sessionActivityStop'
import { getMainWindow } from '../index'
import { ipcHandle } from './_wrap'
import { createLogger } from '../logger/logger'
import {
  SESSION_ACTIVITY_CHANGED_CHANNEL,
  type SessionActivityChangedPayload,
  type SessionActivityGetResult,
  type SessionActivityStopResult,
  sessionActivityStopRefusal
} from '../../shared/sessionActivity'

const logger = createLogger('session-activity-ipc')

export function registerSessionActivityHandlers(): void {
  sessionActivityHub.onChange((chatId, snapshot) => {
    // A trashed chat shows no activity, whichever profile owns it. A late
    // report for it (a turn that ended as it was trashed) is dropped here
    // rather than kept, so it neither reaches the window nor holds its
    // agent's process busy — a profile that is not active included.
    let trashed = false
    try {
      trashed = chatRepo.isTrashed(chatId)
    } catch (err) {
      logger.warn('could not tell whether a chat with session activity is trashed', { chatId, error: err instanceof Error ? err.message : String(err) })
    }
    if (trashed) {
      sessionActivityHub.clear(chatId)
      return
    }
    // Only the active profile's chats reach the window, as with the run queue.
    if (!userActivation.isActivated()) return
    const chat = chatRepo.getOwned(getProfileScopeUserId(), chatId)
    if (!chat || chat.deletedAt) return
    const win = getMainWindow()
    const payload: SessionActivityChangedPayload = { chatId, snapshot }
    if (win && !win.isDestroyed()) win.webContents.send(SESSION_ACTIVITY_CHANGED_CHANNEL, payload)
  })

  ipcHandle('sessionActivity:get', (_event, chatId: unknown): SessionActivityGetResult => {
    userActivation.requireActivated()
    if (typeof chatId !== 'string' || !chatRepo.getOwned(getProfileScopeUserId(), chatId)) {
      return { ok: false, code: 'chat_not_found' }
    }
    return { ok: true, snapshot: sessionActivityHub.snapshot(chatId) }
  })

  ipcHandle('sessionActivity:stop', async (_event, chatId: unknown, itemId: unknown): Promise<SessionActivityStopResult> => {
    userActivation.requireActivated()
    if (typeof chatId !== 'string') return sessionActivityStopRefusal('chat_not_found')
    const chat = chatRepo.getOwned(getProfileScopeUserId(), chatId)
    // A trashed chat's processes are not the user's to steer from here.
    if (!chat || chat.deletedAt) return sessionActivityStopRefusal('chat_not_found')
    if (typeof itemId !== 'string' || itemId === '') return sessionActivityStopRefusal('not_stoppable')
    return stopSessionActivity(chatId, itemId)
  })
}
