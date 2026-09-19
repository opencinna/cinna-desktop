import { scriptRuntimeRepo } from '../db/scriptRuntimes'
import { validateTaskScript } from '../tasks/scriptRouter'
import { taskRuntimeRepo } from '../db/taskRuntimes'
import { taskRunnerBridge } from './taskRunnerBridge'
import { activeChatRunId, chatHardDeleted } from './chatRemoval'
import { runtimeBudget } from '../tasks/runtimeBudget'
import type { TaskArtifact, TaskBudget, TaskDeletePreview, TaskDeleteResult } from '../../shared/tasks'
import { getDb } from '../db/client'
import { taskHandoffRepo } from '../db/taskHandoffs'
import { taskInputRequestRepo } from '../db/taskInputRequests'
import { jobRunChatId, jobRunsRepo, jobsRepo, type JobRunRow } from '../db/jobs'
import { chatRepo } from '../db/chats'
import { syncRepo } from '../db/sync'
import {
  taskRepo,
  type TaskCreateInput,
  type TaskListFilter,
  type TaskPatch,
  type TaskRow,
  type TaskSyncValues
} from '../db/tasks'
import { TaskError } from '../errors'
import type { RemoteDirtyField } from '../tasks/adapters/adapter'
import { taskFileService } from './taskFileService'
import { createLogger } from '../logger/logger'
import {
  canTransition,
  jobRunStatusForTask,
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
 * `taskSyncService` reconciles with a bound adapter afterwards. That split is
 * what makes an unlinked profile, an offline laptop and a 500 the same code
 * path — and it is why the only thing this module does about a binding is
 * **write down what changed**. A mutation on a bound task adds its
 * {@link RemoteDirtyField} markers to `remote_dirty`; the push reads them,
 * sends what it can, and clears them. Nothing here ever talks to a network, so
 * a task edited on a laptop that is asleep, offline or unlinked still pushes
 * when it wakes.
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

/**
 * The job run a task's delete takes with it: the one `tasks.job_run_id` points
 * at, **only when it still exists and names this task back**. The column has
 * no foreign key, so a pointer at a run that belongs to another task must not
 * take that task's chat. Shared by `removeWithJobRun` and `deletePreview`, so
 * the confirm dialog cannot describe a different delete than the one that runs.
 */
function ownJobRun(userId: string, task: TaskRow): JobRunRow | undefined {
  if (!task.jobRunId) return undefined
  const run = jobRunsRepo.getById(userId, task.jobRunId)
  return run && run.taskId === task.id ? run : undefined
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
 * A task the ordinary start transition cannot reopen. An accepted follow-up
 * in a local chat has its separate, explicit resumeFinishedChat path.
 *
 * **Narrower than {@link isSettled}, and the difference is `error`.** The
 * transition table gives `error` a way out — `error → in_progress` is what the
 * task page's re-run is — so an errored task is one a device can still take a
 * turn on, which makes it one whose claim matters. `completed` and `cancelled`
 * reach nothing but `archived`, and `archived` reaches nothing at all.
 *
 * `adoptUnclaimed` is the caller, and it used `isSettled` — which skipped every
 * errored task, leaving `executor_device` null on exactly the rows the re-run
 * control is offered for. A null claim reads as "this device owns it" on every
 * device (step 10's second review finding), so two machines would both have
 * offered the re-run on one task. Found by the documenter, which noticed the
 * docstring named three statuses and the predicate matched a different three.
 */
function isUnstartable(status: TaskStatus): boolean {
  return status === 'completed' || status === 'cancelled' || status === 'archived'
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
 * Add a patch's remote-facing changes to `remote_dirty`, for a task that has a
 * remote to tell.
 *
 * A **read of `remoteAdapter`, never a comparison against one** — the question
 * is whether the task is bound at all, and which service it is bound to is the
 * adapter's business. That distinction is what the kind-branch ratchet's
 * `remoteAdapter` category is defined around.
 *
 * The markers accumulate rather than replace: a title edited twice before the
 * laptop comes back online is one marker, and a title edited while a *status*
 * push is still outstanding must not erase the status marker. `taskSyncService`
 * clears each one only when the remote has actually been told.
 *
 * An unbound task is left alone, so the column stays null for the overwhelming
 * majority of tasks and a later `bindRemote` starts from a clean slate.
 */
function dirtied(task: TaskRow, patch: TaskPatch, fields: readonly RemoteDirtyField[]): TaskPatch {
  if (!task.remoteAdapter || fields.length === 0) return patch
  const next = new Set<string>(task.remoteDirty ?? [])
  for (const field of fields) next.add(field)
  return { ...patch, remoteDirty: [...next] }
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
  /**
   * This device's sync id, from {@link thisDeviceId}. Required rather than
   * defaulted: the honest default would be `null`, which {@link taskRunsHere}
   * reads as "this device owns everything it can see" — so a caller that
   * forgot it would hand the renderer a write control over a run another
   * device is streaming, and nothing would look wrong.
   */
  thisDevice: string | null,
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
  const runtime = taskRuntimeRepo.get(row.userId, row.id) ?? scriptRuntimeRepo.info(row.userId, row.id, row.parentTaskId)
  return {
    id: row.id,
    ...(runtime ? { runtime: { controllerTaskId: runtime.controllerTaskId, state: runtime.state, reason: runtime.reason, ownerTurns: runtime.ownerTurns, elapsedMs: runtime.elapsedMs, budget: runtime.budget } } : {}),
    title: row.title,
    goal: row.goal,
    description: row.description,
    status: parseTaskStatus(row.status),
    priority: parseTaskPriority(row.priority),
    router: parseTaskRouter(row.router),
    script: row.script ?? null,
    origin: parseTaskOrigin(row.origin),
    executor: parseTaskExecutor(row.executor),
    executorDevice: row.executorDevice,
    // Computed here because the renderer cannot compute it: there is no IPC
    // channel for this device's sync id, and the rule that needs it is shared
    // (`taskRunsHere`) so that main and the renderer cannot drift about it.
    runsHere: taskRunsHere(
      { executor: parseTaskExecutor(row.executor), executorDevice: row.executorDevice },
      thisDevice
    ),
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

/**
 * The tail of every write: the row as a DTO, with its exported note in step.
 *
 * The export is here rather than in `setHandoffNote` alone — where §5.11 puts
 * it — because the frontmatter carries `title`, `status`, `assignee`, `parent`
 * and `updated`, and all five change from elsewhere. Exporting only on the note
 * write would leave a file claiming `in_progress` under a task that finished an
 * hour ago, which is worse than no file: nothing reads it back, so nothing
 * would ever correct it. Hanging it off every write instead means a file that
 * exists is current, and the cost is one filesystem call per task write.
 *
 * {@link taskFileService.exportHandoff} never throws and removes the file when
 * there is no note, so this is also the delete path for a note that was cleared.
 */
/** Mirror only the currently active attempt, never a historical run linked as provenance. */
function projectRemoteAttempt(userId: string, row: TaskRow): void {
  if (row.executor !== 'remote' || !row.jobRunId || taskHandoffRepo.unresolved(userId, row.id)) return
  const run = jobRunsRepo.getById(userId, row.jobRunId)
  if (!run || run.taskId !== row.id || !['pending', 'running'].includes(run.status)) return
  if (run.localChatId !== row.chatId) return
  const status = jobRunStatusForTask(parseTaskStatus(row.status))
  if (run.status !== status) jobRunsRepo.updateStatus(run.id, status, {
    errorMessage: status === 'failed' ? row.errorMessage : null
  })
}

function persistRemotePatch(userId: string, taskId: string, patch: TaskPatch): TaskRow {
  return getDb().transaction(() => {
    const row = taskRepo.update(userId, taskId, patch)
    if (!row) throw new TaskError('not_found', 'Task not found')
    projectRemoteAttempt(userId, row)
    return row
  })
}

function written(userId: string, row: TaskRow): TaskDto {
  const dto = toTaskDto(row, thisDeviceId(userId))
  taskFileService.exportHandoff(dto)
  taskRunnerBridge.taskChanged(userId, row.id)
  return dto
}

/**
 * What a pull may write, already translated out of the adapter's vocabulary.
 *
 * A `RemoteTaskSnapshot` is not passed in directly, and that is deliberate:
 * `parentId` on a snapshot is the *remote's* id for the parent, and turning it
 * into a local `parentTaskId` is a lookup only `taskSyncService` can do. This
 * keeps `taskService` free of the adapter's types apart from the one it cannot
 * avoid — the dirty-field names, which are what it writes.
 */
export interface RemoteSnapshotPatch {
  title?: string
  description?: string | null
  priority?: TaskPriority
  status?: TaskStatus
  assignee?: TaskAssignee
  /** A **local** task id, resolved by the caller, or null for a root task. */
  parentTaskId?: string | null
  errorMessage?: string | null
  /** The remote's own modification time. Not "now" — see the method comment. */
  updatedAt?: Date
  /** The identity half of the binding is not writable here; only what it displays. */
  binding?: { key: string | null; url: string | null; state: Record<string, unknown> }
}

/** What a caller may change about a task regardless of who is running it. */
export interface TaskFieldPatch {
  title?: string
  description?: string | null
  priority?: TaskPriority
  router?: TaskRouter
}

/**
 * A record from a peer, with the fields the peer was **not allowed to write**
 * replaced by what this device already has.
 *
 * The asymmetry this closes: {@link requireRunsHere} stops a device from
 * writing `status`, `assignee` and `handoffNote` for a task another device
 * holds — but `taskService.update` (title, description, priority, router) is
 * deliberately *not* gated, because fixing a title on the machine you are
 * looking at is not a claim on the run. App-sync is **whole-record**
 * last-writer-wins, so that ungated edit pushes the replica's whole row,
 * including its stale copy of the three guarded fields, under a newer
 * timestamp. The holder then applies its own stale state back over the state
 * its agent had just produced: a handoff note, a finish time and an error
 * reason destroyed on the one machine that had them.
 *
 * So the guard is applied on the way in as well as on the way out. It is
 * narrow on purpose — it holds only while **this device is the named holder
 * and the arriving record still agrees that it is**. A record that names a
 * different holder is a take-over, and the new holder's values are the ones
 * that count. A `null` claim confers nothing: it means nobody in particular,
 * and treating it as authority would let two devices each keep their own
 * version for ever with nothing to converge on.
 */
function respectingTheClaim(
  local: TaskRow | undefined,
  thisDevice: string | null,
  values: TaskSyncValues
): TaskSyncValues {
  if (!local || local.deletedAt) return values
  if (thisDevice === null) return values
  if (local.executor !== 'desktop' || values.executor !== 'desktop') return values
  if (local.executorDevice !== thisDevice) return values
  if (values.executorDevice !== local.executorDevice) return values
  return {
    ...values,
    status: local.status,
    startedAt: local.startedAt,
    finishedAt: local.finishedAt,
    errorMessage: local.errorMessage,
    handoffNote: local.handoffNote,
    artifacts: local.artifacts,
    budget: local.budget,
    assigneeAgentId: local.assigneeAgentId,
    assigneeName: local.assigneeName,
    assigneeKind: local.assigneeKind,
    assigneeRef: local.assigneeRef
  }
}


export const taskService = {
  list(userId: string, filter: TaskListFilter = {}): TaskDto[] {
    const rows = taskRepo.list(userId, filter)
    const counts = taskRepo.subtaskCounts(
      userId,
      rows.map((r) => r.id)
    )
    // One read of the device id for the whole page, not one per row.
    const device = thisDeviceId(userId)
    return rows.map((row) => toTaskDto(row, device, counts.get(row.id)))
  },

  getById(userId: string, taskId: string): TaskDto {
    const row = requireTask(userId, taskId)
    const counts = taskRepo.subtaskCounts(userId, [row.id]).get(row.id)
    return toTaskDto(row, thisDeviceId(userId), counts)
  },

  /** The row, unmapped. For main-process callers that need the remote binding. */
  getRow(userId: string, taskId: string): TaskRow {
    return requireTask(userId, taskId)
  },

  create(userId: string, input: TaskCreateInput): TaskDto {
    const title = nonEmpty(input.title, 'Title')
    const goal = nonEmpty(input.goal, 'Goal')
    const script = input.router === 'script' ? validateTaskScript(input.script) : null
    if (input.script != null && input.router !== 'script') throw new TaskError('invalid_input', 'A script definition requires the script router.')
    if (script && input.parentTaskId) throw new TaskError('nested_too_deep', 'A subtask cannot run a nested script.')

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
      script,
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
    return written(userId, row)
  },

  /**
   * Fields either side may write, whatever the executor is. No
   * {@link requireRunsHere} on purpose: fixing a title on the device you are
   * looking at is not a claim on the run.
   */
  update(userId: string, taskId: string, patch: TaskFieldPatch): TaskDto {
    const task = requireTask(userId, taskId)
    const next: TaskPatch = {}
    const dirty: RemoteDirtyField[] = []
    if (patch.title !== undefined) {
      next.title = nonEmpty(patch.title, 'Title')
      dirty.push('title')
    }
    if (patch.description !== undefined) {
      next.description = patch.description
      dirty.push('description')
    }
    if (patch.priority !== undefined) {
      next.priority = patch.priority
      dirty.push('priority')
    }
    // `router` is not in the list: it is how *this* app decides who answers in
    // the task's chat, and no remote has a field for it.
    if (patch.router !== undefined) {
      if (patch.router !== task.router && (patch.router === 'script' || task.router === 'script')) throw new TaskError('invalid_input', 'A task’s script router is fixed when the task is created.')
      next.router = patch.router
    }
    if (Object.keys(next).length === 0) return this.getById(userId, taskId)

    const row = taskRepo.update(userId, taskId, dirtied(task, next, dirty))
    if (!row) throw new TaskError('not_found', 'Task not found')
    return written(userId, row)
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

    const row = taskRepo.update(
      userId,
      taskId,
      dirtied(task, statusPatch(task, status, opts.errorMessage), ['status'])
    )
    if (!row) throw new TaskError('not_found', 'Task not found')
    if (isSettled(status) || status === 'archived') {
      taskInputRequestRepo.expireNextMessageForTask(taskId)
      // An idle next-message turn has no stream left to finalize its job.
      // Keep the attempt and its task consistent for explicit terminal writes.
      const run = task.jobRunId ? jobRunsRepo.getById(userId, task.jobRunId) : null
      if (run && (run.status === 'pending' || run.status === 'running')) {
        jobRunsRepo.updateStatus(run.id,
          status === 'completed' ? 'succeeded' : status === 'error' ? 'failed' : 'cancelled',
          { errorMessage: status === 'error' ? row.errorMessage : null })
      }
    }
    logger.info('task status', { taskId, from, to: status })
    return written(userId, row)
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
  /** Result facts from the remote executor, without claiming desktop execution. */
  acceptRemoteResult(userId: string, taskId: string, result: {
    status: TaskStatus
    handoffNote: string
    artifacts: TaskArtifact[]
    errorMessage?: string | null
  }): TaskDto {
    const task = requireTask(userId, taskId)
    const row = persistRemotePatch(userId, taskId, {
      ...statusPatch(task, result.status, result.errorMessage),
      handoffNote: result.handoffNote,
      artifacts: result.artifacts
    })
    return written(userId, row)
  },

  acceptRemoteStatus(userId: string, taskId: string, status: TaskStatus): TaskDto {
    const task = requireTask(userId, taskId)
    const row = persistRemotePatch(userId, taskId, statusPatch(task, status))
    if (!row) throw new TaskError('not_found', 'Task not found')
    if (parseTaskStatus(task.status) !== status) {
      logger.info('task status pulled', { taskId, from: task.status, to: status })
    }
    return written(userId, row)
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
    return toTaskDto(task, thisDeviceId(userId))
  },

  /**
   * An accepted user follow-up starts new work in an ordinary chat's task.
   * Only the acceptance path calls this: late run events still cannot reopen
   * completed work through applyRunState. Job/remote/archived tasks keep their
   * separate lifecycle and cannot be restarted through a chat message.
   */
  resumeFinishedChat(userId: string, taskId: string, chatId: string): TaskDto {
    const task = requireTask(userId, taskId)
    requireRunsHere(userId, task)
    if (task.chatId !== chatId || task.origin !== 'local' || task.executor !== 'desktop' ||
      task.jobId || task.jobRunId || task.remoteAdapter || task.router === 'script' ||
      !['completed', 'cancelled', 'error'].includes(task.status)) {
      throw new TaskError('invalid_transition', 'This task cannot be continued through this chat.')
    }
    const row = taskRepo.update(userId, taskId, {
      ...statusPatch(task, 'in_progress'), executorDevice: thisDeviceId(userId)
    })
    if (!row) throw new TaskError('not_found', 'Task not found')
    return written(userId, row)
  },

  setAssignee(userId: string, taskId: string, assignee: TaskAssignee): TaskDto {
    const task = requireTask(userId, taskId)
    requireRunsHere(userId, task)
    const row = taskRepo.update(
      userId,
      taskId,
      dirtied(
        task,
        {
          assigneeAgentId: assignee.agentId,
          assigneeName: assignee.name,
          assigneeKind: assignee.kind
        },
        ['assignee']
      )
    )
    if (!row) throw new TaskError('not_found', 'Task not found')
    return written(userId, row)
  },

  /** Bind a new desktop conversation inside its first message's transaction. */
  beginDesktopChat(userId: string, taskId: string, chatId: string, assignee: TaskAssignee): TaskDto {
    const task = requireTask(userId, taskId)
    requireRunsHere(userId, task)
    if (!canTransition(parseTaskStatus(task.status), 'in_progress')) {
      throw new TaskError('invalid_transition', `A ${task.status} task cannot be started`)
    }
    const row = taskRepo.update(userId, taskId, dirtied(task, {
      ...statusPatch(task, 'in_progress'),
      chatId,
      router: 'direct',
      executorDevice: thisDeviceId(userId),
      assigneeAgentId: assignee.agentId,
      assigneeName: assignee.name,
      assigneeKind: assignee.kind,
      assigneeRef: null
    }, ['status', 'assignee']))
    if (!row) throw new TaskError('not_found', 'Task not found')
    // Export after acceptance commits; a filesystem write cannot roll back.
    return toTaskDto(row, thisDeviceId(userId))
  },

  setRuntimeBudget(userId: string, taskId: string, budget: TaskBudget): TaskDto {
    const task = requireTask(userId, taskId)
    requireRunsHere(userId, task)
    const row = taskRepo.update(userId, taskId, { budget: runtimeBudget(budget) })
    if (!row) throw new TaskError('not_found', 'Task not found')
    return written(userId, row)
  },

  setArtifacts(userId: string, taskId: string, artifacts: TaskArtifact[]): TaskDto {
    const task = requireTask(userId, taskId)
    requireRunsHere(userId, task)
    const row = taskRepo.update(userId, taskId, { artifacts })
    if (!row) throw new TaskError('not_found', 'Task not found')
    return written(userId, row)
  },

  /**
   * The markdown note the next agent reads. Exported to a file beside the task
   * in step 7 of the phase, and posted as a comment on a bound remote in step 9
   * — a file and a comment being the two places an agent might look.
   */
  setHandoffNote(userId: string, taskId: string, note: string | null): TaskDto {
    const task = requireTask(userId, taskId)
    requireRunsHere(userId, task)
    const row = taskRepo.update(userId, taskId, dirtied(task, { handoffNote: note }, ['handoffNote']))
    if (!row) throw new TaskError('not_found', 'Task not found')
    return written(userId, row)
  },

  /**
   * Record which job run is executing this task.
   *
   * Its own writer, and a small one, because the ordering is not the same on
   * both paths. A local run creates the chat and the run row before the task,
   * so `create` carries `jobRunId` — a task created *first* cannot, and a
   * `cinna_task` run has to be created first: the adapter is given the task's
   * own id as `external_ref`, which is what makes a retried create idempotent.
   *
   * Not part of {@link taskService.update}, which is the set of fields a person
   * edits and is deliberately ungated by the claim (§5.4). This is provenance:
   * written once, by the code that made both rows.
   */
  linkJobRun(userId: string, taskId: string, jobRunId: string): TaskDto {
    requireTask(userId, taskId)
    const row = taskRepo.update(userId, taskId, { jobRunId })
    if (!row) throw new TaskError('not_found', 'Task not found')
    return written(userId, row)
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

    const row = taskRepo.update(userId, taskId, dirtied(task, patch, ['status']))
    if (!row) throw new TaskError('not_found', 'Task not found')
    logger.info('task started', { taskId, executor: row.executor, chatId: row.chatId ?? undefined })
    return written(userId, row)
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
    return written(userId, row)
  },

  /**
   * Hand the task to whatever is behind its binding.
   *
   * Only the executor flip and the device release live here. The adapter calls
   * that make it mean something — create, comment, assign, execute — are step
   * 11, each gated on the capability that covers it.
   */
  handOffToRemote(userId: string, taskId: string, accepted?: {
    assignee: TaskAssignee | null
    executed: boolean
    note: string | null
    remaining: RemoteDirtyField[]
    binding: { key: string | null; url: string | null; state: Record<string, unknown> }
    deferExport?: boolean
  }): TaskDto {
    const task = requireTask(userId, taskId)
    if (!task.remoteAdapter) {
      throw new TaskError('invalid_input', 'This task is not connected to a service')
    }
    const row = taskRepo.update(userId, taskId, {
      executor: 'remote', executorDevice: null,
      ...(accepted && {
        ...(accepted.executed ? statusPatch(task, 'in_progress') : {}),
        ...(accepted.assignee && {
          assigneeKind: accepted.assignee.kind, assigneeAgentId: accepted.assignee.agentId,
          assigneeName: accepted.assignee.name, assigneeRef: null
        }),
        handoffNote: accepted.note,
        remoteDirty: accepted.remaining.length ? accepted.remaining : null,
        remoteKey: accepted.binding.key, remoteUrl: accepted.binding.url, remoteState: accepted.binding.state,
        remoteSyncedAt: new Date()
      })
    })
    if (!row) throw new TaskError('not_found', 'Task not found')
    logger.info('task handed to remote', { taskId, adapter: task.remoteAdapter })
    return accepted?.deferExport ? toTaskDto(row, thisDeviceId(userId)) : written(userId, row)
  },

  /**
   * Record the binding a remote `create` just invented.
   *
   * **The only writer of the five `remote_*` identity columns**, and the reason
   * it is here rather than in `taskSyncService` is `written()`: `remoteKey` is
   * one of the six columns the exported handoff note carries in its
   * frontmatter, so a binding written through the repo directly would leave
   * every bound task's file claiming the wrong short code with nothing that
   * could ever correct it. `taskService.test.ts` pins the list of methods that
   * end in `written()`, which is what makes that a rule rather than a habit.
   *
   * The dirty markers are cleared: a create sends every field the remote takes,
   * so at this instant the two copies agree about everything except a status
   * the remote assigns itself. What the remote's status *is* is not assumed —
   * {@link taskSyncService} asks before it pushes a path.
   */
  bindRemote(
    userId: string,
    taskId: string,
    binding: {
      adapter: string
      id: string
      key: string | null
      url: string | null
      state: Record<string, unknown>
    }
  ): TaskDto {
    requireTask(userId, taskId)
    const row = taskRepo.update(userId, taskId, {
      remoteAdapter: binding.adapter,
      remoteId: binding.id,
      remoteKey: binding.key,
      remoteUrl: binding.url,
      remoteState: binding.state,
      remoteSyncedAt: new Date(),
      remoteDirty: null
    })
    if (!row) throw new TaskError('not_found', 'Task not found')
    logger.info('task bound to a service', { taskId, adapter: binding.adapter })
    return written(userId, row)
  },

  /**
   * The task is not on that service any more — drop the binding and keep the
   * task.
   *
   * Reached only from a `not_ours`, which an adapter answers only when it is
   * sure (a 404, or a refusal it has positively identified as an ownership
   * one). Everything the user can see is local and survives: the goal, the
   * status, the note, the history. What goes is the claim that a copy exists
   * somewhere else, which had stopped being true.
   *
   * `executor` is deliberately **not** moved back to `desktop`. A task that was
   * running remotely is not now running here, and pretending otherwise would
   * put a Stop button over nothing. §5.10's Take over is the write that moves
   * it, and it is a person's decision.
   */
  unbindRemote(userId: string, taskId: string, reason: string, options: { confirmedMissing?: boolean } = {}): TaskDto {
    const task = requireTask(userId, taskId)
    const row = getDb().transaction(() => {
      const row = taskRepo.update(userId, taskId, {
        remoteAdapter: null, remoteId: null, remoteKey: null, remoteUrl: null,
        remoteState: null, remoteSyncedAt: null, remoteDirty: null
      })
      if (!row) throw new TaskError('not_found', 'Task not found')
      // Losing remote evidence ends only the current remote attempt. Keep the
      // Task's last known status and executor; unbinding is not a local restart.
      const run = task.jobRunId ? jobRunsRepo.getById(userId, task.jobRunId) : null
      if (options.confirmedMissing && task.remoteAdapter && task.remoteId && task.executor === 'remote' && run &&
          run.taskId === taskId && run.localChatId === task.chatId &&
          ['pending', 'running'].includes(run.status) && !taskHandoffRepo.unresolved(userId, taskId)) {
        jobRunsRepo.updateStatus(run.id, 'failed', {
          errorMessage: run.errorMessage ?? 'That task is no longer bound to the service that was running it.'
        })
      }
      return row
    })
    logger.warn('task unbound from its service', {
      taskId,
      adapter: task.remoteAdapter ?? undefined,
      reason
    })
    return written(userId, row)
  },

  /**
   * What is still owed to the remote after a push pass.
   *
   * `remaining` is the markers that did **not** get through — an empty list
   * means the two copies agree and the column goes back to null.
   */
  markRemoteSynced(
    userId: string,
    taskId: string,
    remaining: readonly RemoteDirtyField[],
    opts: {
      binding?: { key: string | null; url: string | null; state: Record<string, unknown> }
      /**
       * Did anything actually reach the service?
       *
       * `remoteSyncedAt` means "when this device last got an answer about this
       * task", and it is the only thing that could ever tell a stale binding
       * from a quiet one. Stamping it on a pass that sent nothing — because
       * every marker turned out to name a field this remote has no room for —
       * would make it advance for ever on a service nobody can reach, which is
       * the one reading it exists to rule out. A *refusal* counts: the server
       * answered.
       */
      contacted?: boolean
    } = {}
  ): TaskDto {
    const task = requireTask(userId, taskId)
    const { binding, contacted } = opts
    const patch: TaskPatch = {
      remoteDirty: remaining.length > 0 ? [...remaining] : null,
      // **Bookkeeping must not look like a change.** `taskRepo.update` stamps
      // `updatedAt` unless it is given one, and `taskRepo.list` orders by it —
      // so clearing a marker would float a task nobody touched to the top of
      // the user's list every time a push succeeded. Worse, `remote_dirty` and
      // `remote_synced_at` are per-device bookkeeping that deliberately never
      // syncs, and bumping a *synced*, user-facing timestamp on their account
      // to record them is exactly the "a mirror that always looks newer than
      // the thing it mirrors wins every conflict it should lose" that
      // `applyRemoteSnapshot` is careful to avoid.
      updatedAt: task.updatedAt
    }
    if (contacted) patch.remoteSyncedAt = new Date()
    // Every adapter call hands back the binding it was given, possibly
    // refreshed — a short code the server has since minted, a session it is now
    // answering on. The identity half (`adapter`, `id`) is not writable here:
    // only `create` invents one, and a push that could re-identify a task is a
    // push that could silently fork it.
    if (binding !== undefined) {
      patch.remoteKey = binding.key
      patch.remoteUrl = binding.url
      patch.remoteState = binding.state
    }
    const row = taskRepo.update(userId, taskId, patch)
    if (!row) throw new TaskError('not_found', 'Task not found')
    return written(userId, row)
  },

  /**
   * Write what a pull brought back.
   *
   * Two rules, and both are about not destroying a local edit:
   *
   *  - **a field this device still owes the remote is not overwritten.** The
   *    markers in `remote_dirty` are exactly "we know something it does not",
   *    so taking the remote's value for one of them would throw away the user's
   *    change moments before it was going to be sent. The push clears the
   *    marker; until then the local value wins.
   *  - **`updatedAt` is the remote's**, not now. §5.4 reconciles per field on
   *    it, and a mirror that always looked newer than the thing it mirrors
   *    would win every conflict it should lose.
   *
   * The status is taken as fact — no transition check. cinna's own session
   * handlers bypass its table, so a replica can arrive in a state the table
   * calls unreachable, and arguing with the system doing the work is how the
   * desktop would become the one corrupting state.
   */
  applyRemoteSnapshot(userId: string, taskId: string, patch: RemoteSnapshotPatch): TaskDto {
    const task = requireTask(userId, taskId)
    const owed = new Set<string>(task.remoteDirty ?? [])
    const next: TaskPatch = {}

    if (patch.title !== undefined && !owed.has('title')) next.title = patch.title
    if (patch.description !== undefined && !owed.has('description')) {
      next.description = patch.description
    }
    if (patch.priority !== undefined && !owed.has('priority')) next.priority = patch.priority
    if (patch.assignee !== undefined && !owed.has('assignee')) {
      next.assigneeAgentId = patch.assignee.agentId
      next.assigneeName = patch.assignee.name
      next.assigneeKind = patch.assignee.kind
    }
    // `errorMessage` is part of the status, not a field beside it — `statusPatch`
    // is what writes it — so it is protected by the *same* marker. Letting it
    // through on its own was a real hole: `taskSyncService` always sends an
    // `errorMessage` (null when the remote has none), so a task that had just
    // failed here would have its reason wiped by the very next poll, before the
    // status push that carries it had even left. Neither the status path nor
    // cinna has a field for the text, so nothing would ever put it back: a task
    // reading `error` that can no longer say why.
    if (!owed.has('status')) {
      if (patch.status !== undefined) {
        Object.assign(next, statusPatch(task, patch.status, patch.errorMessage))
      } else if (patch.errorMessage !== undefined) {
        next.errorMessage = patch.errorMessage
      }
    }
    if (patch.parentTaskId !== undefined) next.parentTaskId = patch.parentTaskId
    if (patch.binding !== undefined) {
      next.remoteKey = patch.binding.key
      next.remoteUrl = patch.binding.url
      next.remoteState = patch.binding.state
    }
    next.remoteSyncedAt = new Date()
    if (patch.updatedAt !== undefined) next.updatedAt = patch.updatedAt

    const row = persistRemotePatch(userId, taskId, next)
    if (!row) throw new TaskError('not_found', 'Task not found')
    return written(userId, row)
  },

  /** Repair imported aliases and keep derived local views in step. */
  reconcileRemoteReplicas(userId: string, adapter: string, remoteId: string): void {
    for (const id of taskRepo.reconcileRemoteBinding(userId, adapter, remoteId)) {
      const changed = taskRepo.getById(userId, id)
      if (changed?.deletedAt) taskFileService.removeHandoff(id)
      else if (changed) written(userId, changed)
    }
  },

  /**
   * Write a task that arrived from another of the user's devices.
   *
   * The app-sync apply path, and the reason it is a `taskService` method rather
   * than a `taskRepo` call from `sync/collections.ts`: **the exported handoff
   * note has to follow the row**. Every local mutation ends in `written()`
   * precisely so a file under `<userData>/tasks/` is never left claiming a
   * status an hour out of date, and a row that arrives from a peer changes the
   * same six frontmatter fields that a local edit does. Going round the service
   * would also have resurrected a deleted task's file, which is why
   * `taskRepo.update` grew its own `deletedAt` filter — a second lock on the
   * same door, not a substitute for this one.
   *
   * What it deliberately does **not** do is validate. There is no transition
   * check (the peer is reporting what happened on the device that was running
   * the work, exactly as {@link taskService.acceptRemoteStatus} is), no
   * `requireRunsHere` (a replica of a task another device is running is the
   * whole point), and no one-level parent check (a peer that broke that rule
   * has already broken it; refusing the row here would only make the two
   * devices disagree for ever). The rules this module enforces are about what
   * *this* device may initiate.
   *
   * It does validate **one** thing, and it is not a rule about vocabulary:
   * {@link respectingTheClaim} keeps the fields a peer was never allowed to
   * write for a task this device holds. Whole-record last-writer-wins is what
   * makes that necessary — see that function.
   *
   * Returns null when nothing was written — which {@link taskRepo.upsertFromSync}
   * reports rather than this inferring it, because the one refusal it makes
   * (an id that belongs to a different profile on this install) is the sort of
   * thing a log should name only when it was the thing that happened.
   */
  applySyncedTask(userId: string, values: TaskSyncValues): TaskDto | null {
    const device = thisDeviceId(userId)
    if (values.parentTaskId) {
      const parent = taskRepo.getById(userId, values.parentTaskId)
      if (parent?.remoteAdapter && parent.remoteId) {
        const canonical = taskRepo.getByRemote(userId, parent.remoteAdapter, parent.remoteId)
        if (canonical) values = { ...values, parentTaskId: canonical.id }
      }
    }
    const local = taskRepo.getById(userId, values.id)
    // Branch on the check that was actually made, not on a read-back that came
    // up empty: the two coincide today only because `getById` does not filter
    // `deletedAt`, and a warning that names a second profile the reader then
    // cannot find is worse than no warning at all.
    if (!taskRepo.upsertFromSync(userId, respectingTheClaim(local, device, values))) {
      logger.warn('a synced task was refused: that id belongs to another profile', {
        taskId: values.id
      })
      return null
    }
    if (values.remoteAdapter && values.remoteId) this.reconcileRemoteReplicas(userId, values.remoteAdapter, values.remoteId)
    const row = taskRepo.getById(userId, values.id)
    if (!row) {
      // Not reachable: the upsert above reported that it wrote. Logged rather
      // than thrown because this runs inside the sync drain, where one bad
      // record must not stall the rest of the page.
      logger.error('a synced task vanished between its write and the read back', {
        taskId: values.id
      })
      return null
    }
    const dto = toTaskDto(row, device)
    // A delete that arrived from a peer takes the file with it, the same way a
    // local `remove` does. `exportHandoff` already removes the file when there
    // is no note, but a *deleted* task with a note still has one.
    if (row.deletedAt) taskFileService.removeHandoff(row.id)
    else taskFileService.exportHandoff(dto)
    taskRunnerBridge.taskChanged(userId, row.id)
    return dto
  },

  /**
   * Give this device's freshly-minted sync id to every task that was claimed by
   * nobody in particular.
   *
   * **A null `executor_device` means two different things, and they were the
   * same value.** {@link taskRunsHere} reads it as "here" — correctly, while a
   * profile has no sync identity, because there is no other device that could
   * disagree. The moment one is enrolled that stops being true: those tasks
   * sync with a null claim and read as *mine* on every device the account has,
   * so §5.4's "two devices cannot both believe they own a run" does not hold
   * for any task created before sync was switched on. Pressing Run on the
   * second device passes `requireRunsHere` and starts a second run of a task
   * the first is already streaming.
   *
   * So enrolment is where "nobody's" becomes "this device's". Any device that
   * enrols later gets a different id and correctly sees these as somebody
   * else's; a device restored from a backup receives them already claimed, so
   * there is nothing null left for it to adopt.
   *
   * Tasks no run can start from are skipped — `completed`, `cancelled` and
   * `archived`, which reach nothing but `archived` in the transition table. A
   * profile's history is most of its tasks, and claiming them would bump
   * `updated_at` on all of it to write a claim nobody will read.
   *
   * **`error` is adopted**, and it is the one this filter got wrong at first:
   * it used {@link isSettled}, which counts `error` as stopped. It is stopped,
   * and it is not finished — `error → in_progress` is the task page's re-run —
   * so an errored task left with a null claim reads as "mine" on every device
   * and two of them offer that re-run. See {@link isUnstartable}.
   *
   * Returns how many it adopted, for the log.
   */
  adoptUnclaimed(userId: string, deviceId: string): number {
    // `list` already excludes soft-deleted and archived rows.
    const unclaimed = taskRepo
      .list(userId, { executor: 'desktop' })
      .filter((row) => row.executorDevice === null && !isUnstartable(parseTaskStatus(row.status)))
    for (const row of unclaimed) {
      const next = taskRepo.update(userId, row.id, { executorDevice: deviceId })
      if (next) written(userId, next)
    }
    if (unclaimed.length > 0) {
      logger.info('unclaimed tasks adopted by this device', {
        count: unclaimed.length,
        deviceId
      })
    }
    return unclaimed.length
  },

  /**
   * Apply a **tombstone** for a task — a pulled sync record with no payload at
   * all, which means the row itself is gone on the device that sent it.
   *
   * Unreachable from anything this build writes: a task's only delete is
   * {@link taskService.remove}, which is soft and travels as an ordinary
   * upsert. It exists because `CollectionMapper.apply` has a null-plaintext arm
   * that every collection must answer, and because a record a mapper ignores is
   * a record the server hands back on every pull for ever.
   */
  removeSyncedTask(userId: string, taskId: string): void {
    // **The file goes only if a row of ours did.** `deleteOwned` is scoped to
    // the profile; `taskFileService.removeHandoff` is keyed on the task id
    // alone, and `<userData>/tasks/` is shared by every profile on this
    // install — so a tombstone carrying an id that belongs to a *different*
    // profile would leave that profile's row intact and delete its note, with
    // nothing that could ever put the file back.
    if (taskRepo.deleteOwned(userId, taskId)) {
      taskFileService.removeHandoff(taskId)
      taskRunnerBridge.taskChanged(userId, taskId)
    }
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
    taskRunnerBridge.taskChanged(userId, taskId)
    // The row survives as a tombstone; the file is a view of a task the user
    // can no longer open, so it goes. A soft delete is still a delete to
    // anything reading the folder.
    taskFileService.removeHandoff(taskId)
    logger.info('task deleted', { taskId })
  },

  /**
   * What Delete task would remove, for the confirm dialog to say before it
   * opens (`ux_rules.md` §5). Read-only, and decided by `ownJobRun` — the same
   * predicate `removeWithJobRun` deletes by — so the copy and the delete cannot
   * disagree about whether the run and its chat go.
   */
  deletePreview(userId: string, taskId: string): TaskDeletePreview {
    const task = requireTask(userId, taskId)
    const run = ownJobRun(userId, task)
    // A job is soft-deleted and keeps its runs, so "the job stays" is only
    // true of one that is still live.
    const jobId = run?.jobId ?? task.jobId
    const job = jobId ? jobsRepo.getById(userId, jobId) : undefined
    const jobStays = !!job && !job.deletedAt
    if (run) {
      // Hard-deleted with the run wherever it is, the Trash included.
      const chatId = jobRunChatId(run)
      const chat = chatId ? chatRepo.getOwned(userId, chatId) : undefined
      return { deletesRun: true, chat: chat ? 'deleted_with_run' : 'none', jobStays }
    }
    const chat = task.chatId ? chatRepo.getOwned(userId, task.chatId) : undefined
    return {
      deletesRun: false,
      chat: !chat ? 'none' : chat.deletedAt ? 'in_trash' : 'kept',
      jobStays
    }
  },

  /**
   * The user's Delete task: the task, and — when a job run that still exists
   * produced it — that run and the run's chat, the way Delete run removes them
   * (`jobRunsRepo.deleteWithChat`). Any other task goes alone, and its chat
   * stays.
   *
   * **One transaction, so neither half can be left done without the other.**
   * The tombstone and the run's hard delete commit together; a run that
   * vanished between the read and the delete throws inside the transaction,
   * which rolls the tombstone back. Everything that is not SQLite — the runner
   * hooks and the handoff file — happens only after the commit, so a failure
   * never leaves a file removed for a task that is still there.
   *
   * The run counts only when it names this task back. `tasks.job_run_id` has no
   * foreign key; a pointer at a run that belongs to another task must not take
   * that task's chat with it.
   */
  removeWithJobRun(userId: string, taskId: string): Omit<TaskDeleteResult, 'success'> {
    const task = requireTask(userId, taskId)
    // Refused before any write while a turn still works in the chat that
    // would go with the run — the guard chatService.delete has.
    const ownRun = ownJobRun(userId, task)
    const runChatId = ownRun ? jobRunChatId(ownRun) : null
    if (runChatId && activeChatRunId(runChatId)) {
      throw new TaskError('run_active', 'This run is still going. Stop it first; nothing was deleted.')
    }
    const outcome = getDb().transaction(() => {
      if (!taskRepo.softDelete(userId, taskId)) throw new TaskError('not_found', 'Task not found')
      const run = ownJobRun(userId, task)
      if (!run) {
        return { jobRunId: null, jobId: null, chatId: null, chatDeleted: false }
      }
      const deleted = jobRunsRepo.deleteWithChat(userId, run.id)
      if (!deleted.runDeleted) throw new TaskError('not_found', 'The job run behind this task could not be deleted.')
      return { jobRunId: run.id, jobId: run.jobId, chatId: deleted.chatId, chatDeleted: deleted.chatDeleted }
    })
    taskRunnerBridge.taskChanged(userId, taskId)
    // The same release `jobService.deleteRun` does, so a waiting script cannot
    // keep gates on a chat that is gone and no session or conductor outlives it.
    if (outcome.chatDeleted && outcome.chatId) chatHardDeleted(userId, outcome.chatId)
    taskFileService.removeHandoff(taskId)
    logger.info('task deleted', { taskId, ...outcome })
    return outcome
  }
}
