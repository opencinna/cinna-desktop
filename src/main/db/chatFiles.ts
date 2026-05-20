import { and, eq } from 'drizzle-orm'
import { getDb } from './client'
import { chatFiles } from './schema'

export type ChatFileRow = typeof chatFiles.$inferSelect

export interface InsertChatFile {
  id: string
  userId: string
  chatId: string
  storagePath: string
  mimeType: string
  size: number
  filename: string
}

export const chatFileRepo = {
  insert(row: InsertChatFile): void {
    getDb()
      .insert(chatFiles)
      .values({
        ...row,
        createdAt: new Date()
      })
      .run()
  },

  getOwned(userId: string, id: string): ChatFileRow | undefined {
    return getDb()
      .select()
      .from(chatFiles)
      .where(and(eq(chatFiles.id, id), eq(chatFiles.userId, userId)))
      .get()
  },

  delete(userId: string, id: string): boolean {
    const result = getDb()
      .delete(chatFiles)
      .where(and(eq(chatFiles.id, id), eq(chatFiles.userId, userId)))
      .run()
    return result.changes > 0
  }
}
