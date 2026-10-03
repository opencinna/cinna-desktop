import { createLogger } from '../logger/logger'
import type { HandoverTurnOutcome } from './handoverService'
import type { RunScope } from './runExecutionService'

/**
 * Turns a return packet opens, announced to the channels that settle delegations.
 *
 * A delegation's packet lands in its requester's chat. When that requester is itself an executor —
 * a relay that delegated onward and ended its turn — the packet's turn is the relay resuming, and
 * its outcome has to settle the relay's own row. The two places that start such turns (the
 * lifecycle's wake and the file channel's group wake) cannot import the channel services without a
 * cycle, so each channel registers here instead, at its module bottom.
 */
export type ReturnTurnWatcher = (scope: RunScope, chatId: string, completed: Promise<HandoverTurnOutcome>) => void

const watchers = new Set<ReturnTurnWatcher>()
const logger = createLogger('return-turns')

export function onReturnTurn(watcher: ReturnTurnWatcher): () => void {
  watchers.add(watcher)
  return () => watchers.delete(watcher)
}

export function returnTurnStarted(scope: RunScope, chatId: string, completed: Promise<HandoverTurnOutcome>): void {
  for (const watcher of watchers) {
    try {
      watcher(scope, chatId, completed)
    } catch (error) {
      logger.warn('a return turn could not be watched', { chatId, error: String(error) })
    }
  }
}
