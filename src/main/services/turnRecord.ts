import { chatRunResultRepo } from '../db/chatRunResults'
import { reportStandaloneTurn, type TurnOutcome } from './turnCompletion'
import { createLogger } from '../logger/logger'
import type { RunEvent } from '../../shared/runEvents'
import type { ChatRunResultStatus } from '../../shared/chatRunResult'

const logger = createLogger('run')

/** The turn's final outcome as the run service settles it. */
export interface RecordedTurnOutcome extends TurnOutcome {
  /** Set when the turn's remaining asks could not be read or were left dead. */
  inputRequestReadError?: string
}

/**
 * The terminal event an outcome amounts to — what the Inbox's `endTurn` reads
 * to expire a turn's asks and settle a task the chat owns outright.
 */
export function terminalEventOf(outcome: TurnOutcome): Extract<RunEvent, { type: 'done' | 'error' }> {
  return outcome.state === 'failed'
    ? { type: 'error', error: outcome.error?.message ?? 'The turn failed.' }
    : { type: 'done', stopReason: outcome.state === 'canceled' ? 'canceled' : outcome.state === 'budget' ? 'budget' : 'end_turn' }
}

/** The sidebar's result for a turn. */
export function runResultStatusOf(outcome: RecordedTurnOutcome, canceled: boolean): ChatRunResultStatus {
  if (canceled) return 'canceled'
  return outcome.state === 'budget' || outcome.inputRequestReadError ? 'failed' : outcome.state
}

/**
 * The persistent record of how a chat's own turn ended — the sidebar's run
 * result and the job run (with its task) through `reportStandaloneTurn`. Both
 * the live run's close and the boot pass for a turn the app was killed under
 * go through here. Not for a turn a task runner owns: the runner owns that
 * outcome. Each write is logged and swallowed, as a bookkeeping failure must
 * not undo the other.
 *
 * The task a hand-opened chat created for itself is settled by the Inbox's
 * `endTurn`, from {@link terminalEventOf}, which the caller routes.
 */
export function recordTurnResult(chatId: string, runId: string, outcome: RecordedTurnOutcome, options: { canceled: boolean }): void {
  try {
    chatRunResultRepo.record(chatId, runId, runResultStatusOf(outcome, options.canceled))
  } catch (error) {
    logger.warn('could not save sidebar run result', { chatId, error: String(error) })
  }
  try {
    reportStandaloneTurn(chatId, outcome)
  } catch (error) {
    logger.warn('turn status projection failed', { chatId, error: String(error) })
  }
}
