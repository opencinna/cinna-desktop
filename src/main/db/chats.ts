import { nanoid } from 'nanoid'
import { and, desc, eq, isNull, isNotNull } from 'drizzle-orm'
import { getDb } from './client'
import { chats, messages } from './schema'
import type { MessageRow } from './messages'

export type ChatRow = typeof chats.$inferSelect
export type { MessageRow }

export interface ChatUpdateInput {
  title?: string
  modelId?: string
  providerId?: string
  modeId?: string | null
  agentId?: string
}

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
  },

  list(userId: string): ChatRow[] {
    return getDb()
      .select()
      .from(chats)
      .where(and(eq(chats.userId, userId), isNull(chats.deletedAt)))
      .orderBy(desc(chats.updatedAt))
      .all()
  },

  listTrash(userId: string): ChatRow[] {
    return getDb()
      .select()
      .from(chats)
      .where(and(eq(chats.userId, userId), isNotNull(chats.deletedAt)))
      .orderBy(desc(chats.deletedAt))
      .all()
  },

  create(userId: string): ChatRow {
    const now = new Date()
    const chat = {
      id: nanoid(),
      userId,
      title: 'New Chat',
      modelId: null,
      providerId: null,
      modeId: null,
      agentId: null,
      deletedAt: null,
      createdAt: now,
      updatedAt: now
    }
    getDb().insert(chats).values(chat).run()
    return chat
  },

  softDelete(userId: string, chatId: string): boolean {
    const result = getDb()
      .update(chats)
      .set({ deletedAt: new Date() })
      .where(and(eq(chats.id, chatId), eq(chats.userId, userId)))
      .run()
    return result.changes > 0
  },

  restore(userId: string, chatId: string): boolean {
    const result = getDb()
      .update(chats)
      .set({ deletedAt: null })
      .where(and(eq(chats.id, chatId), eq(chats.userId, userId)))
      .run()
    return result.changes > 0
  },

  permanentDelete(userId: string, chatId: string): boolean {
    const result = getDb()
      .delete(chats)
      .where(and(eq(chats.id, chatId), eq(chats.userId, userId)))
      .run()
    return result.changes > 0
  },

  emptyTrash(userId: string): number {
    const result = getDb()
      .delete(chats)
      .where(and(eq(chats.userId, userId), isNotNull(chats.deletedAt)))
      .run()
    return result.changes
  },

  update(userId: string, chatId: string, updates: ChatUpdateInput): boolean {
    const result = getDb()
      .update(chats)
      .set({ ...updates, updatedAt: new Date() })
      .where(and(eq(chats.id, chatId), eq(chats.userId, userId)))
      .run()
    return result.changes > 0
  }
}
