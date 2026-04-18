import { nanoid } from 'nanoid'
import { eq, desc } from 'drizzle-orm'
import { getDb } from './client'
import { messages, chats } from './schema'
import type { MessagePart } from '../../shared/messageParts'

export type { MessagePart }

export interface SaveUserMessage {
  chatId: string
  content: string
}

export interface SaveAssistantMessage {
  chatId: string
  content: string
  toolCalls?: Array<{ id: string; name: string; input: Record<string, unknown> }> | null
  parts?: MessagePart[] | null
}

export interface SaveToolCallMessage {
  chatId: string
  content: string
  toolCallId: string
  toolName: string
  toolInput: Record<string, unknown>
  toolError: boolean
  toolProvider?: string
}

export interface SaveErrorMessage {
  chatId: string
  short: string
  detail?: string
}

export interface InsertRawMessage {
  id: string
  chatId: string
  role: string
  content: string
  toolCallId: string | null
  toolName: string | null
  toolInput: Record<string, unknown> | null
}

export type MessageRow = typeof messages.$inferSelect

function getNextSortOrder(chatId: string): number {
  const db = getDb()
  const last = db
    .select({ sortOrder: messages.sortOrder })
    .from(messages)
    .where(eq(messages.chatId, chatId))
    .orderBy(desc(messages.sortOrder))
    .limit(1)
    .get()
  return last ? last.sortOrder + 1 : 0
}

export const messageRepo = {
  saveUser(msg: SaveUserMessage): void {
    getDb()
      .insert(messages)
      .values({
        id: nanoid(),
        chatId: msg.chatId,
        role: 'user',
        content: msg.content,
        sortOrder: getNextSortOrder(msg.chatId),
        createdAt: new Date()
      })
      .run()
  },

  saveAssistant(msg: SaveAssistantMessage): void {
    getDb()
      .insert(messages)
      .values({
        id: nanoid(),
        chatId: msg.chatId,
        role: 'assistant',
        content: msg.content,
        toolCalls: msg.toolCalls ?? null,
        parts: msg.parts ?? null,
        sortOrder: getNextSortOrder(msg.chatId),
        createdAt: new Date()
      })
      .run()
  },

  saveToolCall(msg: SaveToolCallMessage): void {
    getDb()
      .insert(messages)
      .values({
        id: nanoid(),
        chatId: msg.chatId,
        role: 'tool_call',
        content: msg.content,
        toolCallId: msg.toolCallId,
        toolName: msg.toolName,
        toolInput: msg.toolInput,
        toolError: msg.toolError,
        toolProvider: msg.toolProvider ?? null,
        sortOrder: getNextSortOrder(msg.chatId),
        createdAt: new Date()
      })
      .run()
  },

  saveError(msg: SaveErrorMessage): void {
    getDb()
      .insert(messages)
      .values({
        id: nanoid(),
        chatId: msg.chatId,
        role: 'error',
        content: JSON.stringify({ short: msg.short, detail: msg.detail ?? msg.short }),
        sortOrder: getNextSortOrder(msg.chatId),
        createdAt: new Date()
      })
      .run()
  },

  touchChat(chatId: string): void {
    getDb()
      .update(chats)
      .set({ updatedAt: new Date() })
      .where(eq(chats.id, chatId))
      .run()
  },

  insertRaw(msg: InsertRawMessage): void {
    getDb()
      .insert(messages)
      .values({
        id: msg.id,
        chatId: msg.chatId,
        role: msg.role,
        content: msg.content,
        toolCallId: msg.toolCallId,
        toolName: msg.toolName,
        toolInput: msg.toolInput,
        sortOrder: getNextSortOrder(msg.chatId),
        createdAt: new Date()
      })
      .run()
  },

  getById(id: string): MessageRow | undefined {
    return getDb()
      .select()
      .from(messages)
      .where(eq(messages.id, id))
      .get()
  }
}
