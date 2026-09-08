import { userActivation } from '../auth/activation'
import { getSettingsScopeUserId, getProfileScopeUserId } from '../auth/scope'
import { providerService } from '../services/providerService'
import { ollamaService } from '../services/ollamaService'
import { runAccountConfigSyncOnce } from '../services/account-config-sync'
import { ipcErrorShape } from '../errors'
import { ipcHandle } from './_wrap'

export function registerProviderHandlers(): void {
  ipcHandle('provider:list', async () => {
    userActivation.requireActivated()
    // Unions Default-scope user providers + active-profile managed providers.
    return providerService.listMerged()
  })

  // Manual "Sync now" for account-provisioned providers/modes (Settings button).
  ipcHandle('provider:sync-account-config', async () => {
    userActivation.requireActivated()
    await runAccountConfigSyncOnce(getProfileScopeUserId())
    return { success: true }
  })

  ipcHandle(
    'provider:upsert',
    async (
      _event,
      data: {
        id?: string
        type: string
        name: string
        apiKey?: string
        enabled?: boolean
        defaultModelId?: string | null
        /** Gateway / Ollama host. Omitted leaves the stored value alone. */
        baseUrl?: string | null
      }
    ) => {
      userActivation.requireActivated()
      const { id } = providerService.upsert(getSettingsScopeUserId(), data)
      return { id, success: true }
    }
  )

  ipcHandle('provider:delete', async (_event, providerId: string) => {
    userActivation.requireActivated()
    providerService.delete(getSettingsScopeUserId(), providerId)
    return { success: true }
  })

  // provider:test and provider:test-key catch their own errors and return
  // them as a discriminated-union shape — the renderer's settings UI renders
  // the error inline rather than letting React Query enter an error state.
  ipcHandle('provider:test', async (_event, providerId: string) => {
    userActivation.requireActivated()
    try {
      const models = await providerService.test(getSettingsScopeUserId(), providerId)
      return { success: true as const, models }
    } catch (err) {
      const e = ipcErrorShape(err)
      return { success: false as const, error: e.message }
    }
  })

  // Also the probe for a credential that has no key at all: an Ollama row is
  // identified by its host, so `{type, baseUrl}` is a complete request here.
  ipcHandle(
    'provider:test-key',
    async (_event, data: { type: string; apiKey?: string; baseUrl?: string | null }) => {
      userActivation.requireActivated()
      try {
        const models = await providerService.testKey(data)
        return { success: true as const, models }
      } catch (err) {
        const e = ipcErrorShape(err)
        return { success: false as const, error: e.message }
      }
    }
  )

  /**
   * Is an Ollama running on this machine, and what has it pulled?
   *
   * Returns a shape rather than throwing when nothing answers — "not running"
   * is the ordinary answer here, and a React Query error state would render a
   * failure on a screen where nothing has failed.
   */
  ipcHandle('provider:detect-ollama', async (_event, host?: string | null) => {
    userActivation.requireActivated()
    return ollamaService.detect(host)
  })

  ipcHandle('provider:list-models', async () => {
    userActivation.requireActivated()
    return providerService.listModels()
  })

  // On-demand live model fetch for a single provider (scope-aware → works for
  // managed providers). Unlike provider:test/test-key (which catch and return a
  // `{ success, error }` union for inline settings rendering), this intentionally
  // THROWS the ProviderError: the managed chat-mode card consumes it via React
  // Query's `isError`, and `ipcHandle` preserves the DomainError `code`/`detail`
  // across the boundary so the card shows the provider's real message + retry.
  ipcHandle('provider:fetch-models', async (_event, providerId: string) => {
    userActivation.requireActivated()
    return providerService.fetchModels(providerId)
  })
}
