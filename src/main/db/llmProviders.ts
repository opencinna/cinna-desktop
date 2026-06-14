import { and, eq, inArray } from 'drizzle-orm'
import { nanoid } from 'nanoid'
import { getDb } from './client'
import { llmProviders } from './schema'

export type LlmProviderRow = typeof llmProviders.$inferSelect

export interface UpsertInput {
  id?: string
  type: string
  name: string
  apiKeyEncrypted?: Buffer | null
  enabled?: boolean
  defaultModelId?: string | null
  /** Curated picker model ids (account-config `suggested_models`). Null clears it. */
  availableModels?: string[] | null
  baseUrl?: string | null
  managed?: boolean
  adminManaged?: boolean
  /**
   * Insert with the provided `id` when no row exists, instead of throwing
   * "Provider not found". The user-facing path leaves this false so a stale
   * update errors; account-config sync sets it to seed managed rows under their
   * deterministic `managed:{credentialId}` ids.
   */
  createIfMissing?: boolean
}

export interface UpsertResult {
  id: string
  created: boolean
  row: LlmProviderRow
}

export const llmProviderRepo = {
  list(userId: string): LlmProviderRow[] {
    return getDb()
      .select()
      .from(llmProviders)
      .where(eq(llmProviders.userId, userId))
      .all()
  },

  /** List providers across a set of scopes (Default + active profile). */
  listByUserIds(userIds: string[]): LlmProviderRow[] {
    if (userIds.length === 0) return []
    return getDb()
      .select()
      .from(llmProviders)
      .where(inArray(llmProviders.userId, userIds))
      .all()
  },

  /** Managed (account-provisioned) rows for a profile — used by sync prune. */
  listManaged(userId: string): LlmProviderRow[] {
    return getDb()
      .select()
      .from(llmProviders)
      .where(and(eq(llmProviders.userId, userId), eq(llmProviders.managed, true)))
      .all()
  },

  getOwned(userId: string, id: string): LlmProviderRow | undefined {
    return getDb()
      .select()
      .from(llmProviders)
      .where(and(eq(llmProviders.id, id), eq(llmProviders.userId, userId)))
      .get()
  },

  /** Insert or update a provider, scoped to userId. */
  upsert(userId: string, input: UpsertInput): UpsertResult {
    const db = getDb()
    const id = input.id ?? nanoid()

    return db.transaction((tx) => {
      const existing = input.id
        ? tx
            .select()
            .from(llmProviders)
            .where(and(eq(llmProviders.id, input.id), eq(llmProviders.userId, userId)))
            .get()
        : undefined

      if (input.id && !existing && !input.createIfMissing) {
        throw new Error('Provider not found')
      }

      const apiKeyEncrypted =
        input.apiKeyEncrypted !== undefined
          ? input.apiKeyEncrypted
          : existing?.apiKeyEncrypted ?? null

      if (existing) {
        tx.update(llmProviders)
          .set({
            name: input.name,
            type: input.type,
            apiKeyEncrypted,
            enabled: input.enabled ?? existing.enabled,
            defaultModelId:
              input.defaultModelId !== undefined
                ? input.defaultModelId
                : existing.defaultModelId,
            availableModels:
              input.availableModels !== undefined
                ? input.availableModels
                : existing.availableModels,
            baseUrl: input.baseUrl !== undefined ? input.baseUrl : existing.baseUrl,
            managed: input.managed ?? existing.managed,
            adminManaged: input.adminManaged ?? existing.adminManaged
          })
          .where(and(eq(llmProviders.id, id), eq(llmProviders.userId, userId)))
          .run()
      } else {
        tx.insert(llmProviders)
          .values({
            id,
            userId,
            type: input.type,
            name: input.name,
            apiKeyEncrypted,
            enabled: input.enabled ?? true,
            defaultModelId: input.defaultModelId ?? null,
            availableModels: input.availableModels ?? null,
            baseUrl: input.baseUrl ?? null,
            managed: input.managed ?? false,
            adminManaged: input.adminManaged ?? false,
            createdAt: new Date()
          })
          .run()
      }

      const row = tx
        .select()
        .from(llmProviders)
        .where(and(eq(llmProviders.id, id), eq(llmProviders.userId, userId)))
        .get()

      if (!row) throw new Error('Failed to load provider after upsert')

      return { id, created: !existing, row }
    })
  },

  delete(userId: string, id: string): boolean {
    const result = getDb()
      .delete(llmProviders)
      .where(and(eq(llmProviders.id, id), eq(llmProviders.userId, userId)))
      .run()
    return result.changes > 0
  }
}
