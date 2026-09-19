import { userActivation } from '../auth/activation'
import { getProfileScopeUserId } from '../auth/scope'
import { chatService } from '../services/chatService'
import { ChatError } from '../errors'
import { isChatRouter, type ChatRouter } from '../../shared/chatRouting'
import { ipcHandle } from './_wrap'

export function registerChatHandlers(): void {
  ipcHandle('chat:list', async () => {
    userActivation.requireActivated()
    return chatService.list(getProfileScopeUserId())
  })

  ipcHandle('chat:list-summaries', async () => {
    userActivation.requireActivated()
    return chatService.listSummaries(getProfileScopeUserId())
  })

  ipcHandle('chat:get', async (_event, chatId: string) => {
    userActivation.requireActivated()
    return chatService.get(getProfileScopeUserId(), chatId)
  })

  ipcHandle('chat:mark-result-read', async (_event, chatId: string, runId: string) => {
    userActivation.requireActivated()
    chatService.markResultRead(getProfileScopeUserId(), chatId, runId)
  })

  ipcHandle('chat:create', async () => {
    userActivation.requireActivated()
    return chatService.create(getProfileScopeUserId())
  })

  ipcHandle('chat:delete', async (_event, chatId: string) => {
    userActivation.requireActivated()
    chatService.delete(getProfileScopeUserId(), chatId)
    return { success: true }
  })

  ipcHandle('chat:trash-list', async () => {
    userActivation.requireActivated()
    return chatService.listTrash(getProfileScopeUserId())
  })

  ipcHandle('chat:restore', async (_event, chatId: string) => {
    userActivation.requireActivated()
    chatService.restore(getProfileScopeUserId(), chatId)
    return { success: true }
  })

  ipcHandle('chat:permanent-delete', async (_event, chatId: string) => {
    userActivation.requireActivated()
    chatService.permanentDelete(getProfileScopeUserId(), chatId)
    return { success: true }
  })

  ipcHandle('chat:empty-trash', async () => {
    userActivation.requireActivated()
    chatService.emptyTrash(getProfileScopeUserId())
    return { success: true }
  })

  ipcHandle('chat:show-in-list', async (_event, chatId: string) => {
    userActivation.requireActivated()
    chatService.showInList(getProfileScopeUserId(), chatId)
    return { success: true }
  })

  ipcHandle(
    'chat:update',
    async (
      _event,
      chatId: string,
      updates: {
        title?: string
        modelId?: string
        providerId?: string
        modeId?: string | null
        agentId?: string | null
        router?: ChatRouter
      }
    ) => {
      userActivation.requireActivated()
      // Validated here as well as on `chat:set-router`, and for the same
      // reason: this channel writes the column too (a new chat sets several
      // fields at once), and a value neither guard caught would leave a chat
      // whose router matches nothing and whose messages route to the model by
      // the fallback, silently.
      if (updates.router !== undefined && !isChatRouter(updates.router)) {
        throw new ChatError('invalid_router', `Unknown chat router: ${String(updates.router)}`)
      }
      chatService.update(getProfileScopeUserId(), chatId, updates)
      return { success: true }
    }
  )

  ipcHandle(
    'chat:add-message',
    async (
      _event,
      chatId: string,
      message: {
        role: string
        content: string
        toolCallId?: string
        toolName?: string
        toolInput?: Record<string, unknown>
      }
    ) => {
      userActivation.requireActivated()
      return chatService.addMessage(getProfileScopeUserId(), chatId, message)
    }
  )

  ipcHandle(
    'chat:set-mcp-providers',
    async (_event, chatId: string, mcpProviderIds: string[]) => {
      userActivation.requireActivated()
      chatService.setMcpProviders(getProfileScopeUserId(), chatId, mcpProviderIds)
      return { success: true }
    }
  )

  ipcHandle('chat:get-mcp-providers', async (_event, chatId: string) => {
    userActivation.requireActivated()
    return chatService.getMcpProviders(getProfileScopeUserId(), chatId)
  })

  ipcHandle('chat:on-demand-mcp-list', async (_event, chatId: string) => {
    userActivation.requireActivated()
    return chatService.listOnDemandMcps(getProfileScopeUserId(), chatId)
  })

  ipcHandle(
    'chat:on-demand-mcp-add',
    async (_event, chatId: string, mcpProviderId: string) => {
      userActivation.requireActivated()
      chatService.addOnDemandMcp(getProfileScopeUserId(), chatId, mcpProviderId)
      return { success: true }
    }
  )

  ipcHandle(
    'chat:on-demand-mcp-remove',
    async (_event, chatId: string, mcpProviderId: string) => {
      userActivation.requireActivated()
      chatService.removeOnDemandMcp(getProfileScopeUserId(), chatId, mcpProviderId)
      return { success: true }
    }
  )

  ipcHandle('chat:on-demand-agent-list', async (_event, chatId: string) => {
    userActivation.requireActivated()
    return chatService.listOnDemandAgents(getProfileScopeUserId(), chatId)
  })

  ipcHandle(
    'chat:on-demand-agent-add',
    async (_event, chatId: string, agentId: string) => {
      userActivation.requireActivated()
      chatService.addOnDemandAgent(getProfileScopeUserId(), chatId, agentId)
      return { success: true }
    }
  )

  ipcHandle(
    'chat:on-demand-agent-remove',
    async (_event, chatId: string, agentId: string) => {
      userActivation.requireActivated()
      chatService.removeOnDemandAgent(getProfileScopeUserId(), chatId, agentId)
      return { success: true }
    }
  )

  /**
   * Move a chat onto a router. The value is validated here rather than trusted:
   * `chats.router` is read by the send path to decide who answers, and a
   * renderer bug or a stale preload writing `'orchestrated'` would leave a chat
   * whose router matches nothing and whose messages route to the model by the
   * fallback, silently.
   */
  ipcHandle('chat:set-router', async (_event, chatId: string, router: string) => {
    userActivation.requireActivated()
    if (!isChatRouter(router)) {
      throw new ChatError('invalid_router', `Unknown chat router: ${String(router)}`)
    }
    chatService.setRouter(getProfileScopeUserId(), chatId, router)
    return { success: true }
  })
}
