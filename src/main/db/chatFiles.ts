import { and, eq, isNotNull } from 'drizzle-orm'
import { getDb } from './client'
import { chatFiles, chats } from './schema'

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

  /**
   * The attachment rows of vault chats (`chats.vault_id` set), of one vault or
   * of every vault: copies that must not outlive the turn that sent them (D23).
   */
  listOfVaultChats(vaultId?: string): ChatFileRow[] {
    return getDb()
      .select({ file: chatFiles })
      .from(chatFiles)
      .innerJoin(chats, eq(chats.id, chatFiles.chatId))
      .where(vaultId === undefined ? isNotNull(chats.vaultId) : eq(chats.vaultId, vaultId))
      .all()
      .map((row) => row.file)
  },

  delete(userId: string, id: string): boolean {
    const result = getDb()
      .delete(chatFiles)
      .where(and(eq(chatFiles.id, id), eq(chatFiles.userId, userId)))
      .run()
    return result.changes > 0
  }
}
