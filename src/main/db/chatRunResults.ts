import { and, eq, inArray } from 'drizzle-orm'
import { getDb } from './client'
import { chatRunResults, chats } from './schema'
import type { ChatRunResult, ChatRunResultStatus } from '../../shared/chatRunResult'

export const chatRunResultRepo = {
  get(userId: string, chatId: string): ChatRunResult | null {
    return getDb().select({ runId: chatRunResults.runId, status: chatRunResults.status, unread: chatRunResults.unread })
      .from(chatRunResults).innerJoin(chats, eq(chats.id, chatRunResults.chatId))
      .where(and(eq(chats.userId, userId), eq(chatRunResults.chatId, chatId))).get() ?? null
  },
  record(chatId: string, runId: string, status: ChatRunResultStatus): void {
    const unread = status !== 'canceled'
    getDb().insert(chatRunResults).values({ chatId, runId, status, unread })
      .onConflictDoUpdate({ target: chatRunResults.chatId, set: { runId, status, unread } }).run()
  },
  /** One owner, or every owner a profile sees (`auth/chatScope.ts`). */
  list(owners: string | readonly string[]): Map<string, ChatRunResult> {
    const rows = getDb().select({ chatId: chatRunResults.chatId, runId: chatRunResults.runId,
      status: chatRunResults.status, unread: chatRunResults.unread })
      .from(chatRunResults).innerJoin(chats, eq(chats.id, chatRunResults.chatId))
      .where(typeof owners === 'string' ? eq(chats.userId, owners) : inArray(chats.userId, [...owners])).all()
    return new Map(rows.map(({ chatId, ...result }) => [chatId, result]))
  },
  /** The service verifies ownership; an old view cannot mark a newer result read. */
  markRead(chatId: string, runId: string): void {
    getDb().update(chatRunResults).set({ unread: false })
      .where(and(eq(chatRunResults.chatId, chatId), eq(chatRunResults.runId, runId))).run()
  }
}
