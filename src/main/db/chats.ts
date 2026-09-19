import { nanoid } from 'nanoid'
import { and, asc, desc, eq, isNull, isNotNull, max, min, or, sql } from 'drizzle-orm'
import { getDb } from './client'
import { chats, chatOnDemandAgents, messages } from './schema'
import type { MessageRow } from './messages'
import type { ChatRouter } from '../../shared/chatRouting'

export type ChatRow = typeof chats.$inferSelect
export type { MessageRow }

/** Fields editable via the `chat:update` IPC channel. */
export interface ChatMetaUpdate {
  title?: string
  modelId?: string | null
  providerId?: string | null
  modeId?: string | null
  /** Nullable so a switch to `coordinator` can detach a chat's bound root agent. */
  agentId?: string | null
  /**
   * Who answers in this chat. Written through {@link chatRepo.setRouter} rather
   * than here wherever the caller only means to change the router; accepted here because
   * `chat:update` is one channel and a new chat sets several fields at once.
   */
  router?: ChatRouter
}

/** The chats `chatRepo.list` returns, as a condition other tables can join on. */
const listedChats = (userId: string) =>
  and(eq(chats.userId, userId), isNull(chats.deletedAt), eq(chats.hiddenFromList, false))

export interface ChatMessageStats {
  chatId: string
  /** Over every row of the chat, so a session ending in tool work lasts until it. */
  firstAt: Date | null
  lastAt: Date | null
  /** `user` and `assistant` rows only. */
  messageCount: number
}

export const chatRepo = {
  getOwned(userId: string, chatId: string): ChatRow | undefined {
    return getDb()
      .select()
      .from(chats)
      .where(and(eq(chats.id, chatId), eq(chats.userId, userId)))
      .get()
  },

  /**
   * Whether the chat, whichever profile owns it, is in the trash. For
   * main-process housekeeping that must not depend on the active profile;
   * never an answer to the renderer.
   */
  isTrashed(chatId: string): boolean {
    const row = getDb()
      .select({ deletedAt: chats.deletedAt })
      .from(chats)
      .where(eq(chats.id, chatId))
      .get()
    return !!row?.deletedAt
  },

  /** Load the full message history for an owned chat (caller must pre-verify ownership). */
  listMessageIds(chatId: string): string[] {
    return getDb().select({ id: messages.id }).from(messages).where(eq(messages.chatId, chatId)).all().map((row) => row.id)
  },

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

  /**
   * The three reads behind the sidebar's per-chat summary. Each covers every
   * listed chat of the user in one statement (joined on the list's own
   * condition, so there is no id list to outgrow SQLite's variable limit);
   * none of them runs per chat. `idx_messages_chat_id` only finds the row ids:
   * every message row of every listed chat is still read, so the cost grows
   * with the messages table. Never call these from a polled path.
   */
  listMessageStats(userId: string): ChatMessageStats[] {
    return getDb()
      .select({
        chatId: messages.chatId,
        firstAt: min(messages.createdAt),
        lastAt: max(messages.createdAt),
        messageCount: sql<number>`sum(case when ${messages.role} in ('user', 'assistant') then 1 else 0 end)`.mapWith(Number)
      })
      .from(messages)
      .innerJoin(chats, eq(chats.id, messages.chatId))
      .where(listedChats(userId))
      .groupBy(messages.chatId)
      .all()
  },

  /** Distinct agents named on a chat's messages, in order of first appearance. */
  listMessageAgentIds(userId: string): { chatId: string; sourceAgentId: string | null; toolAgentId: string | null }[] {
    return getDb()
      .select({ chatId: messages.chatId, sourceAgentId: messages.sourceAgentId, toolAgentId: messages.toolAgentId })
      .from(messages)
      .innerJoin(chats, eq(chats.id, messages.chatId))
      .where(and(listedChats(userId), or(isNotNull(messages.sourceAgentId), isNotNull(messages.toolAgentId))))
      .groupBy(messages.chatId, messages.sourceAgentId, messages.toolAgentId)
      .orderBy(asc(min(messages.sortOrder)))
      .all()
  },

  /** On-demand agents of every listed chat, in the order they were attached. */
  listOnDemandAgentIds(userId: string): { chatId: string; agentId: string }[] {
    return getDb()
      .select({ chatId: chatOnDemandAgents.chatId, agentId: chatOnDemandAgents.agentId })
      .from(chatOnDemandAgents)
      .innerJoin(chats, eq(chats.id, chatOnDemandAgents.chatId))
      .where(listedChats(userId))
      .orderBy(asc(chatOnDemandAgents.createdAt), asc(chatOnDemandAgents.agentId))
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
      router?: ChatRouter
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
      router: init?.router ?? 'direct',
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
   * Atomically move a chat onto a router, carrying its one agent across the
   * boundary between "the root" and "one of the attached".
   *
   * `detachRoot` (an agent-rooted chat leaving `direct`) re-exposes the former
   * root as an on-demand agent and clears `agent_id`; `bindRoot` (a chat
   * arriving at `direct` with a single attached agent) does the reverse. Either
   * happens in the same transaction as the router write, so a mid-sequence
   * failure can't leave the chat agent-rooted *and* carrying its own root in
   * the on-demand set — or, the other way, rooted on an agent it has also
   * forgotten. `providerId`/`modelId` are applied only when supplied (resolved
   * by the caller for a chat that lacked a model and is moving to
   * `coordinator`).
   *
   * The agent's `a2a_sessions` row is never touched by any of it: switching
   * routers must not cost an agent the context it has built up in this chat.
   */
  setRouter(
    userId: string,
    chatId: string,
    router: ChatRouter,
    opts: {
      detachRoot?: string | null
      bindRoot?: string | null
      providerId?: string
      modelId?: string
    } = {}
  ): void {
    getDb().transaction((tx) => {
      if (opts.detachRoot) {
        // Mirrors `chatOnDemandAgentRepo.add` — inlined so the insert shares
        // this transaction (repo methods use the non-transactional handle).
        tx.insert(chatOnDemandAgents)
          .values({ chatId, agentId: opts.detachRoot, pendingAnnounce: true })
          .onConflictDoUpdate({
            target: [chatOnDemandAgents.chatId, chatOnDemandAgents.agentId],
            set: { pendingAnnounce: true }
          })
          .run()
      }
      if (opts.bindRoot) {
        tx.delete(chatOnDemandAgents)
          .where(
            and(
              eq(chatOnDemandAgents.chatId, chatId),
              eq(chatOnDemandAgents.agentId, opts.bindRoot)
            )
          )
          .run()
      }
      const set: Partial<typeof chats.$inferInsert> = {
        router,
        updatedAt: new Date()
      }
      if (opts.detachRoot) set.agentId = null
      if (opts.bindRoot) set.agentId = opts.bindRoot
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
