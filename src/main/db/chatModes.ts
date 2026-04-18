import { nanoid } from 'nanoid'
import { and, eq } from 'drizzle-orm'
import { getDb } from './client'
import { chatModes } from './schema'

export type ChatModeRow = typeof chatModes.$inferSelect

export interface ChatModeUpsertInput {
  id?: string
  name: string
  providerId?: string | null
  modelId?: string | null
  mcpProviderIds?: string[]
  colorPreset?: string
}

export const chatModeRepo = {
  list(userId: string): ChatModeRow[] {
    return getDb()
      .select()
      .from(chatModes)
      .where(eq(chatModes.userId, userId))
      .all()
  },

  getOwned(userId: string, id: string): ChatModeRow | undefined {
    return getDb()
      .select()
      .from(chatModes)
      .where(and(eq(chatModes.id, id), eq(chatModes.userId, userId)))
      .get()
  },

  upsert(userId: string, input: ChatModeUpsertInput): { id: string; created: boolean } {
    const db = getDb()
    const mcpProviderIds = input.mcpProviderIds ?? []
    const colorPreset = input.colorPreset ?? 'slate'

    if (input.id) {
      db.update(chatModes)
        .set({
          name: input.name,
          providerId: input.providerId ?? null,
          modelId: input.modelId ?? null,
          mcpProviderIds,
          colorPreset
        })
        .where(and(eq(chatModes.id, input.id), eq(chatModes.userId, userId)))
        .run()
      return { id: input.id, created: false }
    }

    const id = nanoid()
    db.insert(chatModes)
      .values({
        id,
        userId,
        name: input.name,
        providerId: input.providerId ?? null,
        modelId: input.modelId ?? null,
        mcpProviderIds,
        colorPreset,
        createdAt: new Date()
      })
      .run()
    return { id, created: true }
  },

  delete(userId: string, id: string): boolean {
    const result = getDb()
      .delete(chatModes)
      .where(and(eq(chatModes.id, id), eq(chatModes.userId, userId)))
      .run()
    return result.changes > 0
  }
}
