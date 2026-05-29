import { nanoid } from 'nanoid'
import { and, desc, eq, isNull, isNotNull } from 'drizzle-orm'
import { getDb } from './client'
import { chats, chatOnDemandAgents, messages } from './schema'
import type { MessageRow } from './messages'

export type ChatRow = typeof chats.$inferSelect
export type { MessageRow }

/** Fields editable via the `chat:update` IPC channel. */
export interface ChatMetaUpdate {
  title?: string
  modelId?: string
  providerId?: string
  modeId?: string | null
  /** Nullable so promotion to orchestrated can detach a chat's bound root agent. */
  agentId?: string | null
  /** Set at creation, or at in-chat promotion, for orchestrated (agents-as-MCP) chats. */
  orchestrated?: boolean
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
      orchestrated: false,
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

  /**
   * Atomically promote a chat to orchestrated mode. When `rootAgentId` is set
   * (agent-rooted chat) the former root is re-exposed as an on-demand tool and
   * detached in the same transaction as the flag flip, so a mid-sequence
   * failure can't leave the chat agent-rooted *and* carrying its own root in
   * the on-demand set. `providerId`/`modelId` are applied only when supplied
   * (resolved by the caller for agent-rooted chats that lacked a model).
   */
  promoteToOrchestrated(
    userId: string,
    chatId: string,
    opts: { rootAgentId: string | null; providerId?: string; modelId?: string }
  ): void {
    getDb().transaction((tx) => {
      if (opts.rootAgentId) {
        // Mirrors `chatOnDemandAgentRepo.add` — inlined so the insert shares
        // this transaction (repo methods use the non-transactional handle).
        tx.insert(chatOnDemandAgents)
          .values({ chatId, agentId: opts.rootAgentId, pendingAnnounce: true })
          .onConflictDoUpdate({
            target: [chatOnDemandAgents.chatId, chatOnDemandAgents.agentId],
            set: { pendingAnnounce: true }
          })
          .run()
      }
      const set: Partial<typeof chats.$inferInsert> = {
        orchestrated: true,
        updatedAt: new Date()
      }
      if (opts.rootAgentId) set.agentId = null
      if (opts.providerId) set.providerId = opts.providerId
      if (opts.modelId) set.modelId = opts.modelId
      tx.update(chats)
        .set(set)
        .where(and(eq(chats.id, chatId), eq(chats.userId, userId)))
        .run()
    })
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
