import { ipcMain } from 'electron'
import { nanoid } from 'nanoid'
import { eq } from 'drizzle-orm'
import { getDb } from '../db/client'
import { mcpProviders, chatMcpProviders } from '../db/schema'
import { mcpManager } from '../mcp/manager'
import { getCurrentUserId } from '../auth/session'
import { userActivation } from '../auth/activation'

function buildConfig(provider: typeof mcpProviders.$inferSelect) {
  return {
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
  }
}

export function registerMcpHandlers(): void {
  ipcMain.handle('mcp:list', async () => {
    userActivation.requireActivated()
    const db = getDb()
    const userId = getCurrentUserId()
    const providers = db.select().from(mcpProviders).where(eq(mcpProviders.userId, userId)).all()
    return providers.map((p) => {
      const conn = mcpManager.getConnection(p.id)
      return {
        ...p,
        // Strip encrypted data from renderer response
        authTokensEncrypted: undefined,
        hasAuth: !!(p.authTokensEncrypted || p.clientInfo),
        status: conn?.status ?? 'disconnected',
        tools: conn?.tools ?? [],
        error: conn?.error
      }
    })
  })

  ipcMain.handle(
    'mcp:upsert',
    async (
      _event,
      data: {
        id?: string
        name: string
        transportType: string
        command?: string
        args?: string[]
        url?: string
        env?: Record<string, string>
        enabled?: boolean
      }
    ) => {
      userActivation.requireActivated()
      const db = getDb()
      const id = data.id || nanoid()

      const existing = data.id
        ? db.select().from(mcpProviders).where(eq(mcpProviders.id, data.id)).get()
        : null

      if (existing) {
        db.update(mcpProviders)
          .set({
            name: data.name,
            transportType: data.transportType,
            command: data.command ?? null,
            args: data.args ?? null,
            url: data.url ?? null,
            env: data.env ?? null,
            enabled: data.enabled ?? existing.enabled
          })
          .where(eq(mcpProviders.id, id))
          .run()
      } else {
        db.insert(mcpProviders)
          .values({
            id,
            userId: getCurrentUserId(),
            name: data.name,
            transportType: data.transportType,
            command: data.command ?? null,
            args: data.args ?? null,
            url: data.url ?? null,
            env: data.env ?? null,
            enabled: data.enabled ?? true,
            createdAt: new Date()
          })
          .run()
      }

      // Reconnect if enabled
      const provider = db.select().from(mcpProviders).where(eq(mcpProviders.id, id)).get()
      if (provider && provider.enabled) {
        await mcpManager.connect(buildConfig(provider))
      } else {
        await mcpManager.disconnect(id)
      }

      return { id, success: true }
    }
  )

  ipcMain.handle('mcp:delete', async (_event, providerId: string) => {
    userActivation.requireActivated()
    const db = getDb()
    await mcpManager.disconnect(providerId)
    db.delete(mcpProviders).where(eq(mcpProviders.id, providerId)).run()
    return { success: true }
  })

  ipcMain.handle('mcp:connect', async (_event, providerId: string) => {
    userActivation.requireActivated()
    const db = getDb()
    const provider = db.select().from(mcpProviders).where(eq(mcpProviders.id, providerId)).get()
    if (!provider) return { success: false, error: 'Provider not found' }

    try {
      const conn = await mcpManager.connect(buildConfig(provider))
      return { success: true, tools: conn.tools, status: conn.status }
    } catch (err) {
      return { success: false, error: String(err) }
    }
  })

  ipcMain.handle('mcp:disconnect', async (_event, providerId: string) => {
    userActivation.requireActivated()
    await mcpManager.disconnect(providerId)
    return { success: true }
  })

  ipcMain.handle('mcp:list-tools', async (_event, providerId: string) => {
    userActivation.requireActivated()
    const conn = mcpManager.getConnection(providerId)
    return conn?.tools ?? []
  })

  ipcMain.handle(
    'chat:set-mcp-providers',
    async (_event, chatId: string, mcpProviderIds: string[]) => {
      userActivation.requireActivated()
      const db = getDb()
      // Clear existing
      db.delete(chatMcpProviders)
        .where(eq(chatMcpProviders.chatId, chatId))
        .run()
      // Insert new
      for (const mcpProviderId of mcpProviderIds) {
        db.insert(chatMcpProviders).values({ chatId, mcpProviderId }).run()
      }
      return { success: true }
    }
  )

  ipcMain.handle('chat:get-mcp-providers', async (_event, chatId: string) => {
    userActivation.requireActivated()
    const db = getDb()
    return db
      .select()
      .from(chatMcpProviders)
      .where(eq(chatMcpProviders.chatId, chatId))
      .all()
  })
}
