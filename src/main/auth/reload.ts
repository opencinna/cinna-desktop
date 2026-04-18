import { llmProviderRepo } from '../db/llmProviders'
import { mcpProviderRepo } from '../db/mcpProviders'
import { clearAllAdapters, registerAdapter } from '../llm/registry'
import { createAdapter } from '../llm/factory'
import { decryptApiKey } from '../security/keystore'
import { mcpManager } from '../mcp/manager'
import { getCurrentUserId } from './session'
import { createLogger } from '../logger/logger'

const logger = createLogger('Activation')

/** Reload LLM + MCP providers for the current user (called on user switch) */
export async function reloadUserProviders(): Promise<void> {
  clearAllAdapters()
  await mcpManager.disconnectAll()

  const userId = getCurrentUserId()

  for (const provider of llmProviderRepo.list(userId)) {
    if (provider.enabled && provider.apiKeyEncrypted) {
      try {
        const apiKey = decryptApiKey(provider.apiKeyEncrypted)
        const adapter = createAdapter(provider.type, apiKey, provider.id)
        if (adapter) registerAdapter(provider.id, adapter)
      } catch (err) {
        logger.error(`Failed to init provider ${provider.name}`, err)
      }
    }
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
