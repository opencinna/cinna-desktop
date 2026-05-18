import { multiAgentService } from '../services/multiAgentService'
import { userActivation } from '../auth/activation'
import { getProfileScopeUserId } from '../auth/scope'
import { createLogger } from '../logger/logger'
import { ipcHandle } from './_wrap'

const logger = createLogger('multi-agent-ipc')

export function registerMultiAgentHandlers(): void {
  ipcHandle(
    'multiAgent:rewrite',
    async (
      _event,
      data: { chatId: string; targetAgentId: string; userText: string }
    ): Promise<{ rewrittenText: string | null }> => {
      userActivation.requireActivated()
      const userId = getProfileScopeUserId()
      logger.debug('rewrite request', {
        chatId: data.chatId,
        targetAgentId: data.targetAgentId
      })
      // `null` here is the LLM's "no rewrite needed" signal — the composer
      // dispatches the user's original text without the confirmation step.
      const rewrittenText = await multiAgentService.rewriteMessage({
        userId,
        chatId: data.chatId,
        targetAgentId: data.targetAgentId,
        userText: data.userText
      })
      return { rewrittenText }
    }
  )

  ipcHandle(
    'multiAgent:set-active-agent',
    async (
      _event,
      data: { chatId: string; agentId: string | null }
    ): Promise<{ changed: boolean }> => {
      userActivation.requireActivated()
      const userId = getProfileScopeUserId()
      const result = multiAgentService.setActiveAgent({
        userId,
        chatId: data.chatId,
        agentId: data.agentId
      })
      return { changed: result.changed }
    }
  )

  ipcHandle(
    'multiAgent:disable-smart-assist',
    async (_event, data: { chatId: string }): Promise<{ success: boolean }> => {
      userActivation.requireActivated()
      const userId = getProfileScopeUserId()
      multiAgentService.disableSmartAssist({ userId, chatId: data.chatId })
      return { success: true }
    }
  )

  ipcHandle(
    'multiAgent:build-catchup',
    async (
      _event,
      data: { chatId: string; targetAgentId: string }
    ): Promise<{ packet: string }> => {
      userActivation.requireActivated()
      const userId = getProfileScopeUserId()
      const packet = multiAgentService.buildCatchupPacket({
        userId,
        chatId: data.chatId,
        targetAgentId: data.targetAgentId
      })
      return { packet }
    }
  )
}
