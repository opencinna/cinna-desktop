import { and, eq } from 'drizzle-orm'
import { getDb } from './client'
import { chatAgentCursors } from './schema'

export type ChatAgentCursorRow = typeof chatAgentCursors.$inferSelect

/**
 * How much of a chat each agent has already been shown.
 *
 * One row per (chat, agent), holding the last message id that agent has seen.
 * **No row means it has seen nothing** — which is the honest state for an agent
 * taking its first turn in a chat that already has a history, and what makes
 * the first catch-up packet the whole thread rather than an empty one.
 *
 * Written only by the send path, and only when a turn completes: a failed or
 * cancelled turn leaves the cursor where it was so the retry carries the same
 * gap. See `threadContextService`.
 */
export const chatAgentCursorRepo = {
  get(chatId: string, agentId: string): ChatAgentCursorRow | undefined {
    return getDb()
      .select()
      .from(chatAgentCursors)
      .where(and(eq(chatAgentCursors.chatId, chatId), eq(chatAgentCursors.agentId, agentId)))
      .get()
  },

  list(chatId: string): ChatAgentCursorRow[] {
    return getDb()
      .select()
      .from(chatAgentCursors)
      .where(eq(chatAgentCursors.chatId, chatId))
      .all()
  },

  /** Move an agent's cursor to `lastMessageId`. Idempotent; inserts the row on first use. */
  advance(chatId: string, agentId: string, lastMessageId: string): void {
    getDb()
      .insert(chatAgentCursors)
      .values({ chatId, agentId, lastMessageId, updatedAt: new Date() })
      .onConflictDoUpdate({
        target: [chatAgentCursors.chatId, chatAgentCursors.agentId],
        set: { lastMessageId, updatedAt: new Date() }
      })
      .run()
  }
}
