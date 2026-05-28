import { and, eq, inArray } from 'drizzle-orm'
import { getDb } from './client'
import { chatOnDemandAgents } from './schema'

export type ChatOnDemandAgentRow = typeof chatOnDemandAgents.$inferSelect

/**
 * On-demand agent attachments for a chat — agents the user `@-mentions` into
 * a chat so the orchestrator can call them as emulated MCP tools. Mirrors
 * {@link chatOnDemandMcpRepo} exactly.
 */
export const chatOnDemandAgentRepo = {
  list(chatId: string): ChatOnDemandAgentRow[] {
    return getDb()
      .select()
      .from(chatOnDemandAgents)
      .where(eq(chatOnDemandAgents.chatId, chatId))
      .all()
  },

  listAgentIds(chatId: string): string[] {
    return this.list(chatId).map((r) => r.agentId)
  },

  /** Insert if missing; re-arming `pendingAnnounce` if the user re-adds an agent. */
  add(chatId: string, agentId: string): void {
    const db = getDb()
    db.insert(chatOnDemandAgents)
      .values({ chatId, agentId, pendingAnnounce: true })
      .onConflictDoUpdate({
        target: [chatOnDemandAgents.chatId, chatOnDemandAgents.agentId],
        set: { pendingAnnounce: true }
      })
      .run()
  },

  remove(chatId: string, agentId: string): void {
    getDb()
      .delete(chatOnDemandAgents)
      .where(
        and(
          eq(chatOnDemandAgents.chatId, chatId),
          eq(chatOnDemandAgents.agentId, agentId)
        )
      )
      .run()
  },

  /** Read the rows that still owe an announcement, without mutating. */
  peekPending(chatId: string): string[] {
    return getDb()
      .select({ id: chatOnDemandAgents.agentId })
      .from(chatOnDemandAgents)
      .where(
        and(
          eq(chatOnDemandAgents.chatId, chatId),
          eq(chatOnDemandAgents.pendingAnnounce, true)
        )
      )
      .all()
      .map((r) => r.id)
  },

  /**
   * Flip `pendingAnnounce` off for the supplied agent ids. Called by the
   * stream loop only after the LLM has actually consumed the prefix, so a
   * pre-flight failure does not silently burn the one-shot announcement.
   */
  clearPending(chatId: string, agentIds: string[]): void {
    if (agentIds.length === 0) return
    getDb()
      .update(chatOnDemandAgents)
      .set({ pendingAnnounce: false })
      .where(
        and(
          eq(chatOnDemandAgents.chatId, chatId),
          inArray(chatOnDemandAgents.agentId, agentIds)
        )
      )
      .run()
  }
}
