import { chatRepo } from '../db/chats'
import { userActivation } from '../auth/activation'
import { getProfileScopeUserId } from '../auth/scope'
import { sessionActivityHub } from '../services/sessionActivityHub'
import { getMainWindow } from '../index'
import { ipcHandle } from './_wrap'
import {
  SESSION_ACTIVITY_CHANGED_CHANNEL,
  type SessionActivityChangedPayload,
  type SessionActivityGetResult
} from '../../shared/sessionActivity'

export function registerSessionActivityHandlers(): void {
  sessionActivityHub.onChange((chatId, snapshot) => {
    // Only the active profile's chats reach the window, as with the run queue.
    if (!userActivation.isActivated()) return
    const chat = chatRepo.getOwned(getProfileScopeUserId(), chatId)
    if (!chat) return
    if (chat.deletedAt) {
      // A trashed chat shows no activity. A late report for it (a turn that
      // ended as it was trashed) is dropped here rather than kept, so it
      // neither reaches the window nor holds its agent's process busy.
      sessionActivityHub.clear(chatId)
      return
    }
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
}
