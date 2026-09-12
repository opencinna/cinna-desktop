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
  /** Set on insert only — marks a provider auto-created from a synced job dep. */
  createdBySync?: boolean
  authType?: 'oauth' | 'bearer'
  /**
   * Encrypted bearer token. `undefined` preserves whatever is already stored
   * (the caller didn't touch it — mirrors how OAuth tokens are never passed
   * through the normal upsert path either); `null` clears it explicitly.
   */
  bearerTokenEncrypted?: Buffer | null
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
        const endpointChanged = existing.transportType !== input.transportType || existing.url !== (input.url ?? null) ||
          existing.authType !== (input.authType ?? existing.authType)
        const changed = endpointChanged || existing.command !== (input.command ?? null) ||
          JSON.stringify(existing.args) !== JSON.stringify(input.args ?? null) ||
          JSON.stringify(existing.env) !== JSON.stringify(input.env ?? null) ||
          existing.enabled !== (input.enabled ?? existing.enabled) || input.bearerTokenEncrypted !== undefined
        tx.update(mcpProviders)
          .set({
            configRevision: existing.configRevision + (changed ? 1 : 0),
            ...(endpointChanged ? { authTokensEncrypted: null, clientInfo: null, oauthDiscoveryState: null } : {}),
            name: input.name,
            transportType: input.transportType,
            command: input.command ?? null,
            args: input.args ?? null,
            url: input.url ?? null,
            env: input.env ?? null,
            enabled: input.enabled ?? existing.enabled,
            authType: input.authType ?? existing.authType,
            bearerTokenEncrypted:
              input.bearerTokenEncrypted !== undefined
                ? input.bearerTokenEncrypted
                : existing.bearerTokenEncrypted
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
            createdBySync: input.createdBySync ?? false,
            authType: input.authType ?? 'oauth',
            bearerTokenEncrypted: input.bearerTokenEncrypted ?? null,
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

  /** Captured configuration ownership is checked atomically with every OAuth write. */
  saveOAuthState(userId: string, id: string, configRevision: number, patch: {
    authTokensEncrypted?: Buffer | null
    clientInfo?: Record<string, unknown> | null
    oauthDiscoveryState?: import('@modelcontextprotocol/client').OAuthDiscoveryState | null
  }): void {
    const result = getDb().update(mcpProviders).set(patch)
      .where(and(eq(mcpProviders.id, id), eq(mcpProviders.userId, userId), eq(mcpProviders.configRevision, configRevision))).run()
    if (result.changes !== 1) throw new Error('The MCP configuration changed. Connect again.')
  }
}
