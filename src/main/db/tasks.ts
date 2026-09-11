import { nanoid } from 'nanoid'
import { and, desc, eq, inArray, isNull, sql } from 'drizzle-orm'
import { getDb } from './client'
import { tasks } from './schema'
import type { JobDepDescriptor } from '../../shared/sync'
import type { TaskStatus } from '../../shared/taskStatus'
import type {
  TaskArtifact,
  TaskAssignee,
  TaskBudget,
  TaskExecutor,
  TaskOrigin,
  TaskPriority,
  TaskRouter
} from '../../shared/tasks'

export type TaskRow = typeof tasks.$inferSelect

/**
 * What a caller supplies to create a task. Everything with a sensible default
 * has one, because the two callers that matter — a user creating a task by hand
 * and `jobService.execute` creating one for a run — know very different amounts
 * about it.
 *
 * `id` is accepted so a pull can upsert a replica under the id the sync payload
 * carries. Nothing else should pass it.
 */
export interface TaskCreateInput {
  id?: string
  title: string
  goal: string
  description?: string | null
  status?: TaskStatus
  priority?: TaskPriority
  router?: TaskRouter

  origin?: TaskOrigin
  executor?: TaskExecutor
  executorDevice?: string | null

  chatId?: string | null
  assigneeAgentId?: string | null
  assigneeName?: string | null
  assigneeKind?: TaskAssignee['kind']
  assigneeRef?: JobDepDescriptor | null
  parentTaskId?: string | null
  jobId?: string | null
  jobRunId?: string | null

  remoteAdapter?: string | null
  remoteId?: string | null
  remoteKey?: string | null
  remoteUrl?: string | null
  remoteState?: Record<string, unknown> | null

  handoffNote?: string | null
  artifacts?: TaskArtifact[] | null
  budget?: TaskBudget | null

  createdAt?: Date
  updatedAt?: Date
}

/**
 * A partial write. Deliberately the whole column set minus the three that are
 * not writable: `id`, `userId` and `origin` — provenance, which never changes.
 * `goal` is absent for the same reason (it is cinna's `original_message`, and
 * it is immutable once created).
 */
export type TaskPatch = Partial<
  Pick<
    TaskRow,
    | 'title'
    | 'description'
    | 'status'
    | 'priority'
    | 'router'
    | 'executor'
    | 'executorDevice'
    | 'chatId'
    | 'assigneeAgentId'
    | 'assigneeName'
    | 'assigneeKind'
    | 'assigneeRef'
    | 'parentTaskId'
    | 'jobId'
    | 'jobRunId'
    | 'remoteAdapter'
    | 'remoteId'
    | 'remoteKey'
    | 'remoteUrl'
    | 'remoteState'
    | 'remoteSyncedAt'
    | 'remoteDirty'
    | 'handoffNote'
    | 'artifacts'
    | 'budget'
    | 'errorMessage'
    | 'startedAt'
    | 'finishedAt'
    /**
     * Writable so a **pull** can carry the remote's own modification time
     * instead of stamping "now". §5.4 reconciles per field on `updatedAt`, and
     * a mirror that always looked newer than the record it mirrors would make
     * every pulled field look like a local edit and win every conflict.
     * Omitted — which is every local write — means now.
     */
    | 'updatedAt'
  >
>

export interface TaskListFilter {
  /** Only these statuses. Omitted = every status the other filters allow. */
  statuses?: readonly TaskStatus[]
  executor?: TaskExecutor
  /** Children of this task. Mutually exclusive with `rootOnly`. */
  parentTaskId?: string
  /** Only tasks with no parent. */
  rootOnly?: boolean
  /** Bound to this adapter. Only the adapters and `taskSyncService` pass it. */
  remoteAdapter?: string
  /**
   * Archived tasks are excluded by default. They are the user's "filed away"
   * pile, and every list that is not the archive itself means the live ones.
   */
  includeArchived?: boolean
}

/** How many subtasks a task has, and how many of them are done. cinna's computed pair. */
export interface SubtaskCounts {
  total: number
  completed: number
}

const ARCHIVED: TaskStatus = 'archived'

export const taskRepo = {
  list(userId: string, filter: TaskListFilter = {}): TaskRow[] {
    const where = [eq(tasks.userId, userId), isNull(tasks.deletedAt)]
    if (filter.statuses?.length) where.push(inArray(tasks.status, [...filter.statuses]))
    else if (!filter.includeArchived) where.push(sql`${tasks.status} != ${ARCHIVED}`)
    if (filter.executor) where.push(eq(tasks.executor, filter.executor))
    if (filter.parentTaskId) where.push(eq(tasks.parentTaskId, filter.parentTaskId))
    if (filter.rootOnly) where.push(isNull(tasks.parentTaskId))
    if (filter.remoteAdapter) where.push(eq(tasks.remoteAdapter, filter.remoteAdapter))

    return getDb()
      .select()
      .from(tasks)
      .where(and(...where))
      .orderBy(desc(tasks.updatedAt))
      .all()
  },

  getById(userId: string, taskId: string): TaskRow | undefined {
    return getDb()
      .select()
      .from(tasks)
      .where(and(eq(tasks.id, taskId), eq(tasks.userId, userId)))
      .get()
  },

  /**
   * The task bound to a remote record, if one is. The re-binding lookup after a
   * reinstall, and the upsert target of every pull.
   *
   * **Soft-deleted rows are included, deliberately.** The question this answers
   * is "do we already know this remote record", and the answer for a task the
   * user deleted here is yes — hiding it would make the next pull create a
   * second local task for the same remote one, which is the duplicate
   * `external_ref` exists to prevent. The caller decides whether a deleted
   * replica should be resurrected or skipped; `taskSyncService` must therefore
   * check `deletedAt` itself rather than hand the id straight to a service
   * method, all of which refuse a deleted task.
   */
  getByRemote(userId: string, adapter: string, remoteId: string): TaskRow | undefined {
    return getDb()
      .select()
      .from(tasks)
      .where(
        and(
          eq(tasks.userId, userId),
          eq(tasks.remoteAdapter, adapter),
          eq(tasks.remoteId, remoteId)
        )
      )
      .get()
  },

  /** The task running in a chat, if one is. How a stream event finds its task. */
  getByChatId(userId: string, chatId: string): TaskRow | undefined {
    return getDb()
      .select()
      .from(tasks)
      .where(and(eq(tasks.userId, userId), eq(tasks.chatId, chatId), isNull(tasks.deletedAt)))
      .orderBy(desc(tasks.updatedAt))
      .get()
  },

  /**
   * The task a job run produced. None for a run that predates the tasks table,
   * and none for one whose task the user has since deleted — a deleted task is
   * not a task, and every service method refuses it anyway.
   */
  getByJobRunId(userId: string, jobRunId: string): TaskRow | undefined {
    return getDb()
      .select()
      .from(tasks)
      .where(
        and(eq(tasks.userId, userId), eq(tasks.jobRunId, jobRunId), isNull(tasks.deletedAt))
      )
      .get()
  },

  create(userId: string, input: TaskCreateInput): TaskRow {
    const now = new Date()
    const row: TaskRow = {
      id: input.id ?? nanoid(),
      userId,
      title: input.title,
      goal: input.goal,
      description: input.description ?? null,
      status: input.status ?? 'new',
      priority: input.priority ?? 'normal',
      router: input.router ?? 'direct',

      origin: input.origin ?? 'local',
      executor: input.executor ?? 'desktop',
      executorDevice: input.executorDevice ?? null,

      chatId: input.chatId ?? null,
      assigneeAgentId: input.assigneeAgentId ?? null,
      assigneeName: input.assigneeName ?? null,
      assigneeKind: input.assigneeKind ?? (input.assigneeAgentId ? 'agent' : 'model'),
      assigneeRef: input.assigneeRef ?? null,
      parentTaskId: input.parentTaskId ?? null,
      jobId: input.jobId ?? null,
      jobRunId: input.jobRunId ?? null,

      remoteAdapter: input.remoteAdapter ?? null,
      remoteId: input.remoteId ?? null,
      remoteKey: input.remoteKey ?? null,
      remoteUrl: input.remoteUrl ?? null,
      remoteState: input.remoteState ?? null,
      remoteSyncedAt: null,
      remoteDirty: null,

      handoffNote: input.handoffNote ?? null,
      artifacts: input.artifacts ?? null,
      budget: input.budget ?? null,
      errorMessage: null,

      createdAt: input.createdAt ?? now,
      updatedAt: input.updatedAt ?? now,
      startedAt: null,
      finishedAt: null,
      deletedAt: null
    }
    getDb().insert(tasks).values(row).run()
    return row
  },

  /**
   * Apply a patch and return the row as it now stands, or undefined when the
   * task is not this user's.
   *
   * It returns the row rather than a boolean (the shape `jobsRepo.update` uses)
   * because every caller in `taskService` needs the new state — to decide what
   * to push to a bound remote, and to hand back to the renderer.
   */
  update(userId: string, taskId: string, patch: TaskPatch): TaskRow | undefined {
    const result = getDb()
      .update(tasks)
      .set({ ...patch, updatedAt: patch.updatedAt ?? new Date() })
      .where(and(eq(tasks.id, taskId), eq(tasks.userId, userId)))
      .run()
    if (result.changes === 0) return undefined
    return this.getById(userId, taskId)
  },

  /**
   * Soft-delete. App-sync carries tombstones, so the row stays and the delete
   * travels as `deletedAt`.
   *
   * No `syncRepo.addTombstone` yet — `'task'` joins `SyncCollection` with the
   * `taskMapper` in step 10 of the phase, and a tombstone for a collection the
   * sync engine has no mapper for would be pushed and never applied. Until
   * then a delete is local, which is exactly what it already is for a profile
   * with sync off.
   */
  softDelete(userId: string, taskId: string): boolean {
    const now = new Date()
    const result = getDb()
      .update(tasks)
      .set({ deletedAt: now, updatedAt: now })
      .where(and(eq(tasks.id, taskId), eq(tasks.userId, userId), isNull(tasks.deletedAt)))
      .run()
    return result.changes > 0
  },

  /**
   * Subtask totals for a set of parents, in one query.
   *
   * Per parent rather than per task because the task list renders the pair on
   * every row, and the obvious loop is a query per row. Parents with no
   * subtasks are absent from the map; callers read `?? { total: 0, completed: 0 }`.
   */
  subtaskCounts(userId: string, parentIds: readonly string[]): Map<string, SubtaskCounts> {
    const counts = new Map<string, SubtaskCounts>()
    if (parentIds.length === 0) return counts

    const rows = getDb()
      .select({
        parentTaskId: tasks.parentTaskId,
        total: sql<number>`count(*)`,
        completed: sql<number>`sum(case when ${tasks.status} = 'completed' then 1 else 0 end)`
      })
      .from(tasks)
      .where(
        and(
          eq(tasks.userId, userId),
          isNull(tasks.deletedAt),
          inArray(tasks.parentTaskId, [...parentIds])
        )
      )
      .groupBy(tasks.parentTaskId)
      .all()

    for (const row of rows) {
      if (!row.parentTaskId) continue
      counts.set(row.parentTaskId, {
        total: Number(row.total ?? 0),
        completed: Number(row.completed ?? 0)
      })
    }
    return counts
  }
}
