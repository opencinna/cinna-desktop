import { llmProviderRepo } from '../db/llmProviders'
import { requiresApiKey } from '../../shared/credentials'
import { mcpProviderRepo } from '../db/mcpProviders'
import { clearAllAdapters, registerAdapter } from '../llm/registry'
import { createAdapter } from '../llm/factory'
import { decryptApiKey } from '../security/keystore'
import { mcpManager } from '../mcp/manager'
import { mcpRowToConfig } from '../mcp/config'
import { missingEnvOf } from '../mcp/managed'
import { getSettingsScopeUserId, getProfileScopeUserId, DEFAULT_SCOPE_USER_ID } from './scope'
import { accountConfigService } from '../services/accountConfigService'
import { createLogger } from '../logger/logger'

const logger = createLogger('Activation')

/**
 * Reload LLM + MCP providers from the default (shared) settings scope. Called
 * on activation: providers are not per-profile, so the same set is loaded
 * regardless of which user just signed in.
 */
export async function reloadUserProviders(current: () => boolean = () => true): Promise<void> {
  if (!current()) return
  const profileUserId = getProfileScopeUserId()
  clearAllAdapters()
  await mcpManager.disconnectAll()
  if (!current()) return

  const userId = getSettingsScopeUserId()

  for (const provider of llmProviderRepo.list(userId)) {
    // A keyless credential (Ollama) has nothing to decrypt and registers on
    // `enabled` alone — without this it would be absent from the model picker
    // on every launch until the user re-saved it.
    if (provider.enabled && (provider.apiKeyEncrypted || !requiresApiKey(provider.type))) {
      try {
        const apiKey = provider.apiKeyEncrypted ? await decryptApiKey(provider.apiKeyEncrypted) : ''
        // The keystore awaited: a newer activation may have cleared the adapters meanwhile.
        if (!current()) return
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
  if (profileUserId !== DEFAULT_SCOPE_USER_ID) {
    await accountConfigService.loadManagedAdapters(profileUserId, current)
    if (!current()) return
  }

  // A plugin's connector starts only when an agent has it and it can run (values given, not blocked).
  // One held back by a launch block alone (the policy, its files changed) goes to the manager anyway:
  // it refuses it before anything runs, so the connector's card reads why instead of a bare "disconnected".
  let plugins: Promise<typeof import('../services/marketplacePluginService')> | null = null
  for (const provider of mcpProviderRepo.list(userId)) {
    if (!provider.enabled) continue
    if (provider.managedBy) {
      plugins ??= import('../services/marketplacePluginService')
      void plugins
        .then(async ({ marketplacePluginService }) => {
          const runs = await marketplacePluginService.startsUnattended(provider)
          if (!current()) return undefined
          // The block is the one the config carries: a policy that changed meanwhile can neither
          // start a row past startsUnattended's Node/Docker check nor connect one whose config lost its block.
          const config = await mcpRowToConfig(provider)
          const blocked = await marketplacePluginService.launchBlockOf(provider, config)
          if (!current()) return undefined
          if (!runs && blocked === null) return undefined
          return mcpManager.connect(config)
        })
        .catch((err) => logger.error(`Failed to init MCP ${provider.name}`, err))
      continue
    }
    // One made from a directory entry (an agent's addon, or Settings → MCP "Add from Registry", which chats use
    // as an already-connected connector) starts like any other once its settings are filled in.
    // Its settings decrypted here, in turn, so every connect has started by the time this resolves.
    if (provider.registryRef && (await missingEnvOf(provider)).length > 0) continue
    const config = await mcpRowToConfig(provider)
    if (!current()) return
    mcpManager
      .connect(config)
      .catch((err) => logger.error(`Failed to init MCP ${provider.name}`, err))
  }
}
