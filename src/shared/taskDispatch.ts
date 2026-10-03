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
 * task whenever the agent and its folder are free.
 */
export type TaskDispatchMode = 'manual' | 'one'

export const TASK_DISPATCH_MODES: readonly TaskDispatchMode[] = ['manual', 'one']

export function isTaskDispatchMode(value: unknown): value is TaskDispatchMode {
  return (TASK_DISPATCH_MODES as readonly unknown[]).includes(value)
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
 * Why a queue in `one` mode is not starting its next task right now.
 *
 *  - `folder_busy` — another dispatched run (this agent's or another agent's
 *    sharing the folder) is working there.
 *  - `live_turn` — a turn that is not the dispatcher's is running in the folder.
 *  - `slot` — waiting for a global task runner slot.
 *  - `gate` — every Ready task left waits on an Inbox approval of its content,
 *    and a card for one of them is open in the Inbox (in any mode). With no
 *    open card, `next` names the top one with `needsApproval` instead.
 */
export type TaskDispatchWaiting = 'folder_busy' | 'live_turn' | 'slot' | 'gate'

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
  running: null | { taskId: string; chatId: string; title: string }
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
 * `DomainError.code` does not survive the IPC bridge.
 */
export type TaskDispatchRefusalCode =
  | 'not_dispatchable'
  | 'agent_busy'
  | 'folder_busy'
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

/** `taskDispatch:set-mode` and `taskDispatch:resume`. */
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
