import type { JobRunStatus } from './jobs'
/**
 * The task status vocabulary — **cinna-core's, copied here as data**.
 *
 * ## Why not A2A's
 *
 * A run's state (`RunState` in `runEvents.ts`) is A2A-shaped, because a run is
 * what A2A models: one prompt, one stream, one stop reason. A *task* is a
 * different concept — it outlives a run, it can be handed to someone else, and
 * it has a status a human reads in a list. cinna-core already runs a full task
 * system with exactly that vocabulary: nine statuses, a transition table, a
 * status history and comments. Its set is a superset of A2A's.
 *
 * So the desktop speaks cinna's vocabulary and A2A maps *in*, at the a2a
 * driver, which already speaks A2A. One mapping at the edge that owns it,
 * rather than a mapping table in the middle and two vocabularies drifting.
 *
 * The two concepts meet in exactly one place: {@link taskStatusForRunState}.
 *
 * ## Validate on write, accept on read
 *
 * {@link canTransition} gates a transition the **desktop initiates**. A status
 * arriving from a pull is taken as fact through {@link parseTaskStatus}, with
 * no transition check — cinna's own session handlers bypass its table (they
 * call `update_status`, not `update_task_status`), so a replica can legitimately
 * arrive in a state the table says is unreachable. Refusing it would make the
 * desktop the one corrupting state.
 *
 * Pure type-only module plus constants and total functions: imported from both
 * Electron processes and the renderer, so it must pull in no runtime
 * dependency and must not log. A caller that wants to report an unknown status
 * asks {@link isTaskStatus} first — that is the deliberate difference from the
 * phase plan, which had `parseTaskStatus` log once and could not, here.
 */
import type { RunState } from './runEvents'

/**
 * Where a task is.
 *
 * Copied from cinna-core `InputTaskStatus` (`backend/app/models/tasks/
 * input_task.py`). `running` and `pending_input` are *migrated aliases* there,
 * not statuses — the server rewrote them to `in_progress` and `blocked`, and
 * they never reach a client.
 *
 *  - `new` — created, not yet assigned or refined. The create state.
 *  - `refining` — a human is shaping the goal with an AI on cinna's web UI.
 *    **Never written by the desktop** (there is no refinement flow here), but
 *    accepted on read, because a replica of a cinna task can be in it.
 *  - `open` — described and assigned, ready to be picked up.
 *  - `in_progress` — someone is working on it, here or elsewhere.
 *  - `blocked` — waiting on a human. This is the inbox's status.
 *  - `completed` / `error` / `cancelled` — terminal, until archived.
 *  - `archived` — the user filed it away. The only status with no way out.
 */
export type TaskStatus =
  | 'new'
  | 'refining'
  | 'open'
  | 'in_progress'
  | 'blocked'
  | 'completed'
  | 'error'
  | 'cancelled'
  | 'archived'

/** Every status, in lifecycle order. Iteration order is not semantic. */
export const TASK_STATUSES: readonly TaskStatus[] = [
  'new',
  'refining',
  'open',
  'in_progress',
  'blocked',
  'completed',
  'error',
  'cancelled',
  'archived'
]

/** What a task row's `status` column starts at, and what an unreadable value means. */
export const DEFAULT_TASK_STATUS: TaskStatus = 'new'

/**
 * The transition table, copied verbatim from cinna-core
 * `InputTaskStatus.VALID_TRANSITIONS` (`backend/app/models/tasks/
 * input_task.py:41`, read at `793782a3`).
 *
 * Pinned by `taskStatus.test.ts`. It is a copy on purpose — the desktop must be
 * able to refuse an impossible transition with no network — and the test exists
 * so the copy is a decision someone made rather than a divergence nobody
 * noticed. If the server widens the table, copy the change; do not diverge.
 *
 * Two properties worth naming, because code depends on both:
 *  - **`new` cannot reach a terminal state.** A task that finishes in two
 *    seconds still has to pass through `in_progress`. That is why a remote push
 *    sends the *path*, not the destination (phase 5 §5.12 rule 2).
 *  - **`archived` is a sink.** Every other status can reach it; it reaches
 *    nothing.
 */
export const VALID_TRANSITIONS: Record<TaskStatus, readonly TaskStatus[]> = {
  new: ['refining', 'open', 'in_progress', 'cancelled', 'archived'],
  refining: ['new', 'open', 'in_progress', 'archived'],
  open: ['in_progress', 'cancelled', 'archived'],
  in_progress: ['completed', 'blocked', 'cancelled', 'error', 'archived'],
  blocked: ['in_progress', 'cancelled', 'archived'],
  completed: ['archived'],
  error: ['new', 'in_progress', 'archived'],
  cancelled: ['archived'],
  archived: []
}

/**
 * Moves a **person** may make by hand that the remote table does not have —
 * the Tasks board's and Edit task's Backlog / Ready / Done.
 *
 * A person may reshuffle and close work that lives only on this desktop: no
 * remote table has to agree, so `open → new` (back to Backlog) and closing a
 * task that never started are just bookkeeping. A **bound** task keeps
 * {@link VALID_TRANSITIONS} unchanged, because `taskStatusPath` must push the
 * remote a sequence of legal steps and these pairs have none.
 */
export const MANUAL_TRANSITIONS: Readonly<Partial<Record<TaskStatus, readonly TaskStatus[]>>> = {
  new: ['open', 'completed'],
  open: ['new', 'completed']
}

/** Is this pair one only the manual overlay allows (not in the remote table)? */
export function isManualOnlyTransition(from: TaskStatus, to: TaskStatus): boolean {
  return !canTransition(from, to) && (MANUAL_TRANSITIONS[from]?.includes(to) ?? false)
}

/**
 * May a person move a task from `from` to `to`? The remote table, plus
 * {@link MANUAL_TRANSITIONS} for a task bound to no service.
 */
export function canTransitionManually(from: TaskStatus, to: TaskStatus, opts: { bound: boolean }): boolean {
  return canTransition(from, to) || (!opts.bound && isManualOnlyTransition(from, to))
}

/**
 * The statuses a **user-authenticated** client may push to cinna-core through
 * `POST /api/v1/tasks/{id}/status` (`allowed_user_statuses` in
 * `input_task_service.update_task_status_from_user`).
 *
 * Narrower than {@link TaskStatus}: `new` is the create state, `refining`
 * belongs to the refine flow, and `archived` has its own route
 * (`POST /{id}/archive`) because it owns `archived_at`.
 *
 * It lives here rather than in the cinna adapter because it is the *shape of
 * the vocabulary* — the adapter maps `archived` onto the archive route, and
 * anything else outside this set never leaves the process.
 */
export const REMOTE_WRITABLE_STATUSES: readonly TaskStatus[] = [
  'open',
  'in_progress',
  'blocked',
  'completed',
  'error',
  'cancelled'
]

export function isTaskStatus(value: unknown): value is TaskStatus {
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(VALID_TRANSITIONS, value)
}

/**
 * May the desktop move a task from `from` to `to`?
 *
 * A no-op transition (`from === to`) is allowed: re-reporting the status a task
 * is already in is idempotent, not an error, and the callers that would
 * otherwise have to special-case it are every one of them.
 */
export function canTransition(from: TaskStatus, to: TaskStatus): boolean {
  if (from === to) return true
  return VALID_TRANSITIONS[from].includes(to)
}

/**
 * A status off the wire, as a {@link TaskStatus}.
 *
 * An unknown value — a newer server, or a status this build predates — becomes
 * `in_progress` rather than throwing or becoming `new`: the task exists and
 * something is presumably happening to it, and `in_progress` is the one status
 * from which every other one is still reachable. Guessing `new` would let the
 * desktop try transitions the server would refuse.
 *
 * Pure: it cannot log (see the module comment). A caller that wants to report
 * the unknown value asks {@link isTaskStatus} first.
 */
export function parseTaskStatus(raw: string | null | undefined): TaskStatus {
  return isTaskStatus(raw) ? raw : 'in_progress'
}

/**
 * Where a run leaves its task.
 *
 * The single bridge between the two vocabularies (see the module comment).
 * `unknown` is an A2A state this build does not know — the run is presumably
 * still happening, so the task stays `in_progress`, the same reasoning
 * {@link parseTaskStatus} uses.
 *
 * `rejected` maps to `cancelled` rather than `error`: the agent declined the
 * work, which is a decision, not a failure, and `error` is a status the user is
 * invited to retry from.
 */
export function taskStatusForRunState(state: RunState): TaskStatus {
  switch (state) {
    case 'submitted':
      return 'open'
    case 'working':
      return 'in_progress'
    case 'needs_input':
      return 'blocked'
    case 'completed':
      return 'completed'
    case 'failed':
      return 'error'
    case 'canceled':
      return 'cancelled'
    case 'rejected':
      return 'cancelled'
    case 'unknown':
      return 'in_progress'
  }
}

/** A blocked task is still an active attempt; terminal history is projected by its owner. */
export function jobRunStatusForTask(status: TaskStatus): JobRunStatus {
  switch (status) {
    case 'completed':
    case 'archived':
      return 'succeeded'
    case 'error':
      return 'failed'
    case 'cancelled':
      return 'cancelled'
    case 'new':
      return 'pending'
    default:
      return 'running'
  }
}

/**
 * Where a task sits on the Tasks view — the coarse grouping Cinna reacts to,
 * never the raw status word.
 *
 *  - `backlog` — new, refining: written down, nobody is expected to start it.
 *  - `ready` — open: described and ready to be picked up.
 *  - `active` — in_progress: a run is working on it.
 *  - `waiting` — blocked: waiting on a human (the Inbox).
 *  - `closed` — completed, error, cancelled.
 *
 * `archived` has no category: it is the filed-away pile, and the view leaves
 * it out.
 */
export type TaskStatusCategory = 'backlog' | 'ready' | 'active' | 'waiting' | 'closed'

/** Lifecycle order — the board's columns, left to right. */
export const TASK_STATUS_CATEGORIES: readonly TaskStatusCategory[] = ['backlog', 'ready', 'active', 'waiting', 'closed']

/** The words the user reads for each category. */
export const TASK_STATUS_CATEGORY_LABEL: Record<TaskStatusCategory, string> = {
  backlog: 'Backlog',
  ready: 'Ready',
  active: 'In progress',
  waiting: 'Waiting',
  closed: 'Done'
}

/** The category of a status; null for `archived`, which no view groups. */
export function taskStatusCategory(status: TaskStatus): TaskStatusCategory | null {
  switch (status) {
    case 'new':
    case 'refining':
      return 'backlog'
    case 'open':
      return 'ready'
    case 'in_progress':
      return 'active'
    case 'blocked':
      return 'waiting'
    case 'completed':
    case 'error':
    case 'cancelled':
      return 'closed'
    case 'archived':
      return null
  }
}

/**
 * The status a drop on a **user** column writes. Active and Waiting are absent
 * on purpose: a run or a question puts a task there, never a drag. The write
 * still goes through `task:set-status`, so the transition table and the claim
 * decide whether it is allowed.
 */
export const CATEGORY_DROP_STATUS: Partial<Record<TaskStatusCategory, TaskStatus>> = {
  backlog: 'new',
  ready: 'open',
  closed: 'completed'
}

/**
 * The statuses a person sets by hand — the board's user columns (Backlog,
 * Ready, Done), the same set {@link CATEGORY_DROP_STATUS} writes.
 */
export const MANUAL_TARGET_STATUSES: readonly TaskStatus[] = ['new', 'open', 'completed']

/**
 * How a manual move is judged. `bound`: the task's remote keeps a transition
 * table. `flagged`: a `blocked` task the dispatcher left with a note
 * (`TaskDto.dispatchNote`) and nothing holds — no open ask, so no one is
 * waiting on an answer. Main also refuses while a runtime owns the task or a
 * turn is live in its chat, which this module cannot see.
 */
export interface ManualMoveOptions {
  bound: boolean
  flagged?: boolean
}

/**
 * Can a person move a task **out of** this status at all? From a user column:
 * Backlog, Ready or Done. In progress and Waiting belong to a run or a
 * question, and closing one by hand would settle a run that is still working —
 * except a `blocked` task the dispatcher flagged, which stays where it is until
 * the user moves it.
 */
export function isManualSource(from: TaskStatus, opts: { flagged?: boolean } = {}): boolean {
  if (from === 'blocked' && opts.flagged) return true
  const category = taskStatusCategory(from)
  return category === 'backlog' || category === 'ready' || category === 'closed'
}

/**
 * Is `from → to` a move a person may make — the status half of the rule
 * `task:set-status` applies? From a user column (or a flagged task), to a user
 * column or `cancelled`, along {@link canTransitionManually}. Main adds what
 * this cannot see: a runtime that owns the task and a run live in its chat.
 */
export function canMoveManually(from: TaskStatus, to: TaskStatus, opts: ManualMoveOptions): boolean {
  if (!isManualSource(from, opts)) return false
  if (to !== 'cancelled' && !MANUAL_TARGET_STATUSES.includes(to)) return false
  // A flagged task: `cancelled` is in the table; the user columns are the
  // unbound overlay, as from any other user column.
  if (from === 'blocked') return to === 'cancelled' || !opts.bound
  return canTransitionManually(from, to, opts)
}

/**
 * The user-column statuses a person may move a task to from `from`, `from`
 * itself excluded — what the Edit dialog and the board offer. Empty for a task
 * a run or a question holds.
 */
export function manualTargets(from: TaskStatus, opts: ManualMoveOptions): TaskStatus[] {
  return MANUAL_TARGET_STATUSES.filter((to) => to !== from && canMoveManually(from, to, opts))
}
