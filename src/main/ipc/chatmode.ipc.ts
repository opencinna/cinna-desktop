import { userActivation } from '../auth/activation'
import { getSettingsScopeUserId } from '../auth/scope'
import { chatModeService } from '../services/chatModeService'
import { notifyAccountConfigSynced } from '../services/account-config-sync'
import { ipcHandle } from './_wrap'

export function registerChatModeHandlers(): void {
  ipcHandle('chatmode:list', async () => {
    userActivation.requireActivated()
    // Unions Default-scope user modes + active-profile managed modes (with the
    // local enable overlay + account-default precedence applied).
    return chatModeService.listMerged()
  })

  ipcHandle('chatmode:get', async (_event, id: string) => {
    userActivation.requireActivated()
    return chatModeService.findMerged(id)
  })

  // Toggle an account-provisioned chat mode on/off locally (per-profile override).
  ipcHandle(
    'chatmode:set-managed-enabled',
    async (_event, data: { id: string; enabled: boolean }) => {
      userActivation.requireActivated()
      chatModeService.setManagedEnabled(data.id, data.enabled)
      notifyAccountConfigSynced()
      return { success: true }
    }
  )

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
        isDefault?: boolean
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
