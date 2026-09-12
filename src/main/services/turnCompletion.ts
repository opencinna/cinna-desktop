import type { CoordinatorControl } from './coordinatorToolProvider'
import { jobService } from './jobService'
import { createLogger } from '../logger/logger'

const logger = createLogger('turn-completion')

/** A single turn's result, independent of the task that may own many turns. */
export interface TurnOutcome {
  /** Driver-authorized note from a successful handed-off agent answer. */
  handback?: { note: string }
  control?: CoordinatorControl
  state: 'completed' | 'needs_input' | 'failed' | 'canceled' | 'budget'
  /** Final assistant text, or the stopped round's retained partial text. */
  text: string
  error?: { message: string; code?: string }
  /** Absent means unreported. The current adapter contract reports no usage. */
  usage?: { inputTokens: number; outputTokens: number }
}

export type TurnCompletion = (outcome: TurnOutcome) => void

/** Exactly one terminal callback, after transcript persistence and before close. */
export function createTurnCompletion(chatId: string, completion?: TurnCompletion): TurnCompletion {
  let finished = false
  return (outcome) => {
    if (finished) return
    finished = true
    try {
      if (completion) completion(outcome)
      else reportStandaloneTurn(chatId, outcome)
    } catch (error) {
      // Status bookkeeping cannot make saved output fail a second time.
      logger.warn('turn completion bookkeeping failed', { chatId, error: String(error) })
    }
  }
}

export function reportStandaloneTurn(chatId: string, outcome: TurnOutcome): void {
  const status = outcome.state === 'canceled' ? 'cancelled'
    : outcome.state === 'failed' || outcome.state === 'budget' ? 'failed' : 'succeeded'
  if (outcome.error) jobService.reportRunCompletion(chatId, status, outcome.error.message)
  else jobService.reportRunCompletion(chatId, status)
}
