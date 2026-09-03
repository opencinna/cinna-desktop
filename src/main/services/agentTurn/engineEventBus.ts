/**
 * One subscription to the engine's global event stream, fanned out by session.
 *
 * ## Why one, and why global
 *
 * One `opencode serve` backs every folder agent, and `GET /api/event` carries
 * every session's events. A subscription per turn would therefore open N
 * sockets that each receive all N turns' events and discard N-1 of them. One
 * process-wide subscription, fanned out by `data.sessionID`, is the shape the
 * contract implies.
 *
 * The global stream is also the *only* place the deltas, permission asks and
 * question asks live — the durable per-session stream has none of them. See the
 * header of `engineEvents.ts` for the full split; it is the fact that most
 * shapes this module.
 *
 * ## Why a turn must wait for {@link EngineEventBus.ready} before prompting
 *
 * `POST /api/session/{id}/prompt` returns an admission ack, not the answer, and
 * the agent loop starts immediately. Anything emitted before this socket is
 * live is gone — the global stream takes no `after` cursor, so there is no
 * replay for the opening milliseconds. Connect first, prompt second. That
 * ordering is not an optimisation; it is the difference between a turn that
 * streams and one that appears to hang until its first tool call.
 *
 * ## What a listener is told about the connection, and why it needs to know
 *
 * Because the stream cannot be resumed, a reconnect is a **hole**, not a
 * hiccup. Listeners are told when the socket drops and when a new one is live
 * so the runner can go and fill the hole from the durable per-session stream,
 * which is resumable and — since `session.next.step.ended` is one of its 28
 * variants — carries the end of the turn as well as the words. Swallowing a
 * reconnect and carrying on would silently truncate an answer, which is the
 * failure mode hardest to notice and worst to debug.
 *
 * ## Lifetime
 *
 * Connected lazily on the first subscriber and disconnected on the last, so an
 * idle desktop holds no socket open against the engine. The transport is
 * injected rather than imported: `engineManager.request` stays the only door to
 * the engine, and this module receives that door instead of opening its own —
 * which also lets the whole reconnect state machine be tested without a
 * process, a port or Electron.
 */

import { createLogger } from '../../logger/logger'
import { ENGINE_EVENT, eventSessionId, parseEngineEvent, type EngineEvent } from './engineEvents'
import { SseParser } from './sseParser'

const logger = createLogger('engine-events')

/** Backoff between reconnect attempts, in ms. Capped rather than unbounded. */
export const RECONNECT_DELAYS_MS = [250, 500, 1_000, 2_000, 5_000] as const

/**
 * Opens the event stream. Resolves to the response body, or throws.
 *
 * Production passes a function over `engineManager.request('/api/event', …)`.
 * Returning the raw body (rather than an async iterator) keeps the transport
 * dumb enough that a test can hand over a hand-rolled `ReadableStream`.
 */
export type EngineStreamTransport = (
  signal: AbortSignal
) => Promise<ReadableStream<Uint8Array> | null>

export interface SessionEventListener {
  /** One event for this session, in arrival order. */
  onEvent(event: EngineEvent): void
  /**
   * The socket dropped. Everything emitted from now until {@link onReconnect}
   * is lost and unrecoverable from this stream.
   */
  onDisconnect(): void
  /**
   * A new socket is live. The gap between the disconnect and this call has to
   * be filled from the durable per-session stream by the listener.
   */
  onReconnect(): void
  /**
   * The stream is gone and **no reconnect is coming** — the engine stopped.
   *
   * Distinct from {@link onDisconnect}, and the distinction is load-bearing
   * rather than tidy. A disconnect is a hole in a stream that will come back,
   * so the right response is to wait and then heal. A close is the end of the
   * world the session id belonged to: `ses_…` died with the process that
   * issued it, nothing will ever arrive for it again, and a turn that treats
   * this as a disconnect waits for a reconnect that cannot happen — holding
   * its per-agent lock forever, which in turn makes `applyConfigChange` refuse
   * to restart the engine for as long as the app lives.
   */
  onClosed(): void
}

/** Wait helper, injectable so tests do not spend real seconds in backoff. */
export type SleepFn = (ms: number) => Promise<void>

const realSleep: SleepFn = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

export class EngineEventBus {
  private readonly listeners = new Map<string, Set<SessionEventListener>>()
  private controller: AbortController | null = null
  private pumping: Promise<void> | null = null
  /**
   * Which pump is the live one.
   *
   * `pumping` alone cannot answer that. `stop()` aborts the socket but the
   * pump's loop keeps unwinding — through up to five seconds of reconnect
   * backoff — before its promise settles, so for that whole window `pumping` is
   * non-null while nothing is reading anything. A `start()` that gated on
   * `pumping` returned early there, leaving `readyPromise` null, and `ready()`
   * then did `await null` and resolved: a turn was told the stream was up,
   * prompted into it, and never heard another word. The generation makes "a
   * pump exists" and "a pump is live" different questions.
   */
  private pumpGeneration = 0
  /** Resolves when a socket is live; replaced on every disconnect. */
  private readyPromise: Promise<void> | null = null
  private readyResolve: (() => void) | null = null
  private readyReject: ((err: unknown) => void) | null = null
  private connected = false
  private stopped = false

  constructor(
    private readonly transport: EngineStreamTransport,
    private readonly sleep: SleepFn = realSleep
  ) {}

  /**
   * Register a listener for one session. Returns an unsubscribe function.
   *
   * Subscribing is what starts the stream, and the *last* unsubscribe is what
   * stops it — so a turn that registers before prompting cannot miss its own
   * opening events, and an idle app holds nothing open.
   */
  subscribe(sessionId: string, listener: SessionEventListener): () => void {
    const set = this.listeners.get(sessionId) ?? new Set()
    set.add(listener)
    this.listeners.set(sessionId, set)
    this.start()

    let removed = false
    return () => {
      if (removed) return
      removed = true
      const current = this.listeners.get(sessionId)
      if (!current) return
      current.delete(listener)
      if (current.size === 0) this.listeners.delete(sessionId)
      if (this.listeners.size === 0) this.stop()
    }
  }

  /**
   * Resolve once a socket is live, or reject if the stream cannot be opened.
   *
   * A turn awaits this before `POST /prompt`. It rejects rather than hanging so
   * a turn against a dead engine fails as a turn error the user can read,
   * instead of waiting forever for deltas that will never come.
   */
  async ready(): Promise<void> {
    if (this.connected) return
    if (!this.readyPromise) this.start()
    if (!this.readyPromise) {
      // `await null` resolves, so a missing promise here would read to the
      // caller as "the stream is up" — and a turn told that prompts into a
      // socket nobody is reading and never settles, holding its lock forever.
      // This is the assertion that turns that into a turn error the user can
      // read.
      //
      // **Honest note: no test pins this line, and it is currently
      // unreachable.** The mutation that deletes it was run and passed the
      // whole suite. That is correct rather than a gap: with the generation
      // check in `start()` fixed, a live pump always implies an armed
      // `readyPromise` — `armReady` runs in `start()` and only `stop()` clears
      // it, and `stop()` sets `stopped`, which now makes `start()` begin a new
      // pump. So the two halves are not independent as they first appeared;
      // the generation fix is load-bearing and this is defence behind it.
      // Keep it — if anyone reintroduces an early return in `start()`, this is
      // what turns a silent hang into a loud failure — but do not write a test
      // claiming to cover it.
      throw new Error('The engine event stream could not be opened.')
    }
    await this.readyPromise
  }

  /** True while a socket is live. Diagnostics and tests; not a turn gate. */
  isConnected(): boolean {
    return this.connected
  }

  /**
   * Drop the connection and forget every listener.
   *
   * Called when the engine stops — every session id the engine knew about died
   * with it, so holding listeners would leave turns waiting on events from a
   * process that no longer exists.
   */
  shutdown(): void {
    for (const [, set] of this.listeners) {
      for (const listener of set) safely(() => listener.onClosed(), 'onClosed')
    }
    this.listeners.clear()
    this.stop()
  }

  private start(): void {
    // A pump that has been stopped is not a live pump, however long its loop
    // takes to notice.
    if (this.pumping && !this.stopped) return
    this.stopped = false
    this.pumpGeneration += 1
    const generation = this.pumpGeneration
    this.armReady()
    this.controller = new AbortController()
    const signal = this.controller.signal
    const pump = this.pump(signal, generation).finally(() => {
      // Only the live generation may clear the handle. An old pump settling
      // after a new one started would otherwise null out the new one's, and
      // the next `start()` would spawn a third.
      if (this.pumpGeneration === generation) this.pumping = null
    })
    this.pumping = pump
  }

  /** True when this pump has been superseded or aborted and must touch nothing. */
  private isDead(generation: number, signal: AbortSignal): boolean {
    return this.pumpGeneration !== generation || this.stopped || signal.aborted
  }

  private stop(): void {
    this.stopped = true
    this.controller?.abort()
    this.controller = null
    this.connected = false
    // A `ready()` awaited by a turn that is being torn down must not hang.
    this.settleReady(new Error('The engine event stream was closed.'))
  }

  private armReady(): void {
    if (this.readyPromise) return
    this.readyPromise = new Promise<void>((resolve, reject) => {
      this.readyResolve = resolve
      this.readyReject = reject
    })
    // Nothing may await this promise (a bus that reconnects with no `ready()`
    // caller), and an unhandled rejection would take the process down.
    this.readyPromise.catch(() => {})
  }

  /**
   * Throw away the resolved `ready` promise and arm a fresh one.
   *
   * Needed on every disconnect, and easy to get wrong: `armReady` is a no-op
   * while a promise exists, so re-arming without clearing first would leave the
   * *previous, already-resolved* promise in place and `ready()` would answer
   * "connected" for a socket that just died — a turn would then prompt into a
   * stream nobody is reading.
   */
  private resetReady(): void {
    this.readyPromise = null
    this.readyResolve = null
    this.readyReject = null
    this.armReady()
  }

  private settleReady(err?: unknown): void {
    if (err) this.readyReject?.(err)
    else this.readyResolve?.()
    this.readyResolve = null
    this.readyReject = null
    if (err) this.readyPromise = null
  }

  /**
   * Connect, read, and reconnect until stopped.
   *
   * The attempt counter resets on every *successful* connection, so a stream
   * that survives an hour and then drops retries promptly rather than inheriting
   * the backoff of some failure long past.
   */
  private async pump(signal: AbortSignal, generation: number): Promise<void> {
    let attempt = 0
    const parser = new SseParser()
    // Only a socket that comes back *after* one dropped is a reconnect. The
    // first connection of a pump is not: a listener told "reconnected" there
    // would go and fill a gap that does not exist, from a cursor it has never
    // held.
    let hadDisconnect = false

    while (!this.isDead(generation, signal)) {
      let body: ReadableStream<Uint8Array> | null = null
      try {
        body = await this.transport(signal)
      } catch (err) {
        if (this.isDead(generation, signal)) return
        logger.warn('could not open the engine event stream', { error: String(err) })
      }

      // Re-checked after the await: a transport that resolves *after* a stop
      // would otherwise publish `connected` and settle `ready` for a pump
      // nobody is listening to.
      if (this.isDead(generation, signal)) return

      if (body) {
        attempt = 0
        parser.reset()
        this.connected = true
        this.settleReady()
        if (hadDisconnect) this.notifyAll((l) => l.onReconnect())
        try {
          await this.read(body, parser, signal)
        } catch (err) {
          if (!this.stopped && !signal.aborted) {
            logger.warn('the engine event stream failed mid-read', { error: String(err) })
          }
        }
        this.connected = false
        if (this.isDead(generation, signal)) return
        // A clean end-of-body is still a disconnect: the engine restarted, or
        // something between us closed it. Either way the gap is real.
        logger.info('the engine event stream dropped; reconnecting')
        hadDisconnect = true
        this.notifyAll((l) => l.onDisconnect())
        this.resetReady()
      }

      if (this.isDead(generation, signal)) return
      const delay = RECONNECT_DELAYS_MS[Math.min(attempt, RECONNECT_DELAYS_MS.length - 1)]
      attempt += 1
      await this.sleep(delay)
    }
  }

  private async read(
    body: ReadableStream<Uint8Array>,
    parser: SseParser,
    signal: AbortSignal
  ): Promise<void> {
    const reader = body.getReader()
    const decoder = new TextDecoder()
    try {
      for (;;) {
        const { done, value } = await reader.read()
        if (done) return
        if (this.stopped || signal.aborted) return
        // `stream: true` so a multi-byte character split across two chunks is
        // held rather than emitted as replacement characters — the agent's own
        // prose streams through here.
        for (const message of parser.feed(decoder.decode(value, { stream: true }))) {
          this.dispatch(message.data)
        }
      }
    } finally {
      // Releasing the lock lets an aborted body be collected; cancel() would
      // throw on a body the abort already tore down.
      safely(() => reader.releaseLock(), 'releaseLock')
    }
  }

  private dispatch(payload: string): void {
    const event = parseEngineEvent(payload)
    if (!event) {
      logger.debug('dropped an unparseable engine event')
      return
    }
    const sessionId = eventSessionId(event)
    if (!sessionId) {
      // `SessionError.data` declares no required fields, so an error genuinely
      // can name no session. Broadcasting it would end every unrelated turn in
      // flight, so it is logged and dropped — visible, not acted on.
      if (event.type === ENGINE_EVENT.error) {
        logger.warn('engine reported an error against no session', { data: event.data })
      } else {
        logger.debug('dropped an engine event with no session id', { type: event.type })
      }
      return
    }
    const set = this.listeners.get(sessionId)
    if (!set || set.size === 0) return
    // Iterating the live Set is safe here, and deliberately not snapshotted:
    // a listener routinely unsubscribes from inside its own handler (an `idle`
    // ends the turn, and the turn's cleanup releases its subscription), and a
    // `Set` iterator tolerates the deletion of an entry it has already visited
    // — unlike an index loop over an array, which would skip its neighbour. A
    // `[...set]` snapshot here was written first, and removed once the
    // mutation that was supposed to justify it (`of [...set]` → `of set`)
    // passed the whole suite. Do not add it back without a test that fails
    // without it; if this ever becomes an array, it needs one.
    for (const listener of set) {
      safely(() => listener.onEvent(event), 'onEvent')
    }
  }

  private notifyAll(fn: (listener: SessionEventListener) => void): void {
    for (const [, set] of [...this.listeners]) {
      for (const listener of [...set]) safely(() => fn(listener), 'connection notice')
    }
  }
}

/**
 * Run a listener callback without letting it take the pump down.
 *
 * One turn's handler throwing must not stop every other turn's events — the
 * bus is shared, so an unguarded callback would make one bad turn a global
 * outage.
 */
function safely(fn: () => void, what: string): void {
  try {
    fn()
  } catch (err) {
    logger.error(`an engine event listener threw in ${what}`, { error: String(err) })
  }
}
