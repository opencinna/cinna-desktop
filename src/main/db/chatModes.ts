import { nanoid } from 'nanoid'
import { and, eq } from 'drizzle-orm'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import { getDb } from './client'
import { chatModes } from './schema'
import type * as schema from './schema'

export type ChatModeRow = typeof chatModes.$inferSelect

export interface ChatModeUpsertInput {
  id?: string
  name: string
  providerId?: string | null
  modelId?: string | null
  mcpProviderIds?: string[]
  colorPreset?: string
  isDefault?: boolean
}

type DrizzleDb = BetterSQLite3Database<typeof schema>
type DrizzleTx = Parameters<Parameters<DrizzleDb['transaction']>[0]>[0]
/** A Drizzle handle that may be either the global db or a transaction proxy. */
export type DbOrTx = DrizzleDb | DrizzleTx

export const chatModeRepo = {
  list(userId: string, db: DbOrTx = getDb()): ChatModeRow[] {
    return db.select().from(chatModes).where(eq(chatModes.userId, userId)).all()
  },

  getOwned(userId: string, id: string, db: DbOrTx = getDb()): ChatModeRow | undefined {
    return db
      .select()
      .from(chatModes)
      .where(and(eq(chatModes.id, id), eq(chatModes.userId, userId)))
      .get()
  },

  /** Clears the `isDefault` flag on every chat mode owned by the user. */
  clearDefaults(userId: string, db: DbOrTx = getDb()): void {
    db.update(chatModes).set({ isDefault: false }).where(eq(chatModes.userId, userId)).run()
  },

  insert(
    userId: string,
    input: ChatModeUpsertInput,
    db: DbOrTx = getDb()
  ): { id: string; created: true } {
    const id = nanoid()
    db.insert(chatModes)
      .values({
        id,
        userId,
        name: input.name,
        providerId: input.providerId ?? null,
        modelId: input.modelId ?? null,
        mcpProviderIds: input.mcpProviderIds ?? [],
        colorPreset: input.colorPreset ?? 'slate',
        isDefault: input.isDefault ?? false,
        createdAt: new Date()
      })
      .run()
    return { id, created: true }
  },

  update(
    userId: string,
    id: string,
    input: ChatModeUpsertInput,
    db: DbOrTx = getDb()
  ): ChatModeRow | undefined {
    const existing = chatModeRepo.getOwned(userId, id, db)
    if (!existing) return undefined

    db.update(chatModes)
      .set({
        name: input.name,
        providerId: input.providerId ?? null,
        modelId: input.modelId ?? null,
        mcpProviderIds: input.mcpProviderIds ?? [],
        colorPreset: input.colorPreset ?? 'slate',
        isDefault: input.isDefault ?? existing.isDefault
      })
      .where(and(eq(chatModes.id, id), eq(chatModes.userId, userId)))
      .run()
    return existing
  },

  delete(userId: string, id: string, db: DbOrTx = getDb()): boolean {
    const result = db
      .delete(chatModes)
      .where(and(eq(chatModes.id, id), eq(chatModes.userId, userId)))
      .run()
    return result.changes > 0
  }
}
