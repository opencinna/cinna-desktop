import { chatRepo } from '../db/chats'
import { liveRunHub } from '../services/liveRunHub'
import { ipcMain, type MessagePortMain } from 'electron'
import { userActivation } from '../auth/activation'
import { getProfileScopeUserId, getSettingsScopeUserId } from '../auth/scope'
import { inboxService } from '../services/inboxService'
import { runExecutionService } from '../services/runExecutionService'
import { createLogger } from '../logger/logger'
import { postRunError } from './_streamPort'
import { ipcHandle } from './_wrap'
import type { RunSendPayload } from '../../shared/ipcPayloads'

const logger = createLogger('run')

export function registerRunHandlers(): void {
  ipcHandle('run:start', (_event, payload: RunSendPayload) => {
    userActivation.requireActivated()
    const userId = getProfileScopeUserId()
    return runExecutionService.start({ profileUserId: userId, settingsUserId: getSettingsScopeUserId() }, payload, {
      preserveOnRefusal: inboxService.hasNextMessage(userId, payload.chatId),
      observe: (ctx, event) => inboxService.recordRunEvent(ctx, event),
      onAccepted: (ctx) => inboxService.resumeChat(ctx, payload.content)
    }).id
  })
  ipcMain.on('run:watch', (event, chatId: string) => {
    const port = event.ports?.[0]
    if (!port) return
    const userId = getProfileScopeUserId()
    if (!userActivation.isActivated() || typeof chatId !== 'string' || !chatRepo.getOwned(userId, chatId)) {
      port.close()
      return
    }
    let unwatch = (): void => {}
    const close = (): void => { unwatch(); port.close() }
    port.on('close', () => unwatch())
    port.start()
    unwatch = liveRunHub.watch(userId, chatId, (message) => {
      if (!userActivation.isActivated() || getProfileScopeUserId() !== userId || !chatRepo.getOwned(userId, chatId)) {
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
