/**
 * The listener that outlives a turn: what an ACP session says while no turn is
 * bound to it.
 *
 * Engines really do talk between turns. `claude-agent-acp` runs a whole turn of
 * its own when a background shell finishes (the "Merged." that never reached
 * the app), and `codex-acp` sends late `tool_call_update`s and task state for
 * the turn that just ended (`drafts/session_activity/phase0_findings.md`).
 * Before this file that traffic sat in the connection's pre-bind pen for ten
 * seconds and was dropped, and a permission ask waited the same ten seconds to
 * be refused.
 *
 * The driver registers one observer per session a turn created or loaded, once
 * the turn has unbound, and drops it when the process goes away or the session
 * is replaced. The observer itself only **counts and logs** — kinds and counts,
 * never content — and hands everything to a {@link SessionTrafficSink}. What a
 * sink does with it (activity badges, a follow-up turn) is a later phase's; the
 * default one refuses asks at once, which is today's answer without the wait.
 */

import type {
  CreateElicitationRequest,
  CreateElicitationResponse,
  RequestPermissionRequest,
  RequestPermissionResponse,
  SessionNotification
} from '@agentclientprotocol/sdk'
import { createLogger } from '../../../logger/logger'
import type { AcpLauncherId, AcpSessionObserver } from './types'

const logger = createLogger('acp-session-observer')

/** Whose session this is. The driver knows all of it at bind time. */
export interface SessionTrafficScope {
  agentId: string
  chatId: string
  sessionId: string
  launcherId: AcpLauncherId
  /**
   * The profile and settings scope of the turn that armed the observer —
   * what a follow-up turn of this session runs under. Absent for a turn with
   * no chat scope of its own.
   */
  profileUserId?: string
  settingsUserId?: string
}

/**
 * Where between-turn traffic goes. One per observed session.
 *
 * The requests return promises on purpose: the agent is blocked on them, and a
 * sink that opens a turn for the ask can answer it from there.
 */
export interface SessionTrafficSink {
  update(notification: SessionNotification): void
  permission(params: RequestPermissionRequest): Promise<RequestPermissionResponse>
  elicitation(params: CreateElicitationRequest): Promise<CreateElicitationResponse>
}

export type SessionTrafficSinkFactory = (scope: SessionTrafficScope) => SessionTrafficSink

/**
 * The sink before anything is wired to it: updates are only counted (by the
 * observer), and an ask is refused **now** — the agent is blocked on it, and
 * nobody is going to answer.
 */
export const refusingSessionTrafficSink: SessionTrafficSinkFactory = (scope) => ({
  update: () => {},
  permission: async () => {
    logger.warn('permission asked between turns; refused', {
      agentId: scope.agentId,
      chatId: scope.chatId,
      sessionId: scope.sessionId
    })
    return { outcome: { outcome: 'cancelled' } }
  },
  elicitation: async () => {
    logger.warn('question asked between turns; refused', {
      agentId: scope.agentId,
      chatId: scope.chatId,
      sessionId: scope.sessionId
    })
    return { action: 'cancel' }
  }
})

/** The kinds that are a turn's content rather than session bookkeeping. */
const TURN_SHAPED: ReadonlySet<string> = new Set([
  'agent_message_chunk',
  'agent_thought_chunk',
  'tool_call',
  'tool_call_update',
  'plan'
])

/** How long one burst of between-turn traffic is collected before it is logged. */
export const SESSION_TRAFFIC_BURST_MS = 2_000

export interface SessionObservation {
  observer: AcpSessionObserver
  /** Log what is still collected and stop. Idempotent. */
  close(): void
}

export function createSessionObservation(
  scope: SessionTrafficScope,
  sink: SessionTrafficSink,
  burstMs = SESSION_TRAFFIC_BURST_MS
): SessionObservation {
  let counts = new Map<string, number>()
  let timer: NodeJS.Timeout | undefined
  let closed = false

  const flush = (): void => {
    if (timer) clearTimeout(timer)
    timer = undefined
    if (counts.size === 0) return
    const kinds = Object.fromEntries(counts)
    let turnShaped = 0
    for (const [kind, n] of counts) if (TURN_SHAPED.has(kind)) turnShaped += n
    counts = new Map()
    logger.info('traffic for a session between turns', {
      agentId: scope.agentId,
      chatId: scope.chatId,
      sessionId: scope.sessionId,
      kinds,
      turnShaped
    })
  }

  /** Kinds and counts only: a body can carry anything the agent read. */
  const count = (kind: string): void => {
    if (closed) return
    counts.set(kind, (counts.get(kind) ?? 0) + 1)
    if (!timer) {
      timer = setTimeout(flush, burstMs)
      timer.unref?.()
    }
  }

  const guarded = <T>(what: string, fallback: T, run: () => Promise<T>): Promise<T> =>
    // Through `then`, so a sink that throws synchronously is caught too.
    Promise.resolve().then(run).catch((err: unknown) => {
      logger.warn(`the session traffic sink failed a ${what}; refused`, {
        agentId: scope.agentId,
        sessionId: scope.sessionId,
        error: err instanceof Error ? err.message : String(err)
      })
      return fallback
    })

  // A closed observation hands nothing to its sink: the chat it reported into
  // may be gone or answer to another agent now. Asks are refused, as the
  // default sink would.
  const observer: AcpSessionObserver = {
    onUpdate: (notification) => {
      if (closed) return
      const kind = (notification.update as { sessionUpdate?: unknown }).sessionUpdate
      count(typeof kind === 'string' ? kind : 'unknown')
      try {
        sink.update(notification)
      } catch (err) {
        logger.warn('the session traffic sink threw on an update', {
          agentId: scope.agentId,
          sessionId: scope.sessionId,
          error: String(err)
        })
      }
    },
    onPermission: (params) => {
      if (closed) return Promise.resolve({ outcome: { outcome: 'cancelled' } })
      count('session/request_permission')
      return guarded('permission', { outcome: { outcome: 'cancelled' } }, () => sink.permission(params))
    },
    onElicitation: (params) => {
      if (closed) return Promise.resolve({ action: 'cancel' })
      count('elicitation/create')
      return guarded('question', { action: 'cancel' }, () => sink.elicitation(params))
    },
    onExtNotification: (method) => count(method)
  }

  return {
    observer,
    close: () => {
      if (closed) return
      flush()
      closed = true
    }
  }
}
