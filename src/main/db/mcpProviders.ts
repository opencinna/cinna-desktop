import { and, eq } from 'drizzle-orm'
import { nanoid } from 'nanoid'
import { getDb } from './client'
import { mcpProviders } from './schema'

export type McpProviderRow = typeof mcpProviders.$inferSelect

export interface UpsertInput {
  id?: string
  name: string
  transportType: 'stdio' | 'sse' | 'streamable-http'
  command?: string | null
  args?: string[] | null
  url?: string | null
  env?: Record<string, string> | null
  enabled?: boolean
}

export interface UpsertResult {
  id: string
  created: boolean
  row: McpProviderRow
}

export const mcpProviderRepo = {
  list(userId: string): McpProviderRow[] {
    return getDb()
      .select()
      .from(mcpProviders)
      .where(eq(mcpProviders.userId, userId))
      .all()
  },

  getOwned(userId: string, id: string): McpProviderRow | undefined {
    return getDb()
      .select()
      .from(mcpProviders)
      .where(and(eq(mcpProviders.id, id), eq(mcpProviders.userId, userId)))
      .get()
  },

  upsert(userId: string, input: UpsertInput): UpsertResult {
    const db = getDb()
    const id = input.id ?? nanoid()

    return db.transaction((tx) => {
      const existing = input.id
        ? tx
            .select()
            .from(mcpProviders)
            .where(and(eq(mcpProviders.id, input.id), eq(mcpProviders.userId, userId)))
            .get()
        : undefined

      if (input.id && !existing) {
        throw new Error('MCP provider not found')
      }

      if (existing) {
        tx.update(mcpProviders)
          .set({
            name: input.name,
            transportType: input.transportType,
            command: input.command ?? null,
            args: input.args ?? null,
            url: input.url ?? null,
            env: input.env ?? null,
            enabled: input.enabled ?? existing.enabled
          })
          .where(and(eq(mcpProviders.id, id), eq(mcpProviders.userId, userId)))
          .run()
      } else {
        tx.insert(mcpProviders)
          .values({
            id,
            userId,
            name: input.name,
            transportType: input.transportType,
            command: input.command ?? null,
            args: input.args ?? null,
            url: input.url ?? null,
            env: input.env ?? null,
            enabled: input.enabled ?? true,
            createdAt: new Date()
          })
          .run()
      }

      const row = tx
        .select()
        .from(mcpProviders)
        .where(and(eq(mcpProviders.id, id), eq(mcpProviders.userId, userId)))
        .get()

      if (!row) throw new Error('Failed to load MCP provider after upsert')

      return { id, created: !existing, row }
    })
  },

  delete(userId: string, id: string): boolean {
    const result = getDb()
      .delete(mcpProviders)
      .where(and(eq(mcpProviders.id, id), eq(mcpProviders.userId, userId)))
      .run()
    return result.changes > 0
  },

  /**
   * Persist OAuth tokens without an ownership check — called from the manager
   * during the OAuth callback, which already holds the provider handle. Keeps
   * the write isolated so the manager doesn't touch Drizzle directly.
   */
  setAuthTokens(id: string, encrypted: Buffer): void {
    getDb()
      .update(mcpProviders)
      .set({ authTokensEncrypted: encrypted })
      .where(eq(mcpProviders.id, id))
      .run()
  },

  setClientInfo(id: string, clientInfo: Record<string, unknown>): void {
    getDb()
      .update(mcpProviders)
      .set({ clientInfo })
      .where(eq(mcpProviders.id, id))
      .run()
  }
}
