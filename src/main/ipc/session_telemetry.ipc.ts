import { userActivation } from '../auth/activation'
import { getProfileScopeUserId } from '../auth/scope'
import { visibleChat } from '../auth/chatScope'
import { sessionTelemetryService } from '../agents/telemetry/sessionTelemetryService'
import { getMainWindow } from '../index'
import { ipcHandle } from './_wrap'
import {
  SESSION_TELEMETRY_CHANGED_CHANNEL,
  type SessionTelemetryChangedPayload,
  type SessionTelemetryGetResult
} from '../../shared/sessionTelemetry'

export function registerSessionTelemetryHandlers(): void {
  sessionTelemetryService.onChange((chatId, telemetry) => {
    // A trashed chat's late report never gets here: the service drops it
    // (`isTrashed`) before writing or announcing anything. Only the chats the active profile sees reach the window, as with session activity.
    if (!userActivation.isActivated()) return
    const chat = visibleChat(getProfileScopeUserId(), chatId)
    if (!chat || chat.deletedAt) return
    const win = getMainWindow()
    const payload: SessionTelemetryChangedPayload = { chatId, telemetry }
    if (win && !win.isDestroyed()) win.webContents.send(SESSION_TELEMETRY_CHANGED_CHANNEL, payload)
  })

  ipcHandle('sessionTelemetry:get', (_event, chatId: unknown): SessionTelemetryGetResult => {
    userActivation.requireActivated()
    if (typeof chatId !== 'string') return { ok: false, code: 'chat_not_found' }
    const chat = visibleChat(getProfileScopeUserId(), chatId)
    if (!chat || chat.deletedAt) return { ok: false, code: 'chat_not_found' }
    return { ok: true, telemetry: sessionTelemetryService.get(chatId) }
  })
}
