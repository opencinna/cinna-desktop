import { ipcMain } from 'electron'
import { getCurrentUserId } from '../auth/session'
import { userActivation } from '../auth/activation'
import { chatStreamingService } from '../services/chatStreamingService'

export function registerLlmHandlers(): void {
  // ipcRenderer.postMessage passes the payload as the 2nd arg to the listener
  // and the MessagePort on event.ports — see CLAUDE.md.
  ipcMain.on('llm:send-message', async (event, message: [string, string]) => {
    const [chatId, userContent] = message
    const port = event.ports?.[0]
    if (!port) {
      console.error('No MessagePort received for llm:send-message')
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
      await chatStreamingService.stream({
        userId: getCurrentUserId(),
        chatId,
        userContent,
        port
      })
    } catch {
      // Service already posted the error to the port and closed it
    }
  })

  ipcMain.handle('llm:cancel', async (_event, requestId: string) => {
    chatStreamingService.cancel(requestId)
    return { success: true }
  })
}
