import { userActivation } from '../auth/activation'
import { getSettingsScopeUserId } from '../auth/scope'
import { chatModeService } from '../services/chatModeService'
import { ipcHandle } from './_wrap'

export function registerChatModeHandlers(): void {
  ipcHandle('chatmode:list', async () => {
    userActivation.requireActivated()
    return chatModeService.list(getSettingsScopeUserId())
  })

  ipcHandle('chatmode:get', async (_event, id: string) => {
    userActivation.requireActivated()
    return chatModeService.get(getSettingsScopeUserId(), id)
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
      const { id } = chatModeService.upsert(getSettingsScopeUserId(), data)
      return { id, success: true }
    }
  )

  ipcHandle('chatmode:delete', async (_event, id: string) => {
    userActivation.requireActivated()
    chatModeService.delete(getSettingsScopeUserId(), id)
    return { success: true }
  })
}
