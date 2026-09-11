import { syncRepo } from '../db/sync'
import {
  taskRepo,
  type TaskCreateInput,
  type TaskListFilter,
  type TaskPatch,
  type TaskRow
} from '../db/tasks'
import { TaskError } from '../errors'
import { createLogger } from '../logger/logger'
import {
  canTransition,
  parseTaskStatus,
  taskStatusForRunState,
  VALID_TRANSITIONS,
  type TaskStatus
} from '../../shared/taskStatus'
import type { RunState } from '../../shared/runEvents'
import {
  parseTaskAssigneeKind,
  parseTaskExecutor,
  parseTaskOrigin,
  parseTaskPriority,
  parseTaskRouter,
  taskRunsHere,
  type TaskAssignee,
  type TaskDto,
  type TaskExecutor,
  type TaskPriority,
  type TaskRouter
} from '../../shared/tasks'

const logger = createLogger('task')

/**
 * The task domain, above the repo and below IPC.
 *
 * Two rules run through everything here, and both come from the phase plan:
 *
 * **Validate on write, accept on read.** A transition the desktop *initiates*
 * is checked against the table copied from cinna-core; a status arriving from a
 * pull is taken as fact through {@link taskService.acceptRemoteStatus}. The
 * server's own session handlers bypass its table, so a replica can legitimately
 * be in a state the table calls unreachable, and refusing it would make the
 * desktop the one corrupting state.
 *
 * **Authority follows `executor`.** While a task runs on another device, or on
 * a bound remote system, this process does not write the fields that follow the
 * run — `status`, `assignee`, `handoffNote`. `title`, `description`, `priority`
 * and `router` are writable from either side whatever the executor is. The
 * guard is {@link taskRunsHere}, and it is a claim rather than a lock:
 * {@link taskService.takeOver} is the write that moves the task here and is
 * deliberately not gated on it.
 *
 * Remote pushes are **not** here. `taskService` writes SQLite and nothing else;
 * `taskSyncService` reconciles with a bound adapter afterwards (step 9). That
 * split is what makes an unlinked profile, an offline laptop and a 500 the same
 * code path.
 */

/**
 * This device's sync id, or null when the profile has never synced.
 *
 * Null means "here" — it is what a profile with sync off always has, so a task
 * it claims is claimed by nobody in particular, which is correct: there is no
 * other device that could disagree.
 */
function thisDeviceId(userId: string): string | null {
  return syncRepo.getState(userId)?.deviceId ?? null
}

function requireTask(userId: string, taskId: string): TaskRow {
  const task = taskRepo.getById(userId, taskId)
  if (!task || task.deletedAt) throw new TaskError('not_found', 'Task not found')
  return task
}

/** The three fields whose authority follows `executor`. */
function requireRunsHere(userId: string, task: TaskRow): void {
  if (taskRunsHere(task, thisDeviceId(userId))) return
  throw new TaskError(
    'running_elsewhere',
    task.executor === 'remote'
      ? 'This task is running on a connected service'
      : 'This task is running on another device'
  )
}

/** A task has stopped: it finished, it failed, or someone called it off. */
function isSettled(status: TaskStatus): boolean {
  return status === 'completed' || status === 'error' || status === 'cancelled'
}

/**
 * A task is being picked up again. The only statuses that mean work is
 * expected to continue — and therefore the only ones that may clear the record
 * of how it stopped last time.
 */
function isReopening(status: TaskStatus): boolean {
  return (
    status === 'new' || status === 'refining' || status === 'open' || status === 'in_progress'
  )
}

/**
 * Apply a status to a row, keeping `startedAt` / `finishedAt` / `errorMessage`
 * honest.
 *
 * `startedAt` is stamped once, the first time work actually begins, so a task
 * that goes `in_progress → blocked → in_progress` keeps the time it really
 * started.
 *
 * `finishedAt` and `errorMessage` are cleared **only on the way back in**.
 * `error → in_progress` is a legal retry and a finished-at in the past on a
 * running task is the kind of wrong that only shows up in a report months
 * later — but `archived` is not a retry, it is the user filing the task away,
 * and it is reachable from every terminal status. Clearing on "any status that
 * is not terminal" wiped the finish time and the error text of every task
 * anybody ever archived, unrecoverably, because nothing else holds them.
 */
function statusPatch(task: TaskRow, status: TaskStatus, errorMessage?: string | null): TaskPatch {
  const now = new Date()
  const reopening = isReopening(status)
  return {
    status,
    startedAt: task.startedAt ?? (status === 'in_progress' ? now : null),
    finishedAt: isSettled(status) ? (task.finishedAt ?? now) : reopening ? null : task.finishedAt,
    errorMessage:
      errorMessage !== undefined ? errorMessage : reopening ? null : task.errorMessage
  }
}

function nonEmpty(value: string, field: string): string {
  const trimmed = value.trim()
  if (!trimmed) throw new TaskError('invalid_input', `${field} is required`)
  return trimmed
}

/**
 * The row as every surface sees it.
 *
 * `subtaskCount` / `subtaskCompletedCount` are passed in rather than queried,
 * because a list renders the pair on every row and the obvious per-row query is
 * a query per row. {@link taskService.list} fetches them for the whole page in
 * one go.
 */
export function toTaskDto(
  row: TaskRow,
  counts: { total: number; completed: number } = { total: 0, completed: 0 }
): TaskDto {
  // Every union is parsed rather than trusted. These columns are written by
  // this build today, but from step 10 a row can arrive over app-sync from a
  // peer on a newer one, and a value outside the union would reach a renderer
  // `switch` with no case for it.
  const assignee: TaskAssignee = {
    agentId: row.assigneeAgentId,
    name: row.assigneeName,
    kind: parseTaskAssigneeKind(row.assigneeKind)
  }
  return {
    id: row.id,
    title: row.title,
    goal: row.goal,
    description: row.description,
    status: parseTaskStatus(row.status),
    priority: parseTaskPriority(row.priority),
    router: parseTaskRouter(row.router),
    origin: parseTaskOrigin(row.origin),
    executor: parseTaskExecutor(row.executor),
    executorDevice: row.executorDevice,
    chatId: row.chatId,
    assignee,
    parentTaskId: row.parentTaskId,
    subtaskCount: counts.total,
    subtaskCompletedCount: counts.completed,
    // The opaque `remoteState` deliberately does not cross: nothing outside
    // `main/tasks/adapters/` may read it, and the renderer is outside.
    remote: row.remoteAdapter && row.remoteId
      ? { adapter: row.remoteAdapter, id: row.remoteId, key: row.remoteKey, url: row.remoteUrl }
      : null,
    handoffNote: row.handoffNote,
    artifacts: row.artifacts ?? [],
    budget: row.budget ?? null,
    errorMessage: row.errorMessage,
    jobId: row.jobId,
    jobRunId: row.jobRunId,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    startedAt: row.startedAt,
    finishedAt: row.finishedAt
  }
}

/** What a caller may change about a task regardless of who is running it. */
export interface TaskFieldPatch {
  title?: string
  description?: string | null
  priority?: TaskPriority
  router?: TaskRouter
}

export const taskService = {
  list(userId: string, filter: TaskListFilter = {}): TaskDto[] {
    const rows = taskRepo.list(userId, filter)
    const counts = taskRepo.subtaskCounts(
      userId,
      rows.map((r) => r.id)
    )
    return rows.map((row) => toTaskDto(row, counts.get(row.id)))
  },

  getById(userId: string, taskId: string): TaskDto {
    const row = requireTask(userId, taskId)
    return toTaskDto(row, taskRepo.subtaskCounts(userId, [row.id]).get(row.id))
  },

  /** The row, unmapped. For main-process callers that need the remote binding. */
  getRow(userId: string, taskId: string): TaskRow {
    return requireTask(userId, taskId)
  },

  create(userId: string, input: TaskCreateInput): TaskDto {
    const title = nonEmpty(input.title, 'Title')
    const goal = nonEmpty(input.goal, 'Goal')

    if (input.parentTaskId) {
      const parent = taskRepo.getById(userId, input.parentTaskId)
      if (!parent || parent.deletedAt) {
        throw new TaskError('not_found', 'Parent task not found')
      }
      // One level, and the check is on the *parent*: a task may have children,
      // but a task that already has a parent may not.
      if (parent.parentTaskId) {
        throw new TaskError('nested_too_deep', 'A subtask cannot have subtasks of its own')
      }
    }

    const row = taskRepo.create(userId, {
      ...input,
      title,
      goal,
      // A task this device is about to run names the device, so a peer knows
      // not to. A profile with sync off writes null, which means "here".
      executorDevice:
        input.executorDevice !== undefined
          ? input.executorDevice
          : (input.executor ?? 'desktop') === 'desktop'
            ? thisDeviceId(userId)
            : null
    })
    logger.info('task created', {
      taskId: row.id,
      origin: row.origin,
      executor: row.executor,
      jobRunId: row.jobRunId ?? undefined
    })
    return toTaskDto(row)
  },

  /**
   * Fields either side may write, whatever the executor is. No
   * {@link requireRunsHere} on purpose: fixing a title on the device you are
   * looking at is not a claim on the run.
   */
  update(userId: string, taskId: string, patch: TaskFieldPatch): TaskDto {
    requireTask(userId, taskId)
    const next: TaskPatch = {}
    if (patch.title !== undefined) next.title = nonEmpty(patch.title, 'Title')
    if (patch.description !== undefined) next.description = patch.description
    if (patch.priority !== undefined) next.priority = patch.priority
    if (patch.router !== undefined) next.router = patch.router
    if (Object.keys(next).length === 0) return this.getById(userId, taskId)

    const row = taskRepo.update(userId, taskId, next)
    if (!row) throw new TaskError('not_found', 'Task not found')
    return toTaskDto(row)
  },

  /**
   * A status change **this device initiates** — validated against the table.
   *
   * A refusal is a bug on this side, not a runtime condition: every caller
   * either knows the task's current status or is deriving one from a run state
   * that cannot produce an illegal step. It is loud for that reason.
   */
  setStatus(
    userId: string,
    taskId: string,
    status: TaskStatus,
    opts: { errorMessage?: string | null } = {}
  ): TaskDto {
    const task = requireTask(userId, taskId)
    requireRunsHere(userId, task)

    const from = parseTaskStatus(task.status)
    if (!canTransition(from, status)) {
      throw new TaskError(
        'invalid_transition',
        `A task cannot go from ${from} to ${status}`,
        `Allowed from ${from}: ${VALID_TRANSITIONS[from].join(', ') || 'nothing'}`
      )
    }

    const row = taskRepo.update(userId, taskId, statusPatch(task, status, opts.errorMessage))
    if (!row) throw new TaskError('not_found', 'Task not found')
    logger.info('task status', { taskId, from, to: status })
    return toTaskDto(row)
  },

  /**
   * A status observed **elsewhere** — a pull from a bound remote, or a sync
   * payload from a peer. Written as fact, with no transition check.
   *
   * This is not laxness. cinna-core's own session-lifecycle handlers call
   * `update_status`, which bypasses its transition table, so a task really can
   * arrive in a state the table forbids reaching. The desktop's job is to
   * mirror it, not to argue with the system that is executing the work.
   */
  acceptRemoteStatus(userId: string, taskId: string, status: TaskStatus): TaskDto {
    const task = requireTask(userId, taskId)
    const row = taskRepo.update(userId, taskId, statusPatch(task, status))
    if (!row) throw new TaskError('not_found', 'Task not found')
    if (parseTaskStatus(task.status) !== status) {
      logger.info('task status pulled', { taskId, from: task.status, to: status })
    }
    return toTaskDto(row)
  },

  /**
   * Move a task to wherever a **run state** says it is now.
   *
   * The bridge `setStatus` cannot be: a run's vocabulary is A2A's and a task's
   * is cinna's, and the two do not step in lockstep. `submitted` maps to `open`,
   * which is not reachable from `in_progress` — and `submitted` is a real state
   * that `a2aStreamingService` passes straight through, once per A2A task, which
   * means once per turn. Wiring run events to `setStatus` directly would throw
   * `invalid_transition` inside the stream-completion path, which is not written
   * to catch it, on the second turn of every agent chat.
   *
   * So three cases, in order:
   *
   *  - the derived status is one legal step away → take it;
   *  - it is terminal and it is not → walk through `in_progress` first, which is
   *    the local twin of the status *path* a bound remote needs (§5.12 rule 2);
   *  - neither → **no-op**. A run announcing `submitted` for a task already
   *    `in_progress` is telling us nothing we do not know, and going backwards
   *    to `open` would be a worse lie than saying nothing.
   *
   * Returns the task as it now stands, unchanged in the no-op case.
   */
  applyRunState(userId: string, taskId: string, state: RunState): TaskDto {
    const task = requireTask(userId, taskId)
    const from = parseTaskStatus(task.status)
    const to = taskStatusForRunState(state)

    if (canTransition(from, to)) return this.setStatus(userId, taskId, to)
    if (isSettled(to) && canTransition(from, 'in_progress')) {
      this.setStatus(userId, taskId, 'in_progress')
      return this.setStatus(userId, taskId, to)
    }

    logger.debug('run state says nothing this task can act on', { taskId, from, state })
    return toTaskDto(task)
  },

  setAssignee(userId: string, taskId: string, assignee: TaskAssignee): TaskDto {
    const task = requireTask(userId, taskId)
    requireRunsHere(userId, task)
    const row = taskRepo.update(userId, taskId, {
      assigneeAgentId: assignee.agentId,
      assigneeName: assignee.name,
      assigneeKind: assignee.kind
    })
    if (!row) throw new TaskError('not_found', 'Task not found')
    return toTaskDto(row)
  },

  /**
   * The markdown note the next agent reads. Exported to a file beside the task
   * in step 7 of the phase, and posted as a comment on a bound remote in step 9
   * — a file and a comment being the two places an agent might look.
   */
  setHandoffNote(userId: string, taskId: string, note: string | null): TaskDto {
    const task = requireTask(userId, taskId)
    requireRunsHere(userId, task)
    const row = taskRepo.update(userId, taskId, { handoffNote: note })
    if (!row) throw new TaskError('not_found', 'Task not found')
    return toTaskDto(row)
  },

  /**
   * Begin work: claim the device and move to `in_progress`.
   *
   * What it does **not** do yet is dispatch. Step 3 hangs the desktop branch
   * off it (spawn the chat, seed the prompt — `jobService.executeLocal`'s body
   * moves here unchanged), and step 9 the remote one (`adapter.create` +
   * `adapter.execute`). Until then this is the bookkeeping both branches will
   * share, which is the part that has to be right either way.
   */
  start(userId: string, taskId: string, opts: { chatId?: string | null } = {}): TaskDto {
    const task = requireTask(userId, taskId)
    const from = parseTaskStatus(task.status)
    if (!canTransition(from, 'in_progress')) {
      throw new TaskError('invalid_transition', `A ${from} task cannot be started`)
    }

    const patch: TaskPatch = statusPatch(task, 'in_progress')
    if (opts.chatId !== undefined) patch.chatId = opts.chatId
    if (task.executor === 'desktop') {
      // Starting is not a way to take a run off another device. Without this,
      // pressing Run on a synced row that device A is streaming right now would
      // silently rewrite the claim to B — and §5.4's invariant is that two
      // devices cannot both believe they own a run unless one of them *wrote*
      // that it did. `takeOver` is that write; this is not.
      requireRunsHere(userId, task)
      patch.executorDevice = thisDeviceId(userId)
    }

    const row = taskRepo.update(userId, taskId, patch)
    if (!row) throw new TaskError('not_found', 'Task not found')
    logger.info('task started', { taskId, executor: row.executor, chatId: row.chatId ?? undefined })
    return toTaskDto(row)
  },

  /**
   * Continue the task here — from a bound remote, or from another of the user's
   * devices.
   *
   * Deliberately **not** gated on {@link requireRunsHere}: a task running
   * elsewhere is the only kind there is anything to take over from. The refusal
   * that does belong here — a remote task mid-run must not be raced — needs the
   * adapter's view of its sessions and lands with the adapter in step 11.
   */
  takeOver(userId: string, taskId: string): TaskDto {
    const task = requireTask(userId, taskId)
    const executor: TaskExecutor = 'desktop'
    const row = taskRepo.update(userId, taskId, {
      executor,
      executorDevice: thisDeviceId(userId)
    })
    if (!row) throw new TaskError('not_found', 'Task not found')
    logger.info('task taken over', { taskId, from: task.executor, fromDevice: task.executorDevice })
    return toTaskDto(row)
  },

  /**
   * Hand the task to whatever is behind its binding.
   *
   * Only the executor flip and the device release live here. The adapter calls
   * that make it mean something — create, comment, assign, execute — are step
   * 11, each gated on the capability that covers it.
   */
  handOffToRemote(userId: string, taskId: string): TaskDto {
    const task = requireTask(userId, taskId)
    if (!task.remoteAdapter) {
      throw new TaskError('invalid_input', 'This task is not connected to a service')
    }
    const row = taskRepo.update(userId, taskId, { executor: 'remote', executorDevice: null })
    if (!row) throw new TaskError('not_found', 'Task not found')
    logger.info('task handed to remote', { taskId, adapter: task.remoteAdapter })
    return toTaskDto(row)
  },

  /**
   * A soft delete, so it can travel as a tombstone.
   *
   * Note what that means for `task_input_requests`: its `ON DELETE CASCADE`
   * never fires, because no row is ever removed. Its open asks survive the
   * delete, so the inbox query must exclude tasks with a `deletedAt` rather
   * than trust the foreign key (step 4).
   */
  remove(userId: string, taskId: string): void {
    requireTask(userId, taskId)
    taskRepo.softDelete(userId, taskId)
    logger.info('task deleted', { taskId })
  }
}
