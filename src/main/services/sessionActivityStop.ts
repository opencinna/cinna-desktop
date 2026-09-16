import {
  sessionActivityStopRefusal,
  type SessionActivityItem,
  type SessionActivityStopResult
} from '../../shared/sessionActivity'
import { createLogger } from '../logger/logger'
import { sessionActivityHub, type SessionActivityHub } from './sessionActivityHub'

const logger = createLogger('session-activity-stop')

/**
 * What a provider did with a stop.
 *
 * - `stopped` — the agent took it.
 * - `already_ended` — the agent says there was nothing running to stop.
 * - `unavailable` — the agent's process is gone, refused, or did not answer in time.
 */
export type SessionActivityStopOutcome = 'stopped' | 'already_ended' | 'unavailable'

/**
 * A provider's side of Stop: a driver that reports stoppable items installs
 * one. It is asked about a running item the hub holds with `canStop`, and
 * answers `null` for an item it does not know.
 */
export interface SessionActivityStopper {
  stop(chatId: string, item: SessionActivityItem): Promise<SessionActivityStopOutcome | null>
}

const stoppers = new Map<string, SessionActivityStopper>()

/** Install the stopper of one provider (a later install for the same key replaces it). */
export function installSessionActivityStopper(provider: string, stopper: SessionActivityStopper): () => void {
  stoppers.set(provider, stopper)
  return () => {
    if (stoppers.get(provider) === stopper) stoppers.delete(provider)
  }
}

/**
 * Stop one item of a chat. The caller has checked the chat is the active
 * profile's. Never throws: every refusal is data with a sentence to show.
 */
export async function stopSessionActivity(
  chatId: string,
  itemId: string,
  hub: SessionActivityHub = sessionActivityHub
): Promise<SessionActivityStopResult> {
  const find = (): SessionActivityItem | undefined => hub.snapshot(chatId).items.find((item) => item.id === itemId)
  const item = find()
  if (!item) return sessionActivityStopRefusal('not_stoppable')
  if (item.state !== 'running') return sessionActivityStopRefusal('already_ended')
  if (!item.canStop) return sessionActivityStopRefusal('not_stoppable')

  for (const [provider, stopper] of [...stoppers]) {
    let outcome: SessionActivityStopOutcome | null
    try {
      outcome = await stopper.stop(chatId, item)
    } catch (err) {
      logger.warn('a session activity stopper failed', { provider, chatId, itemId, error: err instanceof Error ? err.message : String(err) })
      outcome = 'unavailable'
    }
    if (outcome === null) continue
    if (outcome === 'stopped') return { ok: true }
    // The item may have ended while the request ran: say so rather than "no answer".
    const now = find()
    if (outcome === 'unavailable' && now && now.state !== 'running') {
      return sessionActivityStopRefusal('already_ended')
    }
    return sessionActivityStopRefusal(outcome)
  }
  logger.debug('no provider knows a stoppable activity item', { chatId, itemId })
  return sessionActivityStopRefusal('not_stoppable')
}
