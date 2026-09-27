import { liveRunHub } from '../services/liveRunHub'
import { ipcMain, type MessagePortMain } from 'electron'
import { userActivation } from '../auth/activation'
import { getProfileScopeUserId, getSettingsScopeUserId } from '../auth/scope'
import { ownerOfVisible, visibleChat } from '../auth/chatScope'
import { inboxService } from '../services/inboxService'
import { runExecutionService, type RunScope } from '../services/runExecutionService'
import { runQueueService } from '../services/runQueueService'
import { createLogger } from '../logger/logger'
import { getMainWindow } from '../index'
import { postRunError } from './_streamPort'
import { ipcHandle } from './_wrap'
import { RUN_QUEUE_CHANGED_CHANNEL, type RunSendPayload, type RunStartResult } from '../../shared/ipcPayloads'

const logger = createLogger('run')

/**
 * The active profile's scope, for a chat it can see — its own, or one the
 * default profile shares with every profile. Every queue channel asks.
 */
function ownedChatScope(chatId: unknown): RunScope {
  userActivation.requireActivated()
  const profileUserId = getProfileScopeUserId()
  if (typeof chatId !== 'string' || !visibleChat(profileUserId, chatId)) throw new Error('Chat not found')
  return { profileUserId, settingsUserId: getSettingsScopeUserId() }
}

export function registerRunHandlers(): void {
  runQueueService.onChange((chatId, view) => {
    // Only the queues of chats the active profile sees reach the window;
    // another profile's chat ids mean nothing to it.
    if (!userActivation.isActivated() || !visibleChat(getProfileScopeUserId(), chatId)) return
    const win = getMainWindow()
    if (win && !win.isDestroyed()) win.webContents.send(RUN_QUEUE_CHANGED_CHANNEL, { chatId, view })
  })
  ipcHandle('run:start', (_event, payload: RunSendPayload): Promise<RunStartResult> => {
    userActivation.requireActivated()
    const userId = getProfileScopeUserId()
    return runQueueService.submit({ profileUserId: userId, settingsUserId: getSettingsScopeUserId() }, payload, (sent) => {
      // A queued message can start long after this handler returned. It starts
      // only for the profile that sent it, and only while that profile is in.
      userActivation.requireActivated()
      if (getProfileScopeUserId() !== userId) throw new Error('The profile changed before the queued message was sent.')
      return {
        preserveOnRefusal: inboxService.hasNextMessage(userId, sent.chatId),
        observe: (ctx, event) => inboxService.recordRunEvent(ctx, event),
        onAccepted: (ctx) => inboxService.resumeChat(ctx, sent.content)
      }
    })
  })
  ipcHandle('run:queue-list', (_event, chatId: string) => runQueueService.list(ownedChatScope(chatId), chatId))
  ipcHandle('run:queue-take', (_event, chatId: string) => runQueueService.take(ownedChatScope(chatId), chatId))
  ipcHandle('run:queue-remove', (_event, chatId: string, id: string) => {
    const scope = ownedChatScope(chatId)
    return typeof id === 'string' && runQueueService.remove(scope, chatId, id)
  })
  ipcHandle('run:queue-edit', (_event, chatId: string, id: string, content: string) => {
    const scope = ownedChatScope(chatId)
    return typeof id === 'string' && runQueueService.edit(scope, chatId, id, content)
  })
  ipcMain.on('run:watch', (event, chatId: string) => {
    const port = event.ports?.[0]
    if (!port) return
    const userId = getProfileScopeUserId()
    const chat = userActivation.isActivated() && typeof chatId === 'string' ? visibleChat(userId, chatId) : undefined
    if (!chat) {
      port.close()
      return
    }
    // A live run is keyed by the chat's owner; the subscription still ends
    // when the active profile changes.
    const chatOwner = ownerOfVisible(userId, chat)
    let unwatch = (): void => {}
    const close = (): void => { unwatch(); port.close() }
    port.on('close', () => unwatch())
    port.start()
    unwatch = liveRunHub.watch(chatOwner, chatId, (message) => {
      if (!userActivation.isActivated() || getProfileScopeUserId() !== userId) {
        close()
        throw new Error('Run subscription no longer belongs to the active profile')
      }
      port.postMessage(message)
    })
  })
  ipcHandle('run:cancel-chat', async (_event, chatId: string) => {
    userActivation.requireActivated()
    runExecutionService.cancelChat(getProfileScopeUserId(), chatId)
  })
  // ipcRenderer.postMessage passes the payload as the 2nd arg to the listener
  // and the MessagePort on event.ports — see CLAUDE.md.
  ipcMain.on('run:send', (event, payload: RunSendPayload) => {
    void dispatchRun(event.ports?.[0], payload)
  })
}


/** Authentication and native-port setup stay at the IPC boundary. */
async function dispatchRun(port: MessagePortMain | undefined, payload: RunSendPayload): Promise<void> {
  if (!port) {
    logger.error('a send arrived with no MessagePort', { chatId: payload.chatId })
    return
  }
  port.start()
  if (!userActivation.isActivated()) {
    postRunError(port, 'Session not activated — user must authenticate first')
    port.close()
    return
  }
  try {
    runExecutionService.start({
      profileUserId: getProfileScopeUserId(), settingsUserId: getSettingsScopeUserId()
    }, payload, {
      port,
      preserveOnRefusal: inboxService.hasNextMessage(getProfileScopeUserId(), payload.chatId),
      observe: (ctx, event) => inboxService.recordRunEvent(ctx, event),
      onAccepted: (ctx) => inboxService.resumeChat(ctx, payload.content)
    })
  } catch (error) {
    postRunError(port, error instanceof Error ? error.message : String(error))
    port.close()
  }
}
