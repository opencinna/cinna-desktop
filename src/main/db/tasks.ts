import type { TaskScript } from '../../shared/taskScript'
import { nanoid } from 'nanoid'
import { and, desc, eq, gt, inArray, isNull, sql } from 'drizzle-orm'
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
  script?: TaskScript | null
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
 *
 * **Six of these columns are also frontmatter** in the exported handoff note
 * (`services/taskFileService.ts`): `title`, `status`, `assigneeName`,
 * `parentTaskId`, `remoteKey` and `updatedAt`. Nothing reads that file back, so
 * a write that does not re-export leaves it lying with nothing to correct it —
 * which is why every `taskService` mutation ends in `written(row)` rather than
 * `toTaskDto(row)`, and why `taskService.test.ts` pins the list of methods that
 * do. A new writer of any of these six belongs on that list.
 */
export type TaskPatch = Partial<
  Pick<
    TaskRow,
    | 'title'
    | 'description'
    | 'status'
    | 'priority'
    | 'router'
    | 'script'
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

/**
 * One task exactly as it arrived from another of the user's devices, already
 * decoded and with its portable assignee descriptor resolved to a local agent
 * id (or to null, when this device does not have that agent).
 *
 * The three columns that are **not** here are the three that do not travel:
 * `chatId`, `remoteSyncedAt` and `remoteDirty`. See
 * {@link taskRepo.upsertFromSync}.
 */
export interface TaskSyncValues {
  id: string
  title: string
  goal: string
  description: string | null
  status: TaskStatus
  priority: TaskPriority
  router: TaskRouter
  script?: TaskScript | null
  origin: TaskOrigin
  executor: TaskExecutor
  executorDevice: string | null
  assigneeAgentId: string | null
  assigneeName: string | null
  assigneeKind: TaskAssignee['kind']
  assigneeRef: JobDepDescriptor | null
  parentTaskId: string | null
  jobId: string | null
  jobRunId: string | null
  remoteAdapter: string | null
  remoteId: string | null
  remoteKey: string | null
  remoteUrl: string | null
  remoteState: Record<string, unknown> | null
  handoffNote: string | null
  artifacts: TaskArtifact[] | null
  budget: TaskBudget | null
  errorMessage: string | null
  createdAt: Date
  updatedAt: Date
  startedAt: Date | null
  finishedAt: Date | null
  deletedAt: Date | null
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
      script: input.script ?? null,

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
   *
   * **A soft-deleted row is not updatable.** Every caller inside `taskService`
   * already goes through `requireTask`, which filters `deletedAt` — so this
   * clause changes nothing today and exists for the caller that does not: a
   * sync-apply path writing rows that arrived from another device. Such a path
   * is not a `taskService` method, so the classification guard in
   * `taskService.test.ts` cannot see it, and going round the service would both
   * skip `written()` and **resurrect the deleted task's exported note** — a file
   * reappearing under `<userData>/tasks/` for a task the user deleted. Two
   * places now have to be wrong for that to happen instead of one.
   */
  update(userId: string, taskId: string, patch: TaskPatch): TaskRow | undefined {
    const result = getDb()
      .update(tasks)
      .set({ ...patch, updatedAt: patch.updatedAt ?? new Date() })
      .where(and(eq(tasks.id, taskId), eq(tasks.userId, userId), isNull(tasks.deletedAt)))
      .run()
    if (result.changes === 0) return undefined
    return this.getById(userId, taskId)
  },

  /**
   * Soft-delete. The row stays and the delete travels as `deletedAt`.
   *
   * **No `syncRepo.addTombstone`, and that is the finished design rather than a
   * gap.** A tombstone is app-sync's carrier for a *hard* delete — the wire
   * record has no payload at all, and the peer that receives one removes its
   * row (`notesRepo.permanentDelete`, `emptyTrash`). A soft delete rides the
   * ordinary push instead: `softDelete` bumps `updatedAt`, so
   * {@link taskRepo.listChangedSince} picks the row up, `taskMapper` sends it
   * with `deleted: true` and `deletedAt` in the payload, and the peer applies
   * it as an upsert. Jobs and notes have worked exactly this way since sync
   * shipped; a task has no trash and no restore, so this is the only delete it
   * has.
   *
   * `updatedAt` moves with `deletedAt` deliberately: the push batch is selected
   * by `updatedAt > watermark` and that value is also the LWW timestamp, so a
   * delete that left it stale would never reach a peer at all.
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

  // ---- Data-sync engine helpers ------------------------------------------
  // Back the `task` mapper in `src/main/sync/collections.ts`. Soft-deleted rows
  // are INCLUDED here, unlike every read above: a delete is a change like any
  // other and it is the one change a peer most needs to hear about.

  /** Tasks changed since `sinceMs` (exclusive), INCLUDING soft-deleted ones. */
  listChangedSince(userId: string, sinceMs: number): TaskRow[] {
    return getDb()
      .select()
      .from(tasks)
      .where(and(eq(tasks.userId, userId), gt(tasks.updatedAt, new Date(sinceMs))))
      .all()
  },

  /**
   * The newest `updated_at` in this profile's tasks, in **milliseconds**.
   *
   * Answered by SQLite rather than by reducing every row in JS, which is what
   * `notesRepo` and `jobsRepo` do. The divergence is deliberate and it is about
   * growth: this runs for every collection on every sync cycle, and `tasks` is
   * the first one that gains a row per *job run* rather than per user gesture,
   * so a busy profile would allocate a `Date` per task every sixty seconds to
   * compute one number the index already holds. The other three are worth the
   * same change and it is not this phase's to make.
   *
   * **The `* 1000` is the whole risk here.** Drizzle's
   * `integer({ mode: 'timestamp' })` stores **seconds**, so `max()` answers in
   * seconds while every caller — and `Date.getTime()`, which the JS version
   * returned — works in milliseconds. Getting it wrong by a factor of a
   * thousand makes the push watermark either never advance or never hold, and
   * neither announces itself. `sync/taskCollection.test.ts` pins the value
   * against a known timestamp for exactly that reason.
   */
  maxUpdatedAt(userId: string): number {
    const row = getDb()
      .select({ max: sql<number | null>`max(${tasks.updatedAt})` })
      .from(tasks)
      .where(eq(tasks.userId, userId))
      .get()
    return row?.max ? row.max * 1000 : 0
  },

  /**
   * Write a task that arrived from another of the user's devices.
   *
   * **The one writer here that may touch a soft-deleted row**, and the contrast
   * with {@link taskRepo.update} is the whole point of both. `update` refuses a
   * tombstone because every caller of it is a local mutation and resurrecting a
   * deleted task behind the user's back is a defect. This is not a local
   * mutation: the sync engine has already decided, by last-writer-wins on the
   * server, that the arriving copy is the newer one — so if the peer's copy
   * says the task is alive and ours says it is deleted, the peer deleted and
   * then restored it, or ours was deleted first and lost. Refusing here would
   * leave the two devices permanently disagreeing with no way to converge.
   *
   * `deletedAt` therefore comes off the wire like any other column rather than
   * being preserved from the local row.
   *
   * Callers go through `taskService.applySyncedTask`, never here directly: the
   * exported handoff note has to follow the row, and only the service knows
   * that.
   *
   * Returns **false** for the one refusal it makes — an id that belongs to
   * another profile on this install — so the caller can say *that* rather than
   * infer a reason from a read-back that came up empty. The two are the same
   * thing today and only by accident: `getById` does not filter `deletedAt`,
   * so a tombstone is not a second way to miss, and nothing else can make the
   * insert not land. An inference that holds by coincidence is one that stops
   * holding silently.
   */
  upsertFromSync(userId: string, values: TaskSyncValues): boolean {
    const db = getDb()
    // Cross-profile defence in depth, the same check `jobsRepo.upsertFromSync`
    // makes: an id that already belongs to another profile is never rewritten.
    const existing = db
      .select({ uid: tasks.userId })
      .from(tasks)
      .where(eq(tasks.id, values.id))
      .get()
    if (existing && existing.uid !== userId) return false

    const row = {
      ...values,
      userId,
      // Three columns are deliberately absent from `TaskSyncValues` and are
      // therefore set only on INSERT: `chatId` (chats are not a synced
      // collection, so a replica opens with no thread) and the two per-device
      // bookkeeping fields, which a peer must never inherit — a watermark
      // saying "this device last heard from that service at X" is a claim only
      // the device that made the call can make.
      chatId: null,
      remoteSyncedAt: null,
      remoteDirty: null
    }
    db.insert(tasks)
      .values(row)
      .onConflictDoUpdate({
        target: tasks.id,
        set: {
          title: values.title,
          goal: values.goal,
          description: values.description,
          status: values.status,
          priority: values.priority,
          router: values.router,
          script: values.script ?? null,
          origin: values.origin,
          executor: values.executor,
          executorDevice: values.executorDevice,
          assigneeAgentId: values.assigneeAgentId,
          assigneeName: values.assigneeName,
          assigneeKind: values.assigneeKind,
          assigneeRef: values.assigneeRef,
          parentTaskId: values.parentTaskId,
          jobId: values.jobId,
          jobRunId: values.jobRunId,
          remoteAdapter: values.remoteAdapter,
          remoteId: values.remoteId,
          remoteKey: values.remoteKey,
          remoteUrl: values.remoteUrl,
          remoteState: values.remoteState,
          handoffNote: values.handoffNote,
          artifacts: values.artifacts,
          budget: values.budget,
          errorMessage: values.errorMessage,
          createdAt: values.createdAt,
          updatedAt: values.updatedAt,
          startedAt: values.startedAt,
          finishedAt: values.finishedAt,
          deletedAt: values.deletedAt
        }
      })
      .run()
    return true
  },

  /**
   * Hard-delete, scoped to the owning user.
   *
   * The arm of the mapper that applies a **tombstone** — a pulled record with
   * no payload at all. Nothing on the desktop writes one for a task today
   * (`softDelete` is the only delete a task has, and it travels as an upsert),
   * so this is reached only by a peer on a build that does, which is the shape
   * every other collection's mapper already tolerates. It is here rather than
   * left to throw because an unhandled collection stalls nothing but also
   * applies nothing: the record would come back on every pull for ever.
   *
   * Returns whether a row of **this user's** actually went, which the caller
   * needs: the exported handoff note is keyed on the task id alone and the
   * folder is not profile-scoped, so removing the file on a delete that hit
   * nothing would take another profile's file with it.
   */
  deleteOwned(userId: string, taskId: string): boolean {
    const result = getDb()
      .delete(tasks)
      .where(and(eq(tasks.id, taskId), eq(tasks.userId, userId)))
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
