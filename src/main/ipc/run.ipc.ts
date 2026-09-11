import { ipcMain, type MessagePortMain } from 'electron'
import { userActivation } from '../auth/activation'
import { getProfileScopeUserId, getSettingsScopeUserId } from '../auth/scope'
import { inboxService } from '../services/inboxService'
import { runExecutionService } from '../services/runExecutionService'
import { createLogger } from '../logger/logger'
import { postRunError } from './_streamPort'
import { ipcHandle } from './_wrap'
import type { AgentSendPayload, LlmSendPayload, RunSendPayload } from '../../shared/ipcPayloads'

const logger = createLogger('run')

export function registerRunHandlers(): void {
  ipcHandle('run:cancel-chat', async (_event, chatId: string) => {
    userActivation.requireActivated()
    runExecutionService.cancelChat(getProfileScopeUserId(), chatId)
  })
  // ipcRenderer.postMessage passes the payload as the 2nd arg to the listener
  // and the MessagePort on event.ports — see CLAUDE.md.
  ipcMain.on('run:send', (event, payload: RunSendPayload) => {
    void dispatchRun(event.ports?.[0], payload)
  })

  // The two forwards. `agent:send-message` carried an explicit `agentId`; it is
  // taken as the addressed agent, which is exactly what it meant in the one
  // chat shape that used it (a direct chat's root — where the router reaches
  // the same agent on its own, so the field changes nothing).
  ipcMain.on('agent:send-message', (event, payload: AgentSendPayload) => {
    void dispatchRun(event.ports?.[0], {
      chatId: payload.chatId,
      content: payload.content,
      attachments: payload.attachments,
      addressedAgentId: payload.agentId
    })
  })

  ipcMain.on('llm:send-message', (event, payload: LlmSendPayload) => {
    void dispatchRun(event.ports?.[0], {
      chatId: payload.chatId,
      content: payload.content,
      attachments: payload.attachments
    })
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
