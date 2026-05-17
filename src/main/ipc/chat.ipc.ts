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
      }
    ) => {
      userActivation.requireActivated()
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
}
