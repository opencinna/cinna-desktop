import { ipcMain } from 'electron'
import { userActivation } from '../auth/activation'
import { getProfileScopeUserId } from '../auth/scope'
import { messageRoutingService } from '../services/messageRoutingService'
import { chatStreamingService } from '../services/chatStreamingService'
import { createLogger } from '../logger/logger'
import { ipcHandle } from './_wrap'
import type { LlmSendPayload } from '../../shared/ipcPayloads'

const logger = createLogger('llm-ipc')

export function registerLlmHandlers(): void {
  // ipcRenderer.postMessage passes the payload as the 2nd arg to the listener
  // and the MessagePort on event.ports — see CLAUDE.md.
  ipcMain.on('llm:send-message', async (event, payload: LlmSendPayload) => {
    const { chatId, content: userContent, catchupPacket = '' } = payload
    const port = event.ports?.[0]
    if (!port) {
      logger.error('No MessagePort received for llm:send-message')
      return
    }

    port.start()

    if (!userActivation.isActivated()) {
      port.postMessage({
        type: 'error',
        error: 'Session not activated — user must authenticate first'
      })
      port.close()
      return
    }

    try {
      const { wireContent } = messageRoutingService.prepareLlmSend({
        userId: getProfileScopeUserId(),
        chatId,
        userContent,
        catchupPacket
      })
      await chatStreamingService.stream({
        userId: getProfileScopeUserId(),
        chatId,
        wireContent,
        port
      })
    } catch (err) {
      // Service is responsible for posting to the port and closing it; log
      // here so handler-side context is not lost if the service fails before
      // posting.
      logger.error('llm stream failed', { chatId, error: err })
    }
  })

  ipcHandle('llm:cancel', async (_event, requestId: string) => {
    chatStreamingService.cancel(requestId)
    return { success: true }
  })
}
