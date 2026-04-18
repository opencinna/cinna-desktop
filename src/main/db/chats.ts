import { and, eq } from 'drizzle-orm'
import { getDb } from './client'
import { chats, messages } from './schema'

export type ChatRow = typeof chats.$inferSelect
export type MessageRow = typeof messages.$inferSelect

export const chatRepo = {
  getOwned(userId: string, chatId: string): ChatRow | undefined {
    return getDb()
      .select()
      .from(chats)
      .where(and(eq(chats.id, chatId), eq(chats.userId, userId)))
      .get()
  },

  /** Load the full message history for an owned chat (caller must pre-verify ownership). */
  listMessages(chatId: string): MessageRow[] {
    return getDb()
      .select()
      .from(messages)
      .where(eq(messages.chatId, chatId))
      .orderBy(messages.sortOrder)
      .all()
  }
}
