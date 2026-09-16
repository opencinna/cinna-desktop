import { nanoid } from 'nanoid'
import { and, asc, eq, desc, isNotNull, sql } from 'drizzle-orm'
import { getDb } from './client'
import { messages, chats } from './schema'
import type { MessagePart } from '../../shared/messageParts'
import type { MessageAttachment } from '../../shared/attachments'

export type { MessagePart }

export interface SaveUserMessage {
  chatId: string
  content: string
  /** Agent a user turn was routed to in a direct-A2A chat (null for LLM root). */
  addressedAgentId?: string | null
  /** File attachments shipped with this user turn (Cinna agents only). */
  attachments?: MessageAttachment[] | null
}

export interface SaveAssistantMessage {
  chatId: string
  content: string
  toolCalls?: Array<{ id: string; name: string; input: Record<string, unknown> }> | null
  parts?: MessagePart[] | null
  /** Multi-agent: agent that produced this assistant turn (null for LLM root). */
  sourceAgentId?: string | null
}

export interface SaveToolCallMessage {
  chatId: string
  content: string
  toolCallId: string
  toolName: string
  toolInput: Record<string, unknown>
  toolError: boolean
  toolProvider?: string
  /** Agent id backing an agent tool call — drives the sub-thread hash color. */
  toolAgentId?: string | null
  /**
   * Full-fidelity agent sub-thread parts for agent-backed tool calls
   * (orchestrated mode). Persisted on the same `parts` column assistant
   * messages use, so the renderer can replay the nested sub-thread. Null for
   * ordinary MCP tool calls.
   */
  parts?: MessagePart[] | null
}

export interface SaveErrorMessage {
  chatId: string
  short: string
  /** Shown behind a Details toggle; `short` when omitted, none when null. */
  detail?: string | null
  /** Machine-readable error code (e.g. `'cinna_reauth_required'`) persisted
   *  in the row's JSON payload so renderer surfaces can branch type-safely
   *  instead of substring-matching the user-facing `short` string. */
  code?: string
}

export interface SaveTransitionMessage {
  chatId: string
  content: string
  /** The agent that emitted the transition. */
  sourceAgentId?: string | null
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
  saveSystem(msg: { chatId: string; content: string; addressedAgentId?: string }, onSaved?: () => void): string {
    return getDb().transaction(() => {
      const id = nanoid()
      getDb().insert(messages).values({ id, chatId: msg.chatId, role: 'system', content: msg.content,
        addressedAgentId: msg.addressedAgentId ?? null, sortOrder: getNextSortOrder(msg.chatId), createdAt: new Date() }).run()
      onSaved?.()
      return id
    })
  },
  saveUser(msg: SaveUserMessage, onSaved?: () => void): string {
    if (onSaved) {
      return getDb().transaction(() => {
        const id = this.saveUser(msg)
        onSaved()
        return id
      })
    }
    const id = nanoid()
    getDb()
      .insert(messages)
      .values({
        id,
        chatId: msg.chatId,
        role: 'user',
        content: msg.content,
        addressedAgentId: msg.addressedAgentId ?? null,
        attachments: msg.attachments && msg.attachments.length > 0 ? msg.attachments : null,
        sortOrder: getNextSortOrder(msg.chatId),
        createdAt: new Date()
      })
      .run()
    return id
  },

  saveAssistant(msg: SaveAssistantMessage): string {
    const id = nanoid()
    getDb()
      .insert(messages)
      .values({
        id,
        chatId: msg.chatId,
        role: 'assistant',
        content: msg.content,
        toolCalls: msg.toolCalls ?? null,
        parts: msg.parts ?? null,
        sourceAgentId: msg.sourceAgentId ?? null,
        sortOrder: getNextSortOrder(msg.chatId),
        createdAt: new Date()
      })
      .run()
    return id
  },

  /**
   * Rewrite an assistant row's text and parts in place, keeping its position.
   * Only the running turn's draft row is written this way.
   */
  updateAssistantParts(id: string, content: string, parts: MessagePart[]): void {
    getDb().update(messages).set({ content, parts }).where(and(eq(messages.id, id), eq(messages.role, 'assistant'))).run()
  },

  deleteById(id: string): void {
    getDb().delete(messages).where(eq(messages.id, id)).run()
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
        toolAgentId: msg.toolAgentId ?? null,
        parts: msg.parts ?? null,
        sortOrder: getNextSortOrder(msg.chatId),
        createdAt: new Date()
      })
      .run()
  },

  saveTransition(msg: SaveTransitionMessage): string {
    const id = nanoid()
    getDb()
      .insert(messages)
      .values({
        id,
        chatId: msg.chatId,
        role: 'agent_transition',
        content: msg.content,
        sourceAgentId: msg.sourceAgentId ?? null,
        sortOrder: getNextSortOrder(msg.chatId),
        createdAt: new Date()
      })
      .run()
    return id
  },

  saveError(msg: SaveErrorMessage): void {
    getDb()
      .insert(messages)
      .values({
        id: nanoid(),
        chatId: msg.chatId,
        role: 'error',
        content: JSON.stringify({
          short: msg.short,
          ...(msg.detail === null ? {} : { detail: msg.detail ?? msg.short }),
          ...(msg.code ? { code: msg.code } : {})
        }),
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
  },

  /**
   * COUNT-only check — avoids loading row payloads when callers only need
   * to know how many messages of a given role exist in a chat. Used by
   * `chatTitleService` to early-out without scanning the full history.
   */
  countByRole(chatId: string, role: string): number {
    const row = getDb()
      .select({ cnt: sql<number>`count(*)` })
      .from(messages)
      .where(and(eq(messages.chatId, chatId), eq(messages.role, role)))
      .get()
    return row?.cnt ?? 0
  },

  /**
   * Fetch the earliest message of a given role in a chat (by insertion
   * order). Targeted alternative to filtering the full `listMessages`
   * result when the caller only needs the first hit.
   */
  firstByRole(chatId: string, role: string): MessageRow | undefined {
    return getDb()
      .select()
      .from(messages)
      .where(and(eq(messages.chatId, chatId), eq(messages.role, role)))
      .orderBy(asc(messages.sortOrder))
      .limit(1)
      .get()
  },

  /** The id of the newest message in a chat — where an agent's catch-up cursor lands. */
  lastId(chatId: string): string | null {
    const row = getDb()
      .select({ id: messages.id })
      .from(messages)
      .where(eq(messages.chatId, chatId))
      .orderBy(desc(messages.sortOrder))
      .limit(1)
      .get()
    return row?.id ?? null
  },

  /**
   * The agent the most recent user message addressed, or null.
   *
   * The sticky default in a `human`-routed chat: a message that names nobody
   * goes to whoever the user was last talking to. Read from the messages rather
   * than kept on the chat row, because the transcript is already the record and
   * a second copy of it could disagree with what the user can see.
   */
  lastAddressedAgentId(chatId: string): string | null {
    const row = getDb()
      .select({ agentId: messages.addressedAgentId })
      .from(messages)
      .where(
        and(
          eq(messages.chatId, chatId),
          eq(messages.role, 'user'),
          isNotNull(messages.addressedAgentId)
        )
      )
      .orderBy(desc(messages.sortOrder))
      .limit(1)
      .get()
    return row?.agentId ?? null
  }
}
