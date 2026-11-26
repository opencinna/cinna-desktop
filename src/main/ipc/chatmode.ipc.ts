import { userActivation } from '../auth/activation'
import { getSettingsScopeUserId } from '../auth/scope'
import { chatModeService } from '../services/chatModeService'
import { listChatModesWithRuntimes } from '../services/localAgents/runtimeModeAvailability'
import { notifyAccountConfigSynced } from '../services/account-config-sync'
import { ipcHandle } from './_wrap'
import { runtimeService } from '../services/localAgents/runtimeService'
import { localAgentService } from '../services/localAgents/localAgentService'

/**
 * Run a chat-mode edit, then refresh the folder agents if it moved what the
 * Default runtime spends: an OpenCode agent with no credential of its own runs
 * on the default chat mode's credential, and its `resolvedRuntime` (credential,
 * and the names a runtime conflict shows) is resolved in the cached scan.
 */
function movingDefault<T>(edit: () => T): T {
  const before = runtimeService.defaultRuntimeKey()
  const result = edit()
  localAgentService.refreshIfDefaultRuntimeMoved(getSettingsScopeUserId(), before)
  return result
}

export function registerChatModeHandlers(): void {
  ipcHandle('chatmode:list', async () => {
    userActivation.requireActivated()
    // Unions Default-scope user modes + active-profile managed modes (with the
    // local enable overlay + account-default precedence applied), runtime modes
    // created where missing and carrying their availability.
    return listChatModesWithRuntimes()
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
      movingDefault(() => chatModeService.setManagedEnabled(data.id, data.enabled))
      notifyAccountConfigSynced()
      return { success: true }
    }
  )

  // Set the local model for an account-provisioned chat mode (per-profile
  // override; null reverts to the synced default).
  ipcHandle(
    'chatmode:set-managed-model',
    async (_event, data: { id: string; modelId: string | null }) => {
      userActivation.requireActivated()
      movingDefault(() => chatModeService.setManagedModel(data.id, data.modelId))
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
      engine?: import('../../shared/engine').AgentEngine | null
      systemPrompt?: string
      toolPolicy?: import('../../shared/chatModeRuntime').ChatToolPolicy
      complexity?: import('../../shared/modelFamilies').WorkComplexity | null
        mcpProviderIds?: string[]
        colorPreset?: string
        isDefault?: boolean
      }
    ) => {
      userActivation.requireActivated()
      const { id } = movingDefault(() => chatModeService.upsert(getSettingsScopeUserId(), data))
      return { id, success: true }
    }
  )

  // Restore a runtime mode's defaults (keeps whether it is the default).
  ipcHandle('chatmode:reset', async (_event, id: string) => {
    userActivation.requireActivated()
    movingDefault(() => chatModeService.reset(getSettingsScopeUserId(), id))
    return { success: true }
  })

  ipcHandle('chatmode:delete', async (_event, id: string) => {
    userActivation.requireActivated()
    movingDefault(() => chatModeService.delete(getSettingsScopeUserId(), id))
    return { success: true }
  })
}
