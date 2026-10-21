/**
 * The turns the task dispatcher started (`services/taskDispatchService.ts`).
 *
 * A dispatched turn is settled by the dispatcher from what the agent reported
 * during it, not from how the turn ended, so `inboxService.endTurn` leaves that
 * turn alone. **Keyed by chat and run id**, never by task: a user's own Start
 * or chat turn on the same task — while the dispatcher still waits for a slot,
 * or after — is not the dispatcher's, and ends as any turn does. Marked when
 * the dispatched run is accepted (`taskExecutionService.start`'s
 * `onRunAccepted`, inside acceptance, so before any of its events) and cleared
 * once the dispatcher has settled it.
 *
 * In memory: a turn Cinna quit under is found at boot through the dispatcher's
 * persisted runs in flight (`agent_task_dispatch_runs`) instead.
 */
const dispatched = new Set<string>()

function runKey(chatId: string, runId: string): string {
  return JSON.stringify([chatId, runId])
}

export function markDispatchedRun(chatId: string, runId: string): void {
  dispatched.add(runKey(chatId, runId))
}

export function clearDispatchedRun(chatId: string, runId: string): void {
  dispatched.delete(runKey(chatId, runId))
}

export function isDispatchedRun(chatId: string, runId: string | undefined): boolean {
  return !!runId && dispatched.has(runKey(chatId, runId))
}

/**
 * How a turn on a task the dispatcher still owns ended — a turn it did not
 * start itself: the one an Inbox answer or a typed message resumes after a
 * dispatched turn stopped on a `next_message` ask. Ownership is persisted on
 * the task (`tasks.dispatch_agent_id`), so it outlives a restart.
 */
export interface DispatchOwnedTurnEnd {
  userId: string
  chatId: string
  taskId: string
  /** The agent whose queue owns the task. */
  agentId: string
  state: 'completed' | 'failed' | 'canceled'
  error?: { message: string }
}

/**
 * Registered by the dispatcher (`services/taskDispatchService.ts`), which
 * `inboxService.endTurn` cannot import: the dispatcher imports the execution
 * stack that imports the Inbox. Returns false when nobody settles it, and the
 * turn ends as any turn does. Returns true while Cinna is quitting too, when
 * the dispatcher settles nothing: the task is left running and still owned,
 * and boot recovery (`recoverInterrupted`) flags it rather than this turn's
 * end completing it on the way out.
 */
let ownedTurnSettler: ((end: DispatchOwnedTurnEnd) => void) | null = null

export function setDispatchOwnedTurnSettler(settler: ((end: DispatchOwnedTurnEnd) => void) | null): void {
  ownedTurnSettler = settler
}

export function settleDispatchOwnedTurn(end: DispatchOwnedTurnEnd): boolean {
  if (!ownedTurnSettler) return false
  ownedTurnSettler(end)
  return true
}

/**
 * Wake the dispatcher: an Inbox answer was stored for its queue to send
 * (`task_input_requests.queued_answer`). Registered by the dispatcher, for the
 * same import-cycle reason as {@link setDispatchOwnedTurnSettler}; a no-op
 * until it is, and the answer waits for the next pass (its tick) anyway.
 */
let dispatchWake: (() => void) | null = null

export function setDispatchWake(wake: (() => void) | null): void {
  dispatchWake = wake
}

export function wakeDispatcher(): void {
  dispatchWake?.()
}

/**
 * Whether a dispatcher flight holds this task now (waiting for its slot or
 * running), or its owned turn is being settled. Registered by the dispatcher
 * for the same import-cycle reason as {@link setDispatchOwnedTurnSettler};
 * false until it is, when no flight can exist.
 */
let holdsTask: ((userId: string, taskId: string) => boolean) | null = null

export function setDispatchHoldsTask(probe: ((userId: string, taskId: string) => boolean) | null): void {
  holdsTask = probe
}

export function dispatcherHoldsTask(userId: string, taskId: string): boolean {
  return holdsTask?.(userId, taskId) ?? false
}
