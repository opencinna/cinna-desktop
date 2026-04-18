import { eq } from 'drizzle-orm'
import { getDb } from './client'
import { chatMcpProviders } from './schema'

export type ChatMcpRow = typeof chatMcpProviders.$inferSelect

export const chatMcpRepo = {
  list(chatId: string): ChatMcpRow[] {
    return getDb()
      .select()
      .from(chatMcpProviders)
      .where(eq(chatMcpProviders.chatId, chatId))
      .all()
  },

  listProviderIds(chatId: string): string[] {
    return getDb()
      .select({ id: chatMcpProviders.mcpProviderId })
      .from(chatMcpProviders)
      .where(eq(chatMcpProviders.chatId, chatId))
      .all()
      .map((r) => r.id)
  },

  /** Atomically replace the MCP provider links for a chat. */
  replaceForChat(chatId: string, mcpProviderIds: string[]): void {
    const db = getDb()
    db.transaction((tx) => {
      tx.delete(chatMcpProviders).where(eq(chatMcpProviders.chatId, chatId)).run()
      for (const mcpProviderId of mcpProviderIds) {
        tx.insert(chatMcpProviders).values({ chatId, mcpProviderId }).run()
      }
    })
  }
}
