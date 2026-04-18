import { getCurrentUserId } from '../auth/session'
import { userActivation } from '../auth/activation'
import { chatService } from '../services/chatService'
import { ipcHandle } from './_wrap'

export function registerChatHandlers(): void {
  ipcHandle('chat:list', async () => {
    userActivation.requireActivated()
    return chatService.list(getCurrentUserId())
  })

  ipcHandle('chat:get', async (_event, chatId: string) => {
    userActivation.requireActivated()
    return chatService.get(getCurrentUserId(), chatId)
  })

  ipcHandle('chat:create', async () => {
    userActivation.requireActivated()
    return chatService.create(getCurrentUserId())
  })

  ipcHandle('chat:delete', async (_event, chatId: string) => {
    userActivation.requireActivated()
    chatService.delete(getCurrentUserId(), chatId)
    return { success: true }
  })

  ipcHandle('chat:trash-list', async () => {
    userActivation.requireActivated()
    return chatService.listTrash(getCurrentUserId())
  })

  ipcHandle('chat:restore', async (_event, chatId: string) => {
    userActivation.requireActivated()
    chatService.restore(getCurrentUserId(), chatId)
    return { success: true }
  })

  ipcHandle('chat:permanent-delete', async (_event, chatId: string) => {
    userActivation.requireActivated()
    chatService.permanentDelete(getCurrentUserId(), chatId)
    return { success: true }
  })

  ipcHandle('chat:empty-trash', async () => {
    userActivation.requireActivated()
    chatService.emptyTrash(getCurrentUserId())
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
      chatService.update(getCurrentUserId(), chatId, updates)
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
      return chatService.addMessage(getCurrentUserId(), chatId, message)
    }
  )

  ipcHandle(
    'chat:set-mcp-providers',
    async (_event, chatId: string, mcpProviderIds: string[]) => {
      userActivation.requireActivated()
      chatService.setMcpProviders(getCurrentUserId(), chatId, mcpProviderIds)
      return { success: true }
    }
  )

  ipcHandle('chat:get-mcp-providers', async (_event, chatId: string) => {
    userActivation.requireActivated()
    return chatService.getMcpProviders(getCurrentUserId(), chatId)
  })
}
