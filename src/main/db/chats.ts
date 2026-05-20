import { nanoid } from 'nanoid'
import { and, desc, eq, isNull, isNotNull } from 'drizzle-orm'
import { getDb } from './client'
import { chats, messages } from './schema'
import type { MessageRow } from './messages'

export type ChatRow = typeof chats.$inferSelect
export type { MessageRow }

/**
 * Fields freely editable via the `chat:update` IPC channel. Anything that
 * affects the multi-agent routing audit trail belongs in `ChatRoutingUpdate`
 * instead — it routes through dedicated `multiAgent:*` channels so logging
 * and (future) auditing stay consistent.
 */
export interface ChatMetaUpdate {
  title?: string
  modelId?: string
  providerId?: string
  modeId?: string | null
  agentId?: string
}

/** Routing fields — write only via `multiAgentService`, never via `chat:update`. */
export interface ChatRoutingUpdate {
  activeAgentId?: string | null
  smartAssistDisabled?: boolean
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
      .where(
        and(
          eq(chats.userId, userId),
          isNull(chats.deletedAt),
          eq(chats.hiddenFromList, false)
        )
      )
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

  create(
    userId: string,
    init?: {
      title?: string
      modelId?: string | null
      providerId?: string | null
      modeId?: string | null
      agentId?: string | null
      originatingJobRunId?: string | null
      hiddenFromList?: boolean
    }
  ): ChatRow {
    const now = new Date()
    const chat = {
      id: nanoid(),
      userId,
      title: init?.title ?? 'New Chat',
      modelId: init?.modelId ?? null,
      providerId: init?.providerId ?? null,
      modeId: init?.modeId ?? null,
      agentId: init?.agentId ?? null,
      activeAgentId: null,
      smartAssistDisabled: false,
      originatingJobRunId: init?.originatingJobRunId ?? null,
      hiddenFromList: init?.hiddenFromList ?? false,
      deletedAt: null,
      createdAt: now,
      updatedAt: now
    }
    getDb().insert(chats).values(chat).run()
    return chat
  },

  /** Promote a hidden (job-spawned) chat into the main chat list. */
  showInList(userId: string, chatId: string): boolean {
    const result = getDb()
      .update(chats)
      .set({ hiddenFromList: false, updatedAt: new Date() })
      .where(and(eq(chats.id, chatId), eq(chats.userId, userId)))
      .run()
    return result.changes > 0
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

  updateMeta(userId: string, chatId: string, updates: ChatMetaUpdate): boolean {
    const result = getDb()
      .update(chats)
      .set({ ...updates, updatedAt: new Date() })
      .where(and(eq(chats.id, chatId), eq(chats.userId, userId)))
      .run()
    return result.changes > 0
  },

  // Separate entry point so the type system enforces the IPC whitelist:
  // `chat:update` cannot reach this method, only `multiAgentService` can.
  updateRouting(userId: string, chatId: string, updates: ChatRoutingUpdate): boolean {
    const result = getDb()
      .update(chats)
      .set({ ...updates, updatedAt: new Date() })
      .where(and(eq(chats.id, chatId), eq(chats.userId, userId)))
      .run()
    return result.changes > 0
  },

  /**
   * Wire a chat to the job_runs row that spawned it — the streaming
   * completion hook reads this back to flip the run's status without
   * renderer cooperation. Called inside the same transaction as the
   * chat/run creation in `jobsRepo.createLocalChatAndRun`.
   */
  setOriginatingJobRunId(userId: string, chatId: string, runId: string | null): boolean {
    const result = getDb()
      .update(chats)
      .set({ originatingJobRunId: runId })
      .where(and(eq(chats.id, chatId), eq(chats.userId, userId)))
      .run()
    return result.changes > 0
  }
}
