/**
 * A local schedule's run completed: told once per occurrence that settles
 * `completed`, from whichever path settles it — a prompt or follow-up job's
 * run outcome (`jobService`), a quiet `OK` command, or the scheduler's own
 * reconcile pass. Listeners (dashboards' schedule-fed tiles, README D4) get
 * the binding's agent and schedule name; a listener that throws is logged
 * and never reaches the settling path.
 *
 * Core module: no Electron.
 */

import { localScheduleRepo } from '../db/localSchedules'
import { createLogger } from '../logger/logger'

const logger = createLogger('local-schedule-events')

export interface ScheduleRunCompleted {
  /** The profile the binding belongs to. */
  userId: string
  bindingId: string
  /** The agent's row id (`folder:<manifest id>`). */
  agentId: string
  manifestId: string
  /** The manifest schedule's name. */
  name: string
}

type Listener = (event: ScheduleRunCompleted) => void
const listeners = new Set<Listener>()

export function onScheduleRunCompleted(listener: Listener): () => void {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

/** An occurrence of `bindingId` settled `completed`. Never throws. */
export function notifyScheduleRunCompleted(userId: string, bindingId: string): void {
  if (listeners.size === 0) return
  let event: ScheduleRunCompleted
  try {
    const binding = localScheduleRepo.get(userId, bindingId)
    // A job schedule (Jobs tab) feeds no agent's tiles.
    if (!binding || binding.definition.executionType === 'job') return
    event = { userId, bindingId, agentId: binding.definition.agentId, manifestId: binding.manifestId, name: binding.name }
  } catch (err) {
    logger.debug('could not read a completed schedule’s binding', { error: err instanceof Error ? err.message : String(err) })
    return
  }
  for (const listener of [...listeners]) {
    try {
      listener(event)
    } catch (err) {
      logger.warn('a schedule-completed listener failed', { error: err instanceof Error ? err.message : String(err) })
    }
  }
}
