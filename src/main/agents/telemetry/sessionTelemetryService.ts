import type {
  ContextMeasureCode,
  SessionContextMeasurer,
  SessionTelemetry,
  SessionTelemetryChange,
  TokenTally
} from '../../../shared/sessionTelemetry'
import { sessionTelemetryRepo } from '../../db/sessionTelemetry'
import { chatRepo } from '../../db/chats'
import { createLogger } from '../../logger/logger'
import { applyTelemetryChange } from './sessionTelemetryReducer'

const logger = createLogger('session-telemetry')

export type SessionTelemetryListener = (chatId: string, telemetry: SessionTelemetry) => void

export type MeasureContextOutcome = { ok: true } | { ok: false; code: ContextMeasureCode }

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
  let measurer: SessionContextMeasurer | undefined
  /** One measurement per chat at a time: a second ask shares the first. */
  const measuring = new Map<string, Promise<MeasureContextOutcome>>()

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

  const report = (chatId: string, change: SessionTelemetryChange): void => {
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
  }

  const measure = async (chatId: string): Promise<MeasureContextOutcome> => {
    if (!measurer) return { ok: false, code: 'unsupported' }
    let measured: Awaited<ReturnType<SessionContextMeasurer>>
    try {
      measured = await measurer(chatId)
    } catch (error) {
      logger.warn('a context measurement failed', { chatId, error: String(error) })
      return { ok: false, code: 'failed' }
    }
    if (!measured.ok) return { ok: false, code: measured.code }
    report(chatId, { type: 'context_categories', engine: measured.engine, sessionId: measured.sessionId, categories: measured.categories, at: now() })
    return { ok: true }
  }

  return {
    report,

    /**
     * Measure the chat's context by category, now, through the installed
     * measurer (the ACP driver). Never starts a process or a session: a chat
     * whose session is not live, or is mid-turn, is refused with a code. On
     * success the measurement is reported as a `context_categories` change —
     * listeners hear it like any other — and the answer is only `ok`.
     */
    measureContext(chatId: string): Promise<MeasureContextOutcome> {
      const running = measuring.get(chatId)
      if (running) return running
      const started = measure(chatId).finally(() => measuring.delete(chatId))
      measuring.set(chatId, started)
      return started
    },

    /** The driver side of {@link measureContext}. The last one installed wins. */
    installContextMeasurer(next: SessionContextMeasurer): void {
      measurer = next
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

    /** The session's last running token total (Codex's patched quota), or undefined. */
    lastTokenTotal(chatId: string, sessionId: string): TokenTally | undefined {
      const reading = load(chatId)?.totals.bySession[sessionId]?.lastTokenTotal
      return reading ? { ...reading } : undefined
    },

    /** Forgets a chat (trashed or deleted): its row and what is held here. Announces nothing. */
    forget
  }
}

export type SessionTelemetryService = ReturnType<typeof createSessionTelemetryService>

export const sessionTelemetryService = createSessionTelemetryService({ isTrashed: (chatId) => chatRepo.isTrashed(chatId) })
