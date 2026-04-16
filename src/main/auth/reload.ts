import { eq } from 'drizzle-orm'
import { getDb } from '../db/client'
import { llmProviders, mcpProviders } from '../db/schema'
import { clearAllAdapters, registerAdapter } from '../llm/registry'
import { createAdapter } from '../ipc/llm.ipc'
import { decryptApiKey } from '../security/keystore'
import { mcpManager } from '../mcp/manager'
import { getCurrentUserId } from './session'

/** Reload LLM + MCP providers for the current user (called on user switch) */
export async function reloadUserProviders(): Promise<void> {
  clearAllAdapters()
  await mcpManager.disconnectAll()

  const db = getDb()
  const userId = getCurrentUserId()

  // Re-init LLM providers
  const llmRows = db.select().from(llmProviders).where(eq(llmProviders.userId, userId)).all()
  for (const provider of llmRows) {
    if (provider.enabled && provider.apiKeyEncrypted) {
      try {
        const apiKey = decryptApiKey(provider.apiKeyEncrypted)
        const adapter = createAdapter(provider.type, apiKey, provider.id)
        if (adapter) {
          registerAdapter(provider.id, adapter)
        }
      } catch (err) {
        console.error(`Failed to init provider ${provider.name}:`, err)
      }
    }
  }

  // Re-init MCP providers
  const mcpRows = db.select().from(mcpProviders).where(eq(mcpProviders.userId, userId)).all()
  for (const provider of mcpRows) {
    if (provider.enabled) {
      mcpManager
        .connect({
          id: provider.id,
          name: provider.name,
          transportType: provider.transportType as 'stdio' | 'sse' | 'streamable-http',
          command: provider.command ?? undefined,
          args: (provider.args as string[]) ?? undefined,
          url: provider.url ?? undefined,
          env: (provider.env as Record<string, string>) ?? undefined,
          enabled: true,
          authTokensEncrypted: provider.authTokensEncrypted ?? undefined,
          clientInfo: (provider.clientInfo as Record<string, unknown>) ?? undefined
        })
        .catch((err) => console.error(`Failed to init MCP ${provider.name}:`, err))
    }
  }
}
