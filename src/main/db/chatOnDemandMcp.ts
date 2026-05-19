import { and, eq, inArray } from 'drizzle-orm'
import { getDb } from './client'
import { chatOnDemandMcps } from './schema'

export type ChatOnDemandMcpRow = typeof chatOnDemandMcps.$inferSelect

export const chatOnDemandMcpRepo = {
  list(chatId: string): ChatOnDemandMcpRow[] {
    return getDb()
      .select()
      .from(chatOnDemandMcps)
      .where(eq(chatOnDemandMcps.chatId, chatId))
      .all()
  },

  listProviderIds(chatId: string): string[] {
    return this.list(chatId).map((r) => r.mcpProviderId)
  },

  /** Insert if missing; re-arming `pendingAnnounce` if the user re-adds an MCP. */
  add(chatId: string, mcpProviderId: string): void {
    const db = getDb()
    db.insert(chatOnDemandMcps)
      .values({ chatId, mcpProviderId, pendingAnnounce: true })
      .onConflictDoUpdate({
        target: [chatOnDemandMcps.chatId, chatOnDemandMcps.mcpProviderId],
        set: { pendingAnnounce: true }
      })
      .run()
  },

  remove(chatId: string, mcpProviderId: string): void {
    getDb()
      .delete(chatOnDemandMcps)
      .where(
        and(
          eq(chatOnDemandMcps.chatId, chatId),
          eq(chatOnDemandMcps.mcpProviderId, mcpProviderId)
        )
      )
      .run()
  },

  /** Read the rows that still owe an announcement, without mutating. */
  peekPending(chatId: string): string[] {
    return getDb()
      .select({ id: chatOnDemandMcps.mcpProviderId })
      .from(chatOnDemandMcps)
      .where(
        and(
          eq(chatOnDemandMcps.chatId, chatId),
          eq(chatOnDemandMcps.pendingAnnounce, true)
        )
      )
      .all()
      .map((r) => r.id)
  },

  /**
   * Flip `pendingAnnounce` off for the supplied provider ids. Called by the
   * stream loop only after the LLM has actually consumed the prefix, so a
   * pre-flight failure (auth error, network down) does not silently burn the
   * one-shot announcement.
   */
  clearPending(chatId: string, mcpProviderIds: string[]): void {
    if (mcpProviderIds.length === 0) return
    getDb()
      .update(chatOnDemandMcps)
      .set({ pendingAnnounce: false })
      .where(
        and(
          eq(chatOnDemandMcps.chatId, chatId),
          inArray(chatOnDemandMcps.mcpProviderId, mcpProviderIds)
        )
      )
      .run()
  }
}
