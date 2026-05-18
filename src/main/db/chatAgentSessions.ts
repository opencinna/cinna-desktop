import { and, eq } from 'drizzle-orm'
import { getDb } from './client'
import { chatAgentSessions } from './schema'

export type ChatAgentSessionRow = typeof chatAgentSessions.$inferSelect

/**
 * Catch-up cursor per (chat, agent). Tracks the last message id replayed to a
 * given agent so the next catch-up packet picks up from the next message.
 */
export const chatAgentSessionRepo = {
  getCursor(chatId: string, agentId: string): string | null {
    const row = getDb()
      .select()
      .from(chatAgentSessions)
      .where(
        and(eq(chatAgentSessions.chatId, chatId), eq(chatAgentSessions.agentId, agentId))
      )
      .get()
    return row?.lastReplayedMessageId ?? null
  },

  // Single atomic statement — two parallel sends to the same (chat, agent)
  // cannot race between a select and an insert anymore.
  upsertCursor(chatId: string, agentId: string, lastMessageId: string): void {
    const now = new Date()
    getDb()
      .insert(chatAgentSessions)
      .values({
        chatId,
        agentId,
        lastReplayedMessageId: lastMessageId,
        createdAt: now,
        updatedAt: now
      })
      .onConflictDoUpdate({
        target: [chatAgentSessions.chatId, chatAgentSessions.agentId],
        set: { lastReplayedMessageId: lastMessageId, updatedAt: now }
      })
      .run()
  }
}
