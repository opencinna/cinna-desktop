import { getCurrentUserId } from '../auth/session'
import { userActivation } from '../auth/activation'
import { chatModeService } from '../services/chatModeService'
import { ipcHandle } from './_wrap'

export function registerChatModeHandlers(): void {
  ipcHandle('chatmode:list', async () => {
    userActivation.requireActivated()
    return chatModeService.list(getCurrentUserId())
  })

  ipcHandle('chatmode:get', async (_event, id: string) => {
    userActivation.requireActivated()
    return chatModeService.get(getCurrentUserId(), id)
  })

  ipcHandle(
    'chatmode:upsert',
    async (
      _event,
      data: {
        id?: string
        name: string
        providerId?: string | null
        modelId?: string | null
        mcpProviderIds?: string[]
        colorPreset?: string
      }
    ) => {
      userActivation.requireActivated()
      const { id } = chatModeService.upsert(getCurrentUserId(), data)
      return { id, success: true }
    }
  )

  ipcHandle('chatmode:delete', async (_event, id: string) => {
    userActivation.requireActivated()
    chatModeService.delete(getCurrentUserId(), id)
    return { success: true }
  })
}
