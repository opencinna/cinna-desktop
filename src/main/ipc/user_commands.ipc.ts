import { homedir } from 'node:os'
import { ipcMain } from 'electron'
import { userActivation } from '../auth/activation'
import { getProfileScopeUserId } from '../auth/scope'
import { visibleChat } from '../auth/chatScope'
import { userCommandService } from '../services/userCommands'
import { relativeArgPath } from '../services/userCommands/userCommandService'
import { chooseArgPathDialog } from '../host/desktop/argPathDialog'
import { pathGuard } from '../services/pathGuard'
import { ipcHandle } from './_wrap'
import {
  USER_COMMAND_RUN_REASONS,
  userCommandOutputRefusal,
  type UserCommandChooseArgPathResult,
  type UserCommandDismissResult,
  type UserCommandForFileInput,
  type UserCommandForFileResult,
  type UserCommandInspectInput,
  type UserCommandInspectResult,
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

/** The message, or the chat's agent when there is none: strings only; core decides which wins. */
function sourceOf(payload: { messageId?: unknown; agentId?: unknown }): { messageId?: string; agentId?: string } {
  return {
    ...(typeof payload.messageId === 'string' && payload.messageId !== '' ? { messageId: payload.messageId } : {}),
    ...(typeof payload.agentId === 'string' && payload.agentId !== '' ? { agentId: payload.agentId } : {})
  }
}

export function registerUserCommandHandlers(): void {
  ipcHandle('userCommands:run', async (_event, input: unknown): Promise<UserCommandRunResult> => {
    userActivation.requireActivated()
    const payload = (input ?? {}) as Partial<UserCommandRunInput>
    if (!liveChat(payload.chatId)) return { ok: false, code: 'chat_not_found', reason: USER_COMMAND_RUN_REASONS.chat_not_found }
    return userCommandService.run(getProfileScopeUserId(), {
      chatId: payload.chatId as string,
      ...sourceOf(payload),
      command: typeof payload.command === 'string' ? payload.command : '',
      reviewed: payload.reviewed === true,
      ...(typeof payload.columns === 'number' ? { columns: payload.columns } : {})
    })
  })

  // The script's parameters, read from its source in core; never by running it.
  ipcHandle('userCommands:inspect', async (_event, input: unknown): Promise<UserCommandInspectResult> => {
    userActivation.requireActivated()
    const payload = (input ?? {}) as Partial<UserCommandInspectInput>
    if (!liveChat(payload.chatId)) return { ok: false, code: 'chat_not_found', reason: USER_COMMAND_RUN_REASONS.chat_not_found }
    return userCommandService.inspect(getProfileScopeUserId(), {
      chatId: payload.chatId as string,
      ...sourceOf(payload),
      command: typeof payload.command === 'string' ? payload.command : ''
    })
  })

  // The file preview's Run…: core builds the command for a script in the
  // agent's folder; nothing runs until the user presses Run in the window.
  ipcHandle('userCommands:commandForFile', async (_event, input: unknown): Promise<UserCommandForFileResult> => {
    userActivation.requireActivated()
    const payload = (input ?? {}) as Partial<UserCommandForFileInput>
    if (!liveChat(payload.chatId)) return { ok: false, code: 'chat_not_found', reason: USER_COMMAND_RUN_REASONS.chat_not_found }
    return userCommandService.commandForFile(getProfileScopeUserId(), {
      chatId: payload.chatId as string,
      ...sourceOf(payload),
      path: typeof payload.path === 'string' ? payload.path : ''
    })
  })

  // The form's Choose…: core names the agent's folder, the desktop host asks,
  // core writes the choice relative to the folder when it is inside it.
  ipcHandle('userCommands:chooseArgPath', async (event, chatId: unknown, messageId: unknown, agentId?: unknown): Promise<UserCommandChooseArgPathResult> => {
    userActivation.requireActivated()
    if (!liveChat(chatId)) return { ok: false, code: 'chat_not_found', reason: USER_COMMAND_RUN_REASONS.chat_not_found }
    const source = sourceOf({ messageId, agentId })
    const at = await userCommandService.argPathFolder(getProfileScopeUserId(), chatId, source.messageId, source.agentId)
    if (!at.ok) return at
    const chosen = await chooseArgPathDialog(event.sender, at.folder)
    return chosen === null ? { ok: true, canceled: true } : { ok: true, path: relativeArgPath(at.folder, chosen) }
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
