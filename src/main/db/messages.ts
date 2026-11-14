import { redactingRepository } from '../security/serviceCredentialRedaction'
import { nanoid } from 'nanoid'
import { and, asc, eq, desc, inArray, isNotNull, lt, sql } from 'drizzle-orm'
import { getDb } from './client'
import { messages, chats } from './schema'
import { vaultReadRoute, vaultTurnRoute, vaultWriteRoute } from './chats'
import { vaultTranscripts, type ChatTranscript } from '../vault/transcriptStore'
import type { MessagePart } from '../../shared/messageParts'
import type { MessageAttachment } from '../../shared/attachments'
import type { MessageTelemetry } from '../../shared/sessionTelemetry'

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
  /** What the runtime reported the turn used; on the turn's last row only. */
  telemetry?: MessageTelemetry | null
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
  /** Headline for a provider error read out of the failure (see
   *  `shared/providerErrors`); `short` is then the provider's own message. */
  title?: string
  /** Seconds the provider asked to wait before retrying, shown as is. */
  retryAfterSec?: number
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

/** A whole `messages` row for a vault chat's transcript: every column the SQLite insert would default. */
function vaultRow(chat: ChatTranscript, values: Partial<MessageRow> & Pick<MessageRow, 'id' | 'role' | 'content'>): MessageRow {
  return {
    chatId: chat.chatId,
    toolCallId: null, toolName: null, toolInput: null, toolCalls: null, toolError: null, toolProvider: null,
    toolAgentId: null, parts: null, attachments: null, addressedAgentId: null, sourceAgentId: null, telemetry: null,
    sortOrder: chat.nextSortOrder(),
    createdAt: new Date(),
    ...values
  }
}

/**
 * Write a new row: to SQLite for an ordinary chat, to the vault's transcript
 * for a vault chat (throws while that vault is locked; never falls through).
 */
function insertMessage(values: Omit<MessageRow, 'sortOrder' | 'createdAt'> & Partial<Pick<MessageRow, 'createdAt'>>): void {
  const vault = vaultWriteRoute(values.chatId)
  if (vault) {
    vault.insert(vaultRow(vault, values))
    return
  }
  getDb().insert(messages).values({ ...values, sortOrder: getNextSortOrder(values.chatId), createdAt: values.createdAt ?? new Date() }).run()
}

/** Every nullable column null: the base of a row {@link insertMessage} writes. */
const NO_COLUMNS = {
  toolCallId: null, toolName: null, toolInput: null, toolCalls: null, toolError: null, toolProvider: null,
  toolAgentId: null, parts: null, attachments: null, addressedAgentId: null, sourceAgentId: null, telemetry: null
} as const

/** The rows of `chatId` a read helper filters, or null to query SQLite. */
function vaultRows(chatId: string, route: (chatId: string) => ReturnType<typeof vaultReadRoute> = vaultReadRoute): MessageRow[] | null {
  const vault = route(chatId)
  if (!vault) return null
  return vault === 'locked' ? [] : vault.list()
}

const rawMessageRepo = {
  saveSystem(msg: { chatId: string; content: string; addressedAgentId?: string }, onSaved?: () => void): string {
    return getDb().transaction(() => {
      const id = nanoid()
      insertMessage({ ...NO_COLUMNS, id, chatId: msg.chatId, role: 'system', content: msg.content,
        addressedAgentId: msg.addressedAgentId ?? null })
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
    insertMessage({
      ...NO_COLUMNS,
      id,
      chatId: msg.chatId,
      role: 'user',
      content: msg.content,
      addressedAgentId: msg.addressedAgentId ?? null,
      attachments: msg.attachments && msg.attachments.length > 0 ? msg.attachments : null
    })
    return id
  },

  saveAssistant(msg: SaveAssistantMessage): string {
    const id = nanoid()
    insertMessage({
      ...NO_COLUMNS,
      id,
      chatId: msg.chatId,
      role: 'assistant',
      content: msg.content,
      toolCalls: msg.toolCalls ?? null,
      parts: msg.parts ?? null,
      sourceAgentId: msg.sourceAgentId ?? null,
      telemetry: msg.telemetry ?? null
    })
    return id
  },

  /**
   * Rewrite an assistant row's text and parts in place, keeping its position.
   * Only the running turn's draft row is written this way.
   */
  updateAssistantParts(id: string, content: string, parts: MessagePart[]): void {
    const vault = vaultTranscripts.byMessageId(id)
    if (vault) {
      vault.update(id, { content, parts }, (row) => row.role === 'assistant')
      return
    }
    getDb().update(messages).set({ content, parts }).where(and(eq(messages.id, id), eq(messages.role, 'assistant'))).run()
  },

  /**
   * Put a turn's telemetry on an assistant row saved before it arrived (the
   * turn's last row, when its final pass had no parts left to write).
   */
  updateAssistantTelemetry(id: string, telemetry: MessageTelemetry): void {
    const vault = vaultTranscripts.byMessageId(id)
    if (vault) {
      vault.update(id, { telemetry }, (row) => row.role === 'assistant')
      return
    }
    getDb().update(messages).set({ telemetry }).where(and(eq(messages.id, id), eq(messages.role, 'assistant'))).run()
  },

  deleteById(id: string): void {
    const vault = vaultTranscripts.byMessageId(id)
    if (vault) {
      vault.delete(id)
      return
    }
    getDb().delete(messages).where(eq(messages.id, id)).run()
  },

  saveToolCall(msg: SaveToolCallMessage): void {
    insertMessage({
      ...NO_COLUMNS,
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
      parts: msg.parts ?? null
    })
  },

  saveTransition(msg: SaveTransitionMessage): string {
    const id = nanoid()
    insertMessage({
      ...NO_COLUMNS,
      id,
      chatId: msg.chatId,
      role: 'agent_transition',
      content: msg.content,
      sourceAgentId: msg.sourceAgentId ?? null
    })
    return id
  },

  saveError(msg: SaveErrorMessage): void {
    insertMessage({
      ...NO_COLUMNS,
      id: nanoid(),
      chatId: msg.chatId,
      role: 'error',
      content: JSON.stringify({
        short: msg.short,
        ...(msg.detail === null ? {} : { detail: msg.detail ?? msg.short }),
        ...(msg.code ? { code: msg.code } : {}),
        ...(msg.title ? { title: msg.title } : {}),
        ...(msg.retryAfterSec !== undefined ? { retryAfterSec: msg.retryAfterSec } : {})
      })
    })
  },

  touchChat(chatId: string): void {
    getDb()
      .update(chats)
      .set({ updatedAt: new Date() })
      .where(eq(chats.id, chatId))
      .run()
  },

  insertRaw(msg: InsertRawMessage): void {
    insertMessage({
      ...NO_COLUMNS,
      id: msg.id,
      chatId: msg.chatId,
      role: msg.role,
      content: msg.content,
      toolCallId: msg.toolCallId,
      toolName: msg.toolName,
      toolInput: msg.toolInput
    })
  },

  getById(id: string): MessageRow | undefined {
    const vault = vaultTranscripts.readableByMessageId(id)
    if (vault) return vault === 'locked' ? undefined : vault.get(id)
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
    const vault = vaultRows(chatId)
    if (vault) return vault.filter((row) => row.role === role).length
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
    const vault = vaultRows(chatId)
    if (vault) return vault.find((row) => row.role === role)
    return getDb()
      .select()
      .from(messages)
      .where(and(eq(messages.chatId, chatId), eq(messages.role, role)))
      .orderBy(asc(messages.sortOrder))
      .limit(1)
      .get()
  },

  /** The newest message of one role in a chat — the agent's last answer, for the adoption session's summary. */
  lastByRole(chatId: string, role: string): MessageRow | undefined {
    const vault = vaultRows(chatId)
    if (vault) return vault.findLast((row) => row.role === role)
    return getDb()
      .select()
      .from(messages)
      .where(and(eq(messages.chatId, chatId), eq(messages.role, role)))
      .orderBy(desc(messages.sortOrder))
      .limit(1)
      .get()
  },

  /** The id of the newest message in a chat — where an agent's catch-up cursor lands. */
  lastId(chatId: string): string | null {
    const vault = vaultRows(chatId, vaultTurnRoute)
    if (vault) return vault.at(-1)?.id ?? null
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
   * The id of the newest message that reached a chat from outside its agent — a `user` or `system`
   * row: a brief, a revision, a `tasks_reply` follow-up or the user typing — written before `at`
   * (ms). `created_at` holds whole seconds, so a row from the same second as `at` counts as after
   * it. The delegation bus compares this across two reports to tell a restatement from an answer
   * to new input, and that ambiguity resolves to "new input".
   */
  lastInboundIdBefore(chatId: string, at: number): string | null {
    const vault = vaultRows(chatId, vaultTurnRoute)
    if (vault) {
      const before = Math.floor(at / 1000) * 1000
      // `created_at` is whole seconds in SQLite; compared the same way here.
      return vault.findLast((row) => (row.role === 'user' || row.role === 'system') &&
        Math.floor(row.createdAt.getTime() / 1000) * 1000 < before)?.id ?? null
    }
    const row = getDb()
      .select({ id: messages.id })
      .from(messages)
      .where(
        and(
          eq(messages.chatId, chatId),
          inArray(messages.role, ['user', 'system']),
          lt(messages.createdAt, new Date(Math.floor(at / 1000) * 1000))
        )
      )
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
    const vault = vaultRows(chatId, vaultTurnRoute)
    if (vault) return vault.findLast((row) => row.role === 'user' && row.addressedAgentId !== null)?.addressedAgentId ?? null
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

export const messageRepo = redactingRepository(rawMessageRepo, ['saveSystem', 'saveUser', 'saveAssistant', 'updateAssistantParts', 'updateAssistantTelemetry', 'saveToolCall', 'saveTransition', 'saveError', 'insertRaw'])
