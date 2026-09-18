/**
 * The gate between a session's between-turn traffic and a follow-up turn.
 *
 * `claude-agent-acp` runs whole turns of its own after `session/prompt`
 * returned — a background shell finishing wakes the model, which reads the
 * output, merges the PR and says "Merged." (`phase0_findings.md`, Q1/Q5). This
 * file decides which traffic is such a turn starting, and holds what arrives
 * until the turn the app opens for it is bound:
 *
 * - **Starts one:** a `tool_call` for an id no saved turn of the session
 *   used, a message or thought chunk that carries a `messageId`, a `plan`, a
 *   permission ask, a question.
 * - **Dropped:** a `tool_call_update` (or a repeated `tool_call`) for a call
 *   of a turn already saved — Codex sends those after its prompt returned, and
 *   v1 does not rewrite saved rows; and a text chunk with no `messageId` —
 *   Claude's synthetic "**Task stopped by user:** …" after a task stop.
 * - **Not turn content:** everything else (`usage_update`,
 *   `session_info_update`, command, config and mode updates, and the
 *   `async_task_*` / `subagent_*` activity kinds) goes to the `activity` sink,
 *   which is where the session-activity provider plugs in. It opens nothing.
 *
 * From the trigger on, **everything** for the session is buffered in arrival
 * order — updates, and the asks with the promises the agent is blocked on —
 * until the follow-up turn takes it ({@link FollowUpGate.take}) or a turn the
 * user started on the same session does ({@link FollowUpGate.handOver}).
 * Updates past {@link FOLLOW_UP_BUFFER_LIMIT} are counted and logged, never
 * silently lost; asks are never dropped, since the agent waits on each.
 */

import type {
  CreateElicitationRequest,
  CreateElicitationResponse,
  RequestPermissionRequest,
  RequestPermissionResponse,
  SessionNotification
} from '@agentclientprotocol/sdk'
import { createLogger } from '../../../logger/logger'
import type { SessionTrafficScope, SessionTrafficSink } from './acpSessionObserver'
import type { AcpSessionHandlers } from './types'

const logger = createLogger('acp-follow-up')

/** How many updates a session holds while its follow-up turn is being opened. */
export const FOLLOW_UP_BUFFER_LIMIT = 2_000

/** One piece of held traffic. */
export type HeldTraffic =
  | { type: 'update'; notification: SessionNotification }
  | { type: 'permission'; params: RequestPermissionRequest; answer(response: RequestPermissionResponse): void }
  | { type: 'elicitation'; params: CreateElicitationRequest; answer(response: CreateElicitationResponse): void }

const CANCELLED_PERMISSION: RequestPermissionResponse = { outcome: { outcome: 'cancelled' } }
const CANCELLED_QUESTION: CreateElicitationResponse = { action: 'cancel' }

/**
 * Hand one held item to a turn's handlers; an ask's answer goes back to the
 * agent. Synchronous up to the ask's own promise, so a replay loop sees each
 * item in order — an ask is parked before the update after it is folded.
 */
export function deliverHeld(item: HeldTraffic, handlers: AcpSessionHandlers): void {
  switch (item.type) {
    case 'update':
      handlers.onUpdate(item.notification)
      return
    case 'permission': {
      let answer: Promise<RequestPermissionResponse>
      try {
        answer = handlers.onPermission(item.params)
      } catch {
        item.answer(CANCELLED_PERMISSION)
        return
      }
      Promise.resolve(answer).then(item.answer, () => item.answer(CANCELLED_PERMISSION))
      return
    }
    case 'elicitation': {
      if (!handlers.onElicitation) {
        item.answer(CANCELLED_QUESTION)
        return
      }
      let answer: Promise<CreateElicitationResponse>
      try {
        answer = handlers.onElicitation(item.params)
      } catch {
        item.answer(CANCELLED_QUESTION)
        return
      }
      Promise.resolve(answer).then(item.answer, () => item.answer(CANCELLED_QUESTION))
    }
  }
}

/** Refuse a held ask; an update is simply dropped. */
export function refuseHeld(item: HeldTraffic): void {
  if (item.type === 'permission') item.answer(CANCELLED_PERMISSION)
  else if (item.type === 'elicitation') item.answer(CANCELLED_QUESTION)
}

/** What a turn that took a session's held traffic does with it. */
export interface HeldHandover {
  /** In order, into the turn's handlers. */
  replay(handlers: AcpSessionHandlers): void
  /** The session this traffic belonged to is gone: refuse the asks, drop the rest. */
  refuse(): void
  /**
   * The taking turn ended before it replayed this, and the session is
   * observed again: the asks are refused (the agent waits on each), the
   * updates go to `sink` in order — the session's new gate, which may open a
   * follow-up for them.
   */
  giveBack(sink: SessionTrafficSink): void
}

export interface FollowUpGate {
  /** MCP traffic can start a turn before ACP reports its tool call. */
  wake(): boolean
  sink: SessionTrafficSink
  /** A follow-up is wanted and its turn has not taken the traffic yet. */
  readonly pending: boolean
  /**
   * The follow-up turn is bound: hand it what is held. From here until
   * {@link release}, anything that still reaches the gate is held for later.
   */
  take(): HeldTraffic[]
  /**
   * The follow-up turn ended and unbound. `leftover` is what it took and did
   * not use (traffic past its end marker); it and anything held meanwhile are
   * looked at again, and may open the next follow-up.
   */
  release(leftover: HeldTraffic[]): void
  /** Called when the gate closes while a follow-up turn runs. */
  onClose(listener: () => void): () => void
  /**
   * A turn the user started on this session takes over: the held traffic is
   * its now, and no follow-up opens for it.
   */
  handOver(): HeldHandover
  /**
   * Refuse held asks and drop the rest, logging why. The gate goes idle and
   * may open the next follow-up. `level: 'warn'` for a drop the user would
   * miss (the chat stayed busy past the limit), rather than a refusal.
   */
  abandon(reason: string, level?: 'info' | 'warn'): void
  /** The session stopped being observed: refuse and drop, open nothing more. */
  close(): void
}

export interface FollowUpGateOptions {
  /** Where traffic that is not turn content goes (the activity provider's hook). */
  activity: SessionTrafficSink
  /** Tool call ids the session's saved turns used. The gate adds its follow-ups' ids. */
  knownToolCalls: Set<string>
  /** A follow-up is wanted: ask the app to open it. Called once per episode. */
  open(): void
  /**
   * Keep the agent's process up (the pool's hold) while a follow-up is wanted
   * and its turn has not taken the traffic: the reaper must not stop the
   * process the traffic is waiting in. Returns the release.
   */
  hold?(): () => void
  limit?: number
}

type GateState = 'idle' | 'pending' | 'running' | 'closed'

function kindOf(notification: SessionNotification): string {
  const kind = (notification.update as { sessionUpdate?: unknown }).sessionUpdate
  return typeof kind === 'string' ? kind : 'unknown'
}

/** What an update means to a session with no turn bound. */
function classify(notification: SessionNotification, known: ReadonlySet<string>): 'opens' | 'late' | 'synthetic' | 'other' {
  const update = notification.update as { sessionUpdate?: string; toolCallId?: unknown; messageId?: unknown }
  switch (update.sessionUpdate) {
    case 'tool_call':
      return typeof update.toolCallId === 'string' && known.has(update.toolCallId) ? 'late' : 'opens'
    case 'tool_call_update':
      return 'late'
    case 'agent_message_chunk':
    case 'agent_thought_chunk':
      return typeof update.messageId === 'string' && update.messageId !== '' ? 'opens' : 'synthetic'
    case 'plan':
      return 'opens'
    default:
      return 'other'
  }
}

export function createFollowUpGate(scope: SessionTrafficScope, options: FollowUpGateOptions): FollowUpGate {
  const limit = options.limit ?? FOLLOW_UP_BUFFER_LIMIT
  let state: GateState = 'idle'
  let held: HeldTraffic[] = []
  let heldUpdates = 0
  let overflow = 0
  const closeListeners = new Set<() => void>()
  /** The process hold taken at the trigger; released once, on take, hand-over, abandon or close. */
  let releaseHold: (() => void) | null = null
  const letGo = (): void => {
    const release = releaseHold
    releaseHold = null
    if (!release) return
    try {
      release()
    } catch (err) {
      logger.warn('a follow-up’s process hold could not be released', { ...where, error: String(err) })
    }
  }
  const where = { agentId: scope.agentId, chatId: scope.chatId, sessionId: scope.sessionId }

  const reset = (): HeldTraffic[] => {
    const items = held
    if (overflow > 0) {
      logger.warn('a follow-up turn’s buffer overflowed; updates were dropped', { ...where, kept: heldUpdates, dropped: overflow })
    }
    held = []
    heldUpdates = 0
    overflow = 0
    return items
  }

  const hold = (item: HeldTraffic): void => {
    if (item.type === 'update') {
      if (heldUpdates >= limit) {
        overflow += 1
        return
      }
      heldUpdates += 1
    }
    held.push(item)
  }

  const trigger = (item: HeldTraffic | null, why: string): void => {
    state = 'pending'
    if (item) hold(item)
    if (options.hold && !releaseHold) {
      try {
        releaseHold = options.hold()
      } catch (err) {
        logger.warn('a follow-up’s process could not be held', { ...where, error: String(err) })
      }
    }
    logger.info('the agent started a turn on its own; opening a follow-up', { ...where, trigger: why })
    try {
      options.open()
    } catch (err) {
      logger.warn('a follow-up turn could not be asked for', { ...where, error: err instanceof Error ? err.message : String(err) })
      abandon('the request failed')
    }
  }

  /** Traffic while no turn holds the session and nothing is pending. */
  const idle = (item: HeldTraffic): void => {
    if (item.type !== 'update') {
      trigger(item, item.type === 'permission' ? 'session/request_permission' : 'elicitation/create')
      return
    }
    const kind = kindOf(item.notification)
    switch (classify(item.notification, options.knownToolCalls)) {
      case 'opens':
        trigger(item, kind)
        return
      case 'late':
        logger.debug('an update for a tool call of a saved turn; dropped', { ...where, kind })
        return
      case 'synthetic':
        logger.debug('a text chunk with no message id between turns; dropped', { ...where, kind })
        return
      case 'other':
        // The activity provider's hook: not turn content, opens nothing.
        options.activity.update(item.notification)
    }
  }

  const accept = (item: HeldTraffic): void => {
    switch (state) {
      case 'idle':
        idle(item)
        return
      case 'pending':
      case 'running':
        hold(item)
        return
      case 'closed':
        refuseHeld(item)
    }
  }

  const abandon = (reason: string, level: 'info' | 'warn' = 'info'): void => {
    letGo()
    const items = reset()
    if (state !== 'closed') state = 'idle'
    const asks = items.filter((item) => item.type !== 'update').length
    if (items.length > 0) logger[level]('a follow-up turn was not opened; its traffic was dropped', { ...where, reason, updates: items.length - asks, asks })
    for (const item of items) refuseHeld(item)
  }

  const sink: SessionTrafficSink = {
    update: (notification) => accept({ type: 'update', notification }),
    permission: (params) => new Promise<RequestPermissionResponse>((answer) => accept({ type: 'permission', params, answer })),
    elicitation: (params) => new Promise<CreateElicitationResponse>((answer) => accept({ type: 'elicitation', params, answer }))
  }

  return {
    wake: () => { if (state === 'closed') return false; if (state === 'idle') trigger(null, 'MCP tool call'); return true },
    sink,
    get pending() {
      return state === 'pending'
    },
    take: () => {
      if (state !== 'pending') return []
      state = 'running'
      // The turn holds the process itself from here.
      letGo()
      return reset()
    },
    release: (leftover) => {
      if (state !== 'running') {
        for (const item of leftover) refuseHeld(item)
        return
      }
      const again = [...leftover, ...reset()]
      state = 'idle'
      for (const item of again) accept(item)
    },
    onClose: (listener) => {
      closeListeners.add(listener)
      return () => { closeListeners.delete(listener) }
    },
    handOver: () => {
      // The taking turn holds the process.
      letGo()
      const items = reset()
      const running = state === 'running'
      state = 'closed'
      // A running follow-up is bound, so the turn taking over replaces its
      // binding: it has to end rather than wait for traffic it will not see.
      if (running) for (const listener of [...closeListeners]) listener()
      closeListeners.clear()
      return {
        replay: (handlers) => {
          for (const item of items) {
            try {
              deliverHeld(item, handlers)
            } catch (err) {
              logger.warn('a turn threw on traffic held for a follow-up', { ...where, error: String(err) })
            }
          }
        },
        refuse: () => {
          for (const item of items) refuseHeld(item)
        },
        giveBack: (target) => {
          let updates = 0
          for (const item of items) {
            if (item.type !== 'update') {
              refuseHeld(item)
              continue
            }
            updates += 1
            try {
              target.update(item.notification)
            } catch (err) {
              logger.warn('held traffic could not be given back', { ...where, error: String(err) })
            }
          }
          if (items.length > 0) logger.info('a turn ended before it replayed held traffic; given back', { ...where, updates, asks: items.length - updates })
        }
      }
    },
    abandon,
    close: () => {
      if (state === 'closed') return
      const running = state === 'running'
      abandon('the session is no longer observed')
      state = 'closed'
      if (running) for (const listener of [...closeListeners]) listener()
      closeListeners.clear()
    }
  }
}
