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
