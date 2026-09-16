import { inflightTurnRepo, isLiveMarker, type InflightTurnRow, type TurnEndNotice } from '../db/inflightTurns'
import { jobRunsRepo } from '../db/jobs'
import { taskRepo } from '../db/tasks'
import { taskRuntimeRepo } from '../db/taskRuntimes'
import { scriptRuntimeRepo } from '../db/scriptRuntimes'
import { taskHandoffRepo } from '../db/taskHandoffs'
import { taskInputRequestRepo } from '../db/taskInputRequests'
import { inboxService } from './inboxService'
import { jobService } from './jobService'
import { recordTurnResult, terminalEventOf } from './turnRecord'
import { hasRecoverer } from './turnRecoverers'
import { activeRunsByChat } from './runExecutionState'
import { taskRunnersByChat } from './taskRunnerState'
import { createLogger } from '../logger/logger'
import type { TurnOutcome } from './turnCompletion'

const logger = createLogger('boot')

/** The error row a turn the app was killed under ends with. */
export const INTERRUPTED_TURN_NOTICE = 'The app closed before this turn finished. Send your message again to retry.'
/** Its code. */
export const TURN_INTERRUPTED_CODE = 'turn_interrupted'
/** Why such a turn failed, for its job run and task. */
export const INTERRUPTED_TURN_REASON = 'The app closed before this turn finished.'
/** The row itself, for {@link finalizeInterrupted}. */
export const INTERRUPTED_NOTICE: TurnEndNotice = { short: INTERRUPTED_TURN_NOTICE, code: TURN_INTERRUPTED_CODE }
/** A job run left `running` by a kill from before turns had markers. */
export const INTERRUPTED_RUN_MESSAGE = 'The app closed before this run finished.'

/** The outcome recorded for a turn nothing can recover. */
export const INTERRUPTED_OUTCOME: TurnOutcome = { state: 'failed', text: '', error: { message: INTERRUPTED_TURN_REASON } }

/**
 * Whether `remoteTurnRecoveryService` settles this marker itself, by asking
 * the agent how the turn ended: its driver has a registered recoverer. The
 * boot pass settles every other marker as interrupted.
 */
export function isRecoverable(marker: InflightTurnRow): boolean {
  return hasRecoverer(marker.driver)
}

/** An answerable next-message ask of this agent waits in the chat. */
function parkedOnNextMessage(marker: InflightTurnRow): boolean {
  return taskInputRequestRepo.listOpenForChat(marker.chatId)
    .some((row) => row.resume === 'next_message' && row.agentId === marker.agentId)
}

/**
 * Record how a turn the app was killed under ended, and clear its marker.
 *
 * The same persistent writes a live turn's close makes: the task a
 * hand-opened chat owns (through the Inbox's `endTurn`), the sidebar run
 * result and the job run (through `recordTurnResult`). A turn left waiting on
 * an answerable next-message ask keeps its task and job run as they are — the
 * ask is still the way on — and reads as waiting in the sidebar. The marker's
 * draft row, if any, stays as the turn's assistant row.
 *
 * **A turn the chat has moved on from** (a later user row follows its user
 * row) records nothing: the task, the job run and the sidebar result belong
 * to the later turn now. Its notice goes directly under its own rows rather
 * than at the chat's end.
 *
 * `outcome` is the interrupted one at boot, or the agent's real ending once a
 * recovery service has asked for it. Throws only when the notice or the marker
 * delete fails; the bookkeeping writes log their own failures.
 */
export function finalizeInterrupted(marker: InflightTurnRow, outcome: TurnOutcome, options: { notice?: TurnEndNotice } = {}): void {
  const superseded = isSuperseded(marker)
  const parked = !superseded && outcome.state !== 'canceled' && parkedOnNextMessage(marker)
  if (!superseded) {
    if (!parked) {
      inboxService.recordRunEvent({
        userId: marker.profileId,
        chatId: marker.chatId,
        agentId: marker.agentId,
        turnId: marker.id,
        rootRunId: marker.id,
        completionOwner: 'turn'
      }, terminalEventOf(outcome))
    }
    recordTurnResult(marker.chatId, marker.id, parked ? { ...outcome, state: 'needs_input' } : outcome,
      { canceled: outcome.state === 'canceled' })
  }
  inflightTurnRepo.settle(marker, options.notice, { under: superseded ? marker.userMessageId : null })
  logger.info('an interrupted turn was finalized', {
    chatId: marker.chatId, agentId: marker.agentId, driver: marker.driver, state: outcome.state, parked, superseded
  })
}

/** Whether a later user row follows the turn's user row: the chat has moved on. */
export function isSuperseded(marker: Pick<InflightTurnRow, 'chatId' | 'userMessageId'>): boolean {
  if (!marker.userMessageId) return false
  try {
    return inflightTurnRepo.hasLaterUserRow({ chatId: marker.chatId, userMessageId: marker.userMessageId })
  } catch (err) {
    logger.warn('could not tell whether a chat moved on past an interrupted turn', { chatId: marker.chatId, error: errorText(err) })
    return false
  }
}

/**
 * A job run a kill left `running` before turns had markers: finalize it as
 * failed, but only when it is a plain renderer-started chat turn with no owner
 * left — not a coordinator or script run (the runtimes' `recover` owns those),
 * not a `cinna_task` run (the remote task does), not one waiting on an
 * answerable next-message ask, not one a recovery service still holds a
 * marker for, and not one whose task runs elsewhere (`setRunStatus` refuses).
 */
function finalizeOrphanedRuns(): void {
  const withMarker = inflightTurnRepo.listChatIds()
  for (const run of jobRunsRepo.listUnfinishedChatTurnRuns()) {
    const chatId = run.localChatId!
    try {
      if (withMarker.has(chatId) || activeRunsByChat.has(chatId) || taskRunnersByChat.has(chatId)) continue
      if (taskInputRequestRepo.listOpenForChat(chatId).some((row) => row.resume === 'next_message')) continue
      if (run.taskId) {
        const task = taskRepo.getById(run.userId, run.taskId)
        if (!task || task.deletedAt || task.executor !== 'desktop') continue
        if (taskRuntimeRepo.get(run.userId, run.taskId) || scriptRuntimeRepo.owner(run.userId, run.taskId)) continue
        if (taskHandoffRepo.unresolved(run.userId, run.taskId)) continue
      }
      jobService.setRunStatus(run.userId, run.id, 'failed', INTERRUPTED_RUN_MESSAGE)
      logger.info('an orphaned job run was finalized', { runId: run.id, chatId })
    } catch (err) {
      logger.error('could not finalize an orphaned job run', { runId: run.id, error: errorText(err) })
    }
  }
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

export const interruptedTurnService = {
  /**
   * The boot pass for turns the app was killed under. Runs after the database,
   * the session and `taskRuntimeService.recover()`: task writes need this
   * device's id, and the runtimes' reservations must exist before a run is
   * judged ownerless. Each marker, and each orphaned run, fails alone.
   * `recoverable` defaults to {@link isRecoverable}. A marker of a turn this
   * process is running (`isLiveMarker`) is never touched.
   */
  finalizeLeftovers(options: { recoverable?: (marker: InflightTurnRow) => boolean } = {}): void {
    const recoverable = options.recoverable ?? isRecoverable
    let markers: InflightTurnRow[] = []
    try {
      markers = inflightTurnRepo.list()
    } catch (err) {
      logger.error('could not read the in-flight turns', { error: errorText(err) })
    }
    for (const marker of markers) {
      try {
        if (isLiveMarker(marker.id) || recoverable(marker)) continue
        finalizeInterrupted(marker, INTERRUPTED_OUTCOME, { notice: INTERRUPTED_NOTICE })
      } catch (err) {
        logger.error('could not finalize an interrupted turn', { markerId: marker.id, chatId: marker.chatId, error: errorText(err) })
      }
    }
    try {
      finalizeOrphanedRuns()
    } catch (err) {
      logger.error('could not finalize orphaned job runs', { error: errorText(err) })
    }
  }
}
