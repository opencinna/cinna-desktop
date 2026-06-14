import { llmProviderRepo } from '../db/llmProviders'
import { mcpProviderRepo } from '../db/mcpProviders'
import { clearAllAdapters, registerAdapter } from '../llm/registry'
import { createAdapter } from '../llm/factory'
import { decryptApiKey } from '../security/keystore'
import { mcpManager } from '../mcp/manager'
import { getSettingsScopeUserId, getProfileScopeUserId, DEFAULT_SCOPE_USER_ID } from './scope'
import { accountConfigService } from '../services/accountConfigService'
import { createLogger } from '../logger/logger'

const logger = createLogger('Activation')

/**
 * Reload LLM + MCP providers from the default (shared) settings scope. Called
 * on activation: providers are not per-profile, so the same set is loaded
 * regardless of which user just signed in.
 */
export async function reloadUserProviders(): Promise<void> {
  clearAllAdapters()
  await mcpManager.disconnectAll()

  const userId = getSettingsScopeUserId()

  for (const provider of llmProviderRepo.list(userId)) {
    if (provider.enabled && provider.apiKeyEncrypted) {
      try {
        const apiKey = decryptApiKey(provider.apiKeyEncrypted)
        const adapter = createAdapter(provider.type, apiKey, provider.id, {
          baseUrl: provider.baseUrl,
          fallbackModels: provider.defaultModelId ? [provider.defaultModelId] : []
        })
        if (adapter) registerAdapter(provider.id, adapter)
      } catch (err) {
        logger.error(`Failed to init provider ${provider.name}`, err)
      }
    }
  }

  // Account-provisioned (Cinna-managed) providers are profile-scoped. Load the
  // active profile's already-synced managed adapters so they're usable
  // immediately on activation (even before the network sync refreshes them).
  const profileUserId = getProfileScopeUserId()
  if (profileUserId !== DEFAULT_SCOPE_USER_ID) {
    accountConfigService.loadManagedAdapters(profileUserId)
  }

  for (const provider of mcpProviderRepo.list(userId)) {
    if (!provider.enabled) continue
    mcpManager
      .connect({
        id: provider.id,
        name: provider.name,
        transportType: provider.transportType as 'stdio' | 'sse' | 'streamable-http',
        command: provider.command ?? undefined,
        args: (provider.args as string[] | null) ?? undefined,
        url: provider.url ?? undefined,
        env: (provider.env as Record<string, string> | null) ?? undefined,
        enabled: true,
        authTokensEncrypted: provider.authTokensEncrypted ?? undefined,
        clientInfo: (provider.clientInfo as Record<string, unknown> | null) ?? undefined
      })
      .catch((err) => logger.error(`Failed to init MCP ${provider.name}`, err))
  }
}
