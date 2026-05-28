import { userActivation } from '../auth/activation'
import { getProfileScopeUserId } from '../auth/scope'
import { chatService } from '../services/chatService'
import { ipcHandle } from './_wrap'

export function registerChatHandlers(): void {
  ipcHandle('chat:list', async () => {
    userActivation.requireActivated()
    return chatService.list(getProfileScopeUserId())
  })

  ipcHandle('chat:get', async (_event, chatId: string) => {
    userActivation.requireActivated()
    return chatService.get(getProfileScopeUserId(), chatId)
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
        agentId?: string
        orchestrated?: boolean
      }
    ) => {
      userActivation.requireActivated()
      // The service signature is `ChatMetaUpdate` only — routing fields
      // (activeAgentId, smartAssistDisabled) are a compile-time error here
      // and must go through the `multiAgent:*` channels.
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
}
