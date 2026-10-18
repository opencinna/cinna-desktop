/**
 * The task dispatcher's contract — how Cinna works a folder agent's queue of
 * Ready tasks one at a time (`services/taskDispatchService.ts`).
 *
 * Pure type module plus constants: imported from main, preload and the
 * renderer alike.
 */

/**
 * How an agent's queue runs. `manual` (the default, stored as no row): nothing
 * starts on its own, Run next still works. `one`: Cinna starts the next Ready
 * task whenever the agent has no dispatched run. `up_to`: Cinna keeps up to N
 * of the agent's tasks running at once ({@link TASK_DISPATCH_MAX_RUNS}). In
 * every mode a start ignores the folder — other agents' runs there, chats on
 * the agent — and the user's own starts (Run next, Approve and run) ignore the
 * count as well.
 */
export type TaskDispatchMode = 'manual' | 'one' | 'up_to'

export const TASK_DISPATCH_MODES: readonly TaskDispatchMode[] = ['manual', 'one', 'up_to']

export function isTaskDispatchMode(value: unknown): value is TaskDispatchMode {
  return (TASK_DISPATCH_MODES as readonly unknown[]).includes(value)
}

/** The N of `up_to`: how many of the agent's tasks may run at once. */
export const TASK_DISPATCH_MAX_RUNS = { min: 2, max: 8, default: 2 } as const

export function isTaskDispatchMaxRuns(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) &&
    value >= TASK_DISPATCH_MAX_RUNS.min && value <= TASK_DISPATCH_MAX_RUNS.max
}

/**
 * Why a queue stopped starting tasks on its own until the user resumes it.
 *
 *  - `unreported` — a dispatched turn ended and the agent never said how the
 *    task went; the task was moved to blocked with a dispatch note.
 *  - `error` — a dispatched turn failed, or the task could not be started.
 *  - `stopped` — the user pressed Stop on a dispatched turn.
 *  - `interrupted` — Cinna quit while a dispatched turn was running.
 */
export type TaskDispatchPauseReason = 'unreported' | 'error' | 'stopped' | 'interrupted'

export const TASK_DISPATCH_PAUSE_REASONS: readonly TaskDispatchPauseReason[] = ['unreported', 'error', 'stopped', 'interrupted']

/**
 * Why a queue is not starting its next task right now. Computed on each read,
 * never stored.
 *
 *  - `slot` — waiting for a global task runner slot.
 *  - `gate` — every Ready task left waits on an Inbox approval of its content,
 *    and a card for one of them is open in the Inbox (in any mode). With no
 *    open card, `next` names the top one with `needsApproval` instead.
 */
export type TaskDispatchWaiting = 'slot' | 'gate'

/** One agent's queue, as the agent page and the Tasks view show it. */
export interface AgentDispatchState {
  agentId: string
  mode: TaskDispatchMode
  paused: null | {
    reason: TaskDispatchPauseReason
    taskId: string | null
    taskTitle: string | null
    /** Epoch milliseconds. */
    at: number
  }
  /** N while the mode is `up_to`; null in the other modes (they run one at most). */
  maxRuns: number | null
  /**
   * The dispatched turns running now, oldest first. The queue's own starts
   * keep to the count (one outside `up_to`); Run next can add more.
   */
  running: { taskId: string; chatId: string; title: string }[]
  /**
   * The task Run next would take. `needsApproval`: only tasks waiting on an
   * approval of outside content are left and no card for them is open
   * (Manual, a paused queue, a skipped card) — Run next asks for it.
   */
  next: null | { taskId: string; title: string; needsApproval: boolean }
  waiting: null | TaskDispatchWaiting
}

/**
 * Why Run next did not start a task. Returned as data: a thrown
 * `DomainError.code` does not survive the IPC bridge. Run next is the user's
 * own start and ignores the agent's count and its folder; `live_turn` is the
 * task's own chat (or a stored answer's) still running a turn.
 */
export type TaskDispatchRefusalCode =
  | 'not_dispatchable'
  | 'live_turn'
  | 'slot'
  | 'not_eligible'
  | 'nothing_eligible'
  | 'start_failed'
  | 'invalid_input'

/** `taskDispatch:run-next`. `gate` names the Inbox approval the renderer should open. */
export type TaskDispatchRunResult =
  | { ok: true; taskId: string; chatId: string }
  | { ok: true; gate: string }
  | { ok: false; code: TaskDispatchRefusalCode; message: string }

/** `taskDispatch:set-mode` (agent id, mode, N for `up_to`) and `taskDispatch:resume`. */
export type TaskDispatchUpdateResult =
  | { ok: true; state: AgentDispatchState }
  | { ok: false; code: TaskDispatchRefusalCode; message: string }

/** Pushed by main whenever an agent's dispatch state may have changed; the renderer invalidates on it. */
export const TASK_DISPATCH_CHANGED_CHANNEL = 'taskDispatch:changed'

export interface TaskDispatchChangedPayload {
  /** The agent whose state changed; null when several may have. */
  agentId: string | null
}

/** The note a task gets when a dispatched turn ended without the agent reporting. */
export const DISPATCH_NOTE_UNREPORTED = 'Ended without reporting'

/** The note a task gets when Cinna quit while a dispatched turn was running it. */
export const DISPATCH_NOTE_INTERRUPTED = 'Interrupted when Cinna quit'
