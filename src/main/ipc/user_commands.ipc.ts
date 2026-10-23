import { homedir } from 'node:os'
import { ipcMain } from 'electron'
import { userActivation } from '../auth/activation'
import { getProfileScopeUserId } from '../auth/scope'
import { visibleChat } from '../auth/chatScope'
import { userCommandService } from '../services/userCommands'
import { pathGuard } from '../services/pathGuard'
import { ipcHandle } from './_wrap'
import {
  USER_COMMAND_RUN_REASONS,
  userCommandOutputRefusal,
  type UserCommandDismissResult,
  type UserCommandOutputFileResult,
  type UserCommandOutputTextResult,
  type UserCommandRunInput,
  type UserCommandRunResult
} from '../../shared/userCommands'

/**
 * Commands the user runs from a message (`services/userCommands`). Thin
 * adapters: the chat is the active profile's and not trashed, then the core
 * service decides. Every refusal is data (a thrown error's code never reaches
 * the renderer). Stop is `sessionActivity:stop`.
 */

/** The chat id when the active profile sees it, live; null otherwise. */
function liveChat(chatId: unknown): string | null {
  if (!userActivation.isActivated() || typeof chatId !== 'string') return null
  const chat = visibleChat(getProfileScopeUserId(), chatId)
  return chat && !chat.deletedAt ? chatId : null
}

export function registerUserCommandHandlers(): void {
  ipcHandle('userCommands:run', async (_event, input: unknown): Promise<UserCommandRunResult> => {
    userActivation.requireActivated()
    const payload = (input ?? {}) as Partial<UserCommandRunInput>
    if (!liveChat(payload.chatId)) return { ok: false, code: 'chat_not_found', reason: USER_COMMAND_RUN_REASONS.chat_not_found }
    return userCommandService.run(getProfileScopeUserId(), {
      chatId: payload.chatId as string,
      messageId: typeof payload.messageId === 'string' ? payload.messageId : '',
      command: typeof payload.command === 'string' ? payload.command : '',
      reviewed: payload.reviewed === true,
      ...(typeof payload.columns === 'number' ? { columns: payload.columns } : {})
    })
  })

  // The home folder, so the renderer shortens a folder to `~/…` as main does.
  // A path, not a secret; nothing else rides on it.
  ipcHandle('userCommands:home', (): string => homedir())

  ipcHandle('userCommands:outputText', (_event, chatId: unknown, itemId: unknown): UserCommandOutputTextResult => {
    userActivation.requireActivated()
    if (!liveChat(chatId)) return userCommandOutputRefusal('chat_not_found')
    if (typeof itemId !== 'string') return userCommandOutputRefusal('not_found')
    return userCommandService.outputText(chatId as string, itemId)
  })

  ipcHandle('userCommands:outputFile', (_event, chatId: unknown, itemId: unknown): UserCommandOutputFileResult => {
    userActivation.requireActivated()
    if (!liveChat(chatId)) return userCommandOutputRefusal('chat_not_found')
    if (typeof itemId !== 'string') return userCommandOutputRefusal('not_found')
    const result = userCommandService.outputFile(chatId as string, itemId)
    // Recorded like a pasted file, so the composer's ingest round trip accepts it.
    if (result.ok) pathGuard.record(result.path)
    return result
  })

  ipcHandle('userCommands:dismiss', (_event, chatId: unknown, itemId: unknown): UserCommandDismissResult => {
    userActivation.requireActivated()
    if (!liveChat(chatId)) return userCommandOutputRefusal('chat_not_found')
    if (typeof itemId !== 'string') return userCommandOutputRefusal('not_found')
    return userCommandService.dismiss(chatId as string, itemId)
  })

  // `ipcRenderer.postMessage` passes the payload as the second argument and the
  // port on `event.ports` (see CLAUDE.md). The subscription ends when either
  // side closes or the active profile changes; it never stops the run.
  ipcMain.on('userCommands:output', (event, payload: unknown) => {
    const port = event.ports?.[0]
    if (!port) return
    const { chatId, itemId } = (payload ?? {}) as { chatId?: unknown; itemId?: unknown }
    const profile = userActivation.isActivated() ? getProfileScopeUserId() : null
    if (!profile || !liveChat(chatId) || typeof itemId !== 'string') {
      port.postMessage({ type: 'missing' })
      port.close()
      return
    }
    let unwatch: (() => void) | null = null
    let open = true
    const close = (): void => {
      if (!open) return
      open = false
      unwatch?.()
      port.close()
    }
    port.on('close', () => { open = false; unwatch?.() })
    port.start()
    unwatch = userCommandService.watch(chatId as string, itemId, (frame) => {
      if (!open) return
      if (!userActivation.isActivated() || getProfileScopeUserId() !== profile) { close(); return }
      port.postMessage(frame)
      if (frame.type === 'end' || frame.type === 'missing') close()
    })
    if (unwatch === null) close()
  })
}
