import type { SessionTelemetry, SessionTelemetryChange } from '../../../shared/sessionTelemetry'
import { sessionTelemetryRepo } from '../../db/sessionTelemetry'
import { chatRepo } from '../../db/chats'
import { createLogger } from '../../logger/logger'
import { applyTelemetryChange } from './sessionTelemetryReducer'

const logger = createLogger('session-telemetry')

export type SessionTelemetryListener = (chatId: string, telemetry: SessionTelemetry) => void

export interface SessionTelemetryStore {
  get(chatId: string): SessionTelemetry | null
  save(telemetry: SessionTelemetry): void
  delete(chatId: string): void
}

/** Everything but the clock: a change that moved only `updatedAt` changed nothing. */
function sameTelemetry(a: SessionTelemetry | null, b: SessionTelemetry): boolean {
  if (!a) return false
  return JSON.stringify({ ...a, updatedAt: 0 }) === JSON.stringify({ ...b, updatedAt: 0 })
}

/**
 * Session telemetry per chat: folds each change a driver reports
 * (`sessionTelemetryReducer.ts`), persists the result, and tells listeners.
 *
 * Core, and in the same shape as the session activity hub: drivers report
 * through the `SessionTelemetryReporter` port, the IPC layer subscribes with
 * `onChange` and decides what reaches a window. Unlike activity it is durable —
 * the last known state is read back after a restart. A write that fails is
 * logged and the in-memory state kept; telemetry never fails a turn.
 *
 * Copies go out; nothing held here is exposed by reference.
 */
export function createSessionTelemetryService(options: {
  store?: SessionTelemetryStore
  now?: () => number
  /**
   * Whether a chat is in the trash. A trashed chat's sessions were forgotten
   * with it, so a late report (a turn that ended as it was trashed) must not
   * write its row back. Absent: every chat is live.
   */
  isTrashed?: (chatId: string) => boolean
} = {}) {
  const store = options.store ?? sessionTelemetryRepo
  const now = options.now ?? Date.now
  const isTrashed = options.isTrashed
  const held = new Map<string, SessionTelemetry | null>()
  const listeners = new Set<SessionTelemetryListener>()

  const load = (chatId: string): SessionTelemetry | null => {
    if (held.has(chatId)) return held.get(chatId) ?? null
    let stored: SessionTelemetry | null = null
    try {
      stored = store.get(chatId)
    } catch (error) {
      logger.warn('could not read a chat’s session telemetry', { chatId, error: String(error) })
    }
    held.set(chatId, stored)
    return stored
  }

  const emit = (chatId: string, telemetry: SessionTelemetry): void => {
    for (const listener of [...listeners]) {
      try {
        listener(chatId, structuredClone(telemetry))
      } catch (error) {
        logger.warn('a session telemetry listener failed', { chatId, error: String(error) })
      }
    }
  }

  const trashed = (chatId: string): boolean => {
    if (!isTrashed) return false
    try {
      return isTrashed(chatId)
    } catch (error) {
      logger.warn('could not tell whether a chat with session telemetry is trashed', { chatId, error: String(error) })
      return false
    }
  }

  const forget = (chatId: string): void => {
    held.delete(chatId)
    try {
      store.delete(chatId)
    } catch (error) {
      logger.warn('could not drop a chat’s session telemetry', { chatId, error: String(error) })
    }
  }

  return {
    report(chatId: string, change: SessionTelemetryChange): void {
      if (trashed(chatId)) {
        forget(chatId)
        return
      }
      const current = load(chatId)
      const next = applyTelemetryChange(current, chatId, change, now())
      if (sameTelemetry(current, next)) return
      held.set(chatId, next)
      try {
        store.save(next)
      } catch (error) {
        // A chat deleted under its turn has no row to hold this.
        logger.warn('could not save a chat’s session telemetry', { chatId, error: String(error) })
      }
      emit(chatId, next)
    },

    /** The chat's telemetry as it stands, or null when it has none. */
    get(chatId: string): SessionTelemetry | null {
      const telemetry = load(chatId)
      return telemetry ? structuredClone(telemetry) : null
    },

    onChange(listener: SessionTelemetryListener): () => void {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },

    /**
     * The last `cost.amount` recorded for one of the chat's ACP sessions — the
     * runtime's running total, which it restores on resume — or undefined.
     */
    lastCostReading(chatId: string, sessionId: string): number | undefined {
      return load(chatId)?.totals.bySession[sessionId]?.lastCostReading
    },

    /** The same, per model: the session's last `modelUsage[model].costUSD` readings, or undefined. */
    lastModelCostReadings(chatId: string, sessionId: string): Record<string, number> | undefined {
      const readings = load(chatId)?.totals.bySession[sessionId]?.modelCostReadings
      return readings ? { ...readings } : undefined
    },

    /** Forgets a chat (trashed or deleted): its row and what is held here. Announces nothing. */
    forget
  }
}

export type SessionTelemetryService = ReturnType<typeof createSessionTelemetryService>

export const sessionTelemetryService = createSessionTelemetryService({ isTrashed: (chatId) => chatRepo.isTrashed(chatId) })
