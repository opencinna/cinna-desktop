/** Shared ACP session routing for stdio and WebSocket transports. */
import { client } from '@agentclientprotocol/sdk'
import type { AnyMessage, CreateElicitationResponse, RequestPermissionResponse, SessionNotification, Stream } from '@agentclientprotocol/sdk'
import { createLogger } from '../../../logger/logger'
import type { AcpSessionHandlers, AcpSessionObserver } from './types'
const logger = createLogger('acp-client')

/** One buffered piece of session traffic, ready to be replayed into handlers. */
type BufferedDelivery = (handlers: AcpSessionHandlers) => void

interface PreBind {
  deliveries: BufferedDelivery[]
  /** Requests parked waiting for a bind; `null` means the window closed. */
  waiters: ((handlers: AcpSessionHandlers | null) => void)[]
  dropped: number
  timer: NodeJS.Timeout
}

function sessionIdOf(params: unknown): string | undefined {
  if (typeof params !== 'object' || params === null) return undefined
  const id = (params as { sessionId?: unknown }).sessionId
  return typeof id === 'string' ? id : undefined
}

function paramsRecord(params: unknown): Record<string, unknown> {
  return typeof params === 'object' && params !== null ? (params as Record<string, unknown>) : {}
}

/**
 * See every incoming notification first, and keep the ones this file owns.
 *
 * Two things need the transport rather than the SDK's routing. The extension
 * traffic a real adapter sends has no schema, so the SDK drops it silently —
 * `_auth/status_update` appears 25 times in the Claude recordings, alongside
 * `usage_update`, `session_info_update`, `_session/steering`, `_session/goal`.
 * And `session/update` is validated against a closed union before any handler
 * runs (see the header), so an unknown kind never reaches one.
 *
 * `onNotification` returns true for a notification it has taken; that one is
 * not forwarded, so the SDK cannot route or reject it twice. Everything else
 * passes through untouched — responses and requests always do.
 */
function interceptNotifications(
  stream: Stream,
  onNotification: (method: string, params: unknown) => boolean
): Stream {
  const readable = stream.readable.pipeThrough(
    new TransformStream<AnyMessage, AnyMessage>({
      transform(message, controller) {
        if ('method' in message && !('id' in message)) {
          let taken = false
          try {
            taken = onNotification(message.method, message.params)
          } catch (err) {
            logger.warn('notification handler threw', { method: message.method, error: String(err) })
          }
          if (taken) return
        }
        controller.enqueue(message)
      }
    })
  )
  return { writable: stream.writable, readable }
}

export function connectAcpClient(stream: Stream, preBindWindowMs = 10_000, preBindLimit = 500) {
  // ---- session routing -----------------------------------------------------

  const bound = new Map<string, AcpSessionHandlers>()
  /**
   * Who hears a session while no turn is bound to it — the listener that
   * outlives the turn. Consulted only after `bound` and before the pen: a
   * bound turn always wins, and the pen keeps its job for sessions nobody
   * observes (a `session/new` answer racing its own updates).
   *
   * **The caller owns the hazard the pen exists for.** An observed session
   * takes its traffic here, so a turn about to load or prompt an observed
   * session must drop the observer and bind *before* it sends anything that
   * produces traffic — which `acpDriver` does (see `suspendObserver` there).
   */
  const observers = new Map<string, AcpSessionObserver>()
  const preBind = new Map<string, PreBind>()

  const closeWindow = (sessionId: string): void => {
    const held = preBind.get(sessionId)
    if (!held) return
    preBind.delete(sessionId)
    clearTimeout(held.timer)
    if (held.deliveries.length > 0 || held.dropped > 0) {
      logger.warn('dropped traffic for a session nobody bound', {
        sessionId,
        buffered: held.deliveries.length,
        dropped: held.dropped
      })
    }
    for (const waiter of held.waiters) waiter(null)
  }

  const holdingPen = (sessionId: string): PreBind => {
    const existing = preBind.get(sessionId)
    if (existing) return existing
    const held: PreBind = {
      deliveries: [],
      waiters: [],
      dropped: 0,
      timer: setTimeout(() => closeWindow(sessionId), preBindWindowMs)
    }
    // The window must never be the reason the app stays awake.
    held.timer.unref?.()
    preBind.set(sessionId, held)
    return held
  }

  const deliver = (sessionId: string, delivery: BufferedDelivery): void => {
    const handlers = bound.get(sessionId) ?? observers.get(sessionId)
    if (handlers) {
      try {
        delivery(handlers)
      } catch (err) {
        logger.warn('session handler threw', { sessionId, error: String(err) })
      }
      return
    }
    const held = holdingPen(sessionId)
    if (held.deliveries.length >= preBindLimit) {
      held.dropped += 1
      return
    }
    held.deliveries.push(delivery)
  }

  /**
   * The handlers for a session, waiting up to the pre-bind window for a bind.
   *
   * `null` means nobody claimed the session in time — the caller answers the
   * agent's blocking request with a cancellation rather than leaving it hanging
   * on a turn that never existed.
   */
  const handlersFor = (sessionId: string): Promise<AcpSessionHandlers | null> => {
    const now = bound.get(sessionId) ?? observers.get(sessionId)
    if (now) return Promise.resolve(now)
    return new Promise((resolve) => holdingPen(sessionId).waiters.push(resolve))
  }

  /** Hand whatever the pen holds for a session to whoever just claimed it. */
  const drainPen = (sessionId: string, handlers: AcpSessionHandlers): void => {
    const held = preBind.get(sessionId)
    if (!held) return
    preBind.delete(sessionId)
    clearTimeout(held.timer)
    if (held.dropped > 0) {
      logger.warn('pre-bind buffer overflowed before the bind', {
        sessionId,
        kept: held.deliveries.length,
        dropped: held.dropped
      })
    }
    // In order, and before the parked requests resume: the waiters below can
    // only continue on a microtask, so a permission ask never overtakes the
    // updates that led to it.
    for (const delivery of held.deliveries) {
      try {
        delivery(handlers)
      } catch (err) {
        logger.warn('session handler threw on buffered traffic', { sessionId, error: String(err) })
      }
    }
    for (const waiter of held.waiters) waiter(handlers)
  }

  const bindSession = (sessionId: string, handlers: AcpSessionHandlers): (() => void) => {
    bound.set(sessionId, handlers)
    drainPen(sessionId, handlers)
    return () => {
      if (bound.get(sessionId) === handlers) bound.delete(sessionId)
    }
  }

  const observeSession = (sessionId: string, observer: AcpSessionObserver): (() => void) => {
    observers.set(sessionId, observer)
    // Only when no turn holds the session: a bound turn owns anything the pen
    // could hold, and it has already drained it.
    if (!bound.has(sessionId)) drainPen(sessionId, observer)
    return () => {
      if (observers.get(sessionId) === observer) observers.delete(sessionId)
    }
  }

  // ---- the client ----------------------------------------------------------

  // No `session/update` handler here on purpose — it is routed from the
  // transport tap below, where the SDK's schema cannot drop a kind it has not
  // heard of. Requests keep the typed handlers: an agent blocked on one needs a
  // valid answer, and validating what we answer is worth having.
  const app = client({ name: 'cinna-desktop' })
    .onRequest('session/request_permission', async (ctx) => {
      const handlers = await handlersFor(ctx.params.sessionId)
      if (!handlers) {
        logger.warn('permission asked for a session nobody bound', {
          sessionId: ctx.params.sessionId
        })
        return { outcome: { outcome: 'cancelled' } } satisfies RequestPermissionResponse
      }
      return handlers.onPermission(ctx.params)
    })
    .onRequest('elicitation/create', async (ctx) => {
      const sessionId = sessionIdOf(ctx.params)
      const handlers = sessionId ? await handlersFor(sessionId) : null
      if (!handlers?.onElicitation) {
        logger.warn('elicitation asked for a session nobody bound', { sessionId })
        return { action: 'cancel' } satisfies CreateElicitationResponse
      }
      return handlers.onElicitation(ctx.params)
    })

  const transport = interceptNotifications(
    stream,
    (method, params) => {
      if (method === 'session/update') {
        const owner = sessionIdOf(params)
        const update = paramsRecord(params).update
        if (!owner || typeof update !== 'object' || update === null) {
          // Not addressed to a session, or carrying no update: there is nothing
          // to route it by. Taken all the same — handing the SDK a frame it can
          // only throw on gains nothing.
          logger.warn('session/update with no session id or no update')
          return true
        }
        // Whatever kind it is. The translator decides what it can fold; this
        // layer only decides whose turn it belongs to.
        const notification = params as SessionNotification
        deliver(owner, (handlers) => handlers.onUpdate(notification))
        return true
      }
      // `$/cancel_request` is the JSON-RPC layer's own. Everything else is an
      // extension, and the ones that name a session belong to that turn.
      if (method.startsWith('$/')) return false
      const sessionId = sessionIdOf(params)
      if (!sessionId) {
        // `_auth/status_update` is the one we know arrives this way — twice per
        // start, before `session/new` has even answered
        // (`claude/recordings/s1-session-new-mcp.ndjson`). It names no session,
        // so no turn can own it, and it carries the account email, so it is not
        // something to log the body of.
        logger.debug('extension notification with no session', { method })
        return false
      }
      const record = paramsRecord(params)
      deliver(sessionId, (handlers) => handlers.onExtNotification?.(method, record))
      return false
    }
  )

  const connection = app.connect(transport)
  return { connection, bindSession, observeSession, clearRouting: () => {
    for (const sessionId of [...preBind.keys()]) closeWindow(sessionId)
    bound.clear()
    observers.clear()
  } }
}
