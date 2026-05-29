import { nanoid } from 'nanoid'
import { and, asc, desc, eq, inArray, isNull, sql } from 'drizzle-orm'
import { getDb } from './client'
import {
  jobs,
  jobFolders,
  jobMcpProviders,
  jobRuns,
  chats,
  chatMcpProviders
} from './schema'

export type JobRow = typeof jobs.$inferSelect
export type JobFolderRow = typeof jobFolders.$inferSelect
export type JobMcpRow = typeof jobMcpProviders.$inferSelect
export type JobRunRow = typeof jobRuns.$inferSelect

export type JobType = 'local' | 'cinna_task'
export type JobRunStatus = 'pending' | 'running' | 'succeeded' | 'failed' | 'cancelled'

export interface JobCreateInput {
  type: JobType
  title: string
  description?: string | null
  prompt: string
  agentId?: string | null
  modeId?: string | null
  cinnaAgentId?: string | null
  cinnaPriority?: string | null
  colorPreset?: string | null
  iconName?: string | null
}

export interface JobPatch {
  type?: JobType
  title?: string
  description?: string | null
  prompt?: string
  agentId?: string | null
  modeId?: string | null
  cinnaAgentId?: string | null
  cinnaPriority?: string | null
  colorPreset?: string | null
  iconName?: string | null
}

export interface JobRunCreateInput {
  jobId: string
  userId: string
  type: JobType
  localChatId?: string | null
  cinnaTaskId?: string | null
  cinnaShortCode?: string | null
  status?: JobRunStatus
}

export const jobsRepo = {
  list(userId: string): JobRow[] {
    // Order: position ASC within each folder; ties (and legacy rows with
    // identical 0 positions) fall back to updatedAt DESC so the list keeps a
    // sensible default before the user ever drags anything.
    return getDb()
      .select()
      .from(jobs)
      .where(and(eq(jobs.userId, userId), isNull(jobs.deletedAt)))
      .orderBy(asc(jobs.position), desc(jobs.updatedAt))
      .all()
  },

  getById(userId: string, jobId: string): JobRow | undefined {
    return getDb()
      .select()
      .from(jobs)
      .where(and(eq(jobs.id, jobId), eq(jobs.userId, userId)))
      .get()
  },

  /**
   * Smallest existing `position` value across the user's jobs in the given
   * folder (null = root). Used so new jobs are inserted at the top of their
   * group with position = min - 1.
   */
  minPositionInFolder(userId: string, folderId: string | null): number | null {
    const cond = folderId === null
      ? and(eq(jobs.userId, userId), isNull(jobs.folderId), isNull(jobs.deletedAt))
      : and(eq(jobs.userId, userId), eq(jobs.folderId, folderId), isNull(jobs.deletedAt))
    const row = getDb()
      .select({ minPos: sql<number | null>`min(${jobs.position})` })
      .from(jobs)
      .where(cond)
      .get()
    return row?.minPos ?? null
  },

  create(userId: string, input: JobCreateInput): JobRow {
    const now = new Date()
    // Place the new job at the top of the root group — the only group jobs
    // are created into today; folder assignment happens later via drag-drop.
    const min = this.minPositionInFolder(userId, null)
    const position = min !== null ? min - 1 : 0
    const row = {
      id: nanoid(),
      userId,
      type: input.type,
      title: input.title,
      description: input.description ?? null,
      prompt: input.prompt,
      agentId: input.agentId ?? null,
      modeId: input.modeId ?? null,
      cinnaAgentId: input.cinnaAgentId ?? null,
      cinnaPriority: input.cinnaPriority ?? null,
      colorPreset: input.colorPreset ?? null,
      iconName: input.iconName ?? null,
      folderId: null,
      position,
      deletedAt: null,
      createdAt: now,
      updatedAt: now
    }
    getDb().insert(jobs).values(row).run()
    return row
  },

  update(userId: string, jobId: string, patch: JobPatch): boolean {
    const result = getDb()
      .update(jobs)
      .set({ ...patch, updatedAt: new Date() })
      .where(and(eq(jobs.id, jobId), eq(jobs.userId, userId)))
      .run()
    return result.changes > 0
  },

  touch(userId: string, jobId: string): void {
    getDb()
      .update(jobs)
      .set({ updatedAt: new Date() })
      .where(and(eq(jobs.id, jobId), eq(jobs.userId, userId)))
      .run()
  },

  softDelete(userId: string, jobId: string): boolean {
    const result = getDb()
      .update(jobs)
      .set({ deletedAt: new Date() })
      .where(and(eq(jobs.id, jobId), eq(jobs.userId, userId)))
      .run()
    return result.changes > 0
  },

  /**
   * Count how many of the given job ids belong to the user and are live
   * (not soft-deleted). Used as a single-query ownership check before a
   * reorder, replacing what would otherwise be an N+1 loop in the service.
   */
  countOwned(userId: string, ids: string[]): number {
    if (ids.length === 0) return 0
    const row = getDb()
      .select({ n: sql<number>`count(*)` })
      .from(jobs)
      .where(
        and(
          eq(jobs.userId, userId),
          isNull(jobs.deletedAt),
          inArray(jobs.id, ids)
        )
      )
      .get()
    return row?.n ?? 0
  },

  /**
   * Move + reorder jobs inside a single target group (folder or root). The
   * caller passes the full ordered list of job ids for that group — every id
   * in the list is written with `folderId = targetFolderId` and a fresh
   * `position` reflecting its index. Other groups are untouched.
   *
   * Drag-drop on the client constructs the new ordering of the destination
   * group and hands it in. Anything not in `orderedJobIds` keeps its prior
   * `folderId` / `position`.
   */
  reorderInGroup(
    userId: string,
    targetFolderId: string | null,
    orderedJobIds: string[]
  ): void {
    const db = getDb()
    db.transaction((tx) => {
      orderedJobIds.forEach((id, idx) => {
        tx.update(jobs)
          .set({ folderId: targetFolderId, position: idx })
          .where(and(eq(jobs.id, id), eq(jobs.userId, userId)))
          .run()
      })
    })
  }
}

export interface JobFolderCreateInput {
  name: string
}

export interface JobFolderPatch {
  name?: string
  collapsed?: boolean
}

export const jobFoldersRepo = {
  list(userId: string): JobFolderRow[] {
    return getDb()
      .select()
      .from(jobFolders)
      .where(eq(jobFolders.userId, userId))
      .orderBy(asc(jobFolders.position), asc(jobFolders.createdAt))
      .all()
  },

  getById(userId: string, folderId: string): JobFolderRow | undefined {
    return getDb()
      .select()
      .from(jobFolders)
      .where(and(eq(jobFolders.id, folderId), eq(jobFolders.userId, userId)))
      .get()
  },

  maxPosition(userId: string): number | null {
    const row = getDb()
      .select({ maxPos: sql<number | null>`max(${jobFolders.position})` })
      .from(jobFolders)
      .where(eq(jobFolders.userId, userId))
      .get()
    return row?.maxPos ?? null
  },

  create(userId: string, input: JobFolderCreateInput): JobFolderRow {
    // New folders go to the bottom of the folder list. They sit above the
    // root jobs visually but, since folders and root-level jobs are rendered
    // in two separate sections, "bottom of folder list" is what feels right
    // for a brand-new container.
    const max = this.maxPosition(userId)
    const position = max !== null ? max + 1 : 0
    const now = new Date()
    const row = {
      id: nanoid(),
      userId,
      name: input.name,
      position,
      collapsed: false,
      createdAt: now,
      updatedAt: now
    }
    getDb().insert(jobFolders).values(row).run()
    return row
  },

  update(userId: string, folderId: string, patch: JobFolderPatch): boolean {
    const result = getDb()
      .update(jobFolders)
      .set({ ...patch, updatedAt: new Date() })
      .where(and(eq(jobFolders.id, folderId), eq(jobFolders.userId, userId)))
      .run()
    return result.changes > 0
  },

  /**
   * Delete a folder. Any jobs inside are detached back to the root group
   * (folderId set to null) in the same transaction so deleting a folder never
   * loses jobs. We don't reorder positions on the orphaned jobs — they keep
   * their previous order; the user can re-tidy if they want.
   */
  delete(userId: string, folderId: string): boolean {
    return getDb().transaction((tx) => {
      tx.update(jobs)
        .set({ folderId: null })
        .where(and(eq(jobs.userId, userId), eq(jobs.folderId, folderId)))
        .run()
      const result = tx
        .delete(jobFolders)
        .where(and(eq(jobFolders.id, folderId), eq(jobFolders.userId, userId)))
        .run()
      return result.changes > 0
    })
  },

  /**
   * Single-query ownership check for a batch of folder ids. Mirrors
   * `jobsRepo.countOwned`.
   */
  countOwned(userId: string, ids: string[]): number {
    if (ids.length === 0) return 0
    const row = getDb()
      .select({ n: sql<number>`count(*)` })
      .from(jobFolders)
      .where(and(eq(jobFolders.userId, userId), inArray(jobFolders.id, ids)))
      .get()
    return row?.n ?? 0
  },

  /**
   * Reorder folders. `orderedIds` is the full new order top-to-bottom; rows
   * not in the list are left alone (they keep their old position).
   */
  reorder(userId: string, orderedIds: string[]): void {
    const db = getDb()
    db.transaction((tx) => {
      orderedIds.forEach((id, idx) => {
        tx.update(jobFolders)
          .set({ position: idx, updatedAt: new Date() })
          .where(and(eq(jobFolders.id, id), eq(jobFolders.userId, userId)))
          .run()
      })
    })
  }
}

export const jobMcpRepo = {
  listProviderIds(jobId: string): string[] {
    return getDb()
      .select({ id: jobMcpProviders.mcpProviderId })
      .from(jobMcpProviders)
      .where(eq(jobMcpProviders.jobId, jobId))
      .all()
      .map((r) => r.id)
  },

  setProviderIds(jobId: string, ids: string[]): void {
    const db = getDb()
    db.transaction((tx) => {
      tx.delete(jobMcpProviders).where(eq(jobMcpProviders.jobId, jobId)).run()
      for (const mcpProviderId of ids) {
        tx.insert(jobMcpProviders).values({ jobId, mcpProviderId }).run()
      }
    })
  }
}

export type JobRunRowWithMeta = JobRunRow & {
  /**
   * True when this is a local run whose chat is still around but currently
   * hidden from the main Chats list (i.e. not yet promoted via "Move to
   * Chats"). False for visible chats, deleted chats (`localChatId` is null),
   * and cinna_task runs.
   */
  chatHidden: boolean
}

export const jobRunsRepo = {
  /**
   * Count non-terminal runs (`pending` + `running`) per job for the active
   * profile. Powers the sidebar's "is this job currently running?" indicator
   * — one grouped SQL call instead of N per-job queries.
   */
  countInProgressByJob(userId: string): Map<string, number> {
    const rows = getDb()
      .select({
        jobId: jobRuns.jobId,
        count: sql<number>`count(*)`.as('count')
      })
      .from(jobRuns)
      .where(
        and(
          eq(jobRuns.userId, userId),
          inArray(jobRuns.status, ['pending', 'running'])
        )
      )
      .groupBy(jobRuns.jobId)
      .all()
    return new Map(rows.map((r) => [r.jobId, Number(r.count)]))
  },

  listByJob(userId: string, jobId: string): JobRunRowWithMeta[] {
    const rows = getDb()
      .select({ run: jobRuns, chatHidden: chats.hiddenFromList })
      .from(jobRuns)
      .leftJoin(chats, eq(chats.id, jobRuns.localChatId))
      .where(and(eq(jobRuns.jobId, jobId), eq(jobRuns.userId, userId)))
      .orderBy(desc(jobRuns.createdAt))
      .all()
    return rows.map((r) => ({ ...r.run, chatHidden: !!r.chatHidden }))
  },

  getById(userId: string, runId: string): JobRunRow | undefined {
    return getDb()
      .select()
      .from(jobRuns)
      .where(and(eq(jobRuns.id, runId), eq(jobRuns.userId, userId)))
      .get()
  },

  /** Lookup by originating chat id — used by stream-completion hook. */
  getByLocalChatId(chatId: string): JobRunRow | undefined {
    return getDb()
      .select()
      .from(jobRuns)
      .where(eq(jobRuns.localChatId, chatId))
      .get()
  },

  create(input: JobRunCreateInput): JobRunRow {
    const now = new Date()
    const row = {
      id: nanoid(),
      jobId: input.jobId,
      userId: input.userId,
      type: input.type,
      localChatId: input.localChatId ?? null,
      cinnaTaskId: input.cinnaTaskId ?? null,
      cinnaShortCode: input.cinnaShortCode ?? null,
      status: input.status ?? 'pending',
      errorMessage: null,
      startedAt: input.status === 'running' ? now : null,
      finishedAt: null,
      createdAt: now
    }
    getDb().insert(jobRuns).values(row).run()
    return row
  },

  /**
   * Atomically create the chat row, MCP attachments, and job_runs row for a
   * local job execution — and back-fill the chat's `originatingJobRunId`
   * pointer in the same transaction. A crash mid-way leaves the database
   * unchanged so the streaming-completion hook never sees a half-set state.
   */
  createLocalChatAndRun(input: {
    userId: string
    jobId: string
    title: string
    prompt: string
    agentId: string | null
    modeId: string | null
    providerId: string | null
    modelId: string | null
    mcpProviderIds: string[]
  }): { chatId: string; runId: string } {
    return getDb().transaction((tx) => {
      const now = new Date()
      const chatId = nanoid()
      tx.insert(chats)
        .values({
          id: chatId,
          userId: input.userId,
          title: input.title,
          modelId: input.modelId,
          providerId: input.providerId,
          modeId: input.modeId,
          agentId: input.agentId,
          originatingJobRunId: null,
          // Job-spawned chats are hidden from the chat list by default; the
          // user can promote them via the "Move to Chats" button on the run.
          hiddenFromList: true,
          deletedAt: null,
          createdAt: now,
          updatedAt: now
        })
        .run()

      for (const mcpProviderId of input.mcpProviderIds) {
        tx.insert(chatMcpProviders).values({ chatId, mcpProviderId }).run()
      }

      const runId = nanoid()
      tx.insert(jobRuns)
        .values({
          id: runId,
          jobId: input.jobId,
          userId: input.userId,
          type: 'local',
          localChatId: chatId,
          cinnaTaskId: null,
          cinnaShortCode: null,
          status: 'running',
          errorMessage: null,
          startedAt: now,
          finishedAt: null,
          createdAt: now
        })
        .run()

      tx.update(chats)
        .set({ originatingJobRunId: runId })
        .where(and(eq(chats.id, chatId), eq(chats.userId, input.userId)))
        .run()

      return { chatId, runId }
    })
  },

  updateStatus(
    runId: string,
    status: JobRunStatus,
    opts?: { errorMessage?: string | null }
  ): boolean {
    const terminal = status === 'succeeded' || status === 'failed' || status === 'cancelled'
    const result = getDb()
      .update(jobRuns)
      .set({
        status,
        errorMessage: opts?.errorMessage ?? null,
        finishedAt: terminal ? new Date() : null
      })
      .where(eq(jobRuns.id, runId))
      .run()
    return result.changes > 0
  },

  /**
   * Hard-delete a run and (for local runs) the chat it spawned. Wrapped in a
   * transaction so a partial outcome is impossible — either both rows go or
   * neither does.
   *
   * Returns the captured `chatId` so the IPC layer can broadcast the right
   * invalidations (chat list, trash, active-chat reset).
   *
   * The `chats.originating_job_run_id` column has no FK, so deleting the run
   * first leaves the now-orphan pointer behind for one step inside the txn —
   * the subsequent chat delete cleans it up. `jobRuns.local_chat_id` has
   * `ON DELETE SET NULL`, so deleting the chat first would null that field
   * mid-txn but we've already captured the id above.
   */
  deleteWithChat(
    userId: string,
    runId: string
  ): { runDeleted: boolean; chatId: string | null; chatDeleted: boolean } {
    const db = getDb()
    return db.transaction((tx) => {
      const run = tx
        .select()
        .from(jobRuns)
        .where(and(eq(jobRuns.id, runId), eq(jobRuns.userId, userId)))
        .get()
      if (!run) {
        return { runDeleted: false, chatId: null, chatDeleted: false }
      }
      const chatId = run.type === 'local' ? run.localChatId : null
      const runResult = tx.delete(jobRuns).where(eq(jobRuns.id, runId)).run()
      let chatDeleted = false
      if (chatId) {
        const chatResult = tx
          .delete(chats)
          .where(and(eq(chats.id, chatId), eq(chats.userId, userId)))
          .run()
        chatDeleted = chatResult.changes > 0
      }
      return { runDeleted: runResult.changes > 0, chatId, chatDeleted }
    })
  }
}
