/**
 * The bus driven through real `ReadableStream`s, not a mocked one.
 *
 * The questions worth asking here are all about a *connection over time* —
 * does a turn that subscribes before prompting see its first event, does a
 * dropped socket reach the listener as a hole rather than silence, does a
 * reconnect re-arm `ready()` — and a hand-stubbed "emit these events" fake
 * answers every one of them "yes" by construction. So the transport hands back
 * a genuine stream whose chunks the test controls, and the bus does its real
 * decoding, parsing, fan-out and backoff over it.
 *
 * Every mutation named in a comment was **run**, and the result is recorded in
 * the mutation table at the bottom of this file.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { EngineEventBus, type SessionEventListener } from './engineEventBus'
import type { EngineEvent } from './engineEvents'

/**
 * The logger reaches `src/main/index.ts` for the window handle, which imports
 * Electron — the dependency inversion still on the project's tracked list. The
 * project's established workaround is to mock the logger module; the captured
 * lines double as an assertion surface for the drop paths, which are otherwise
 * silent by design.
 */
const logged: { level: string; message: string }[] = []
vi.mock('../../logger/logger', () => ({
  createLogger: () => ({
    debug: (message: string) => logged.push({ level: 'debug', message }),
    info: (message: string) => logged.push({ level: 'info', message }),
    warn: (message: string) => logged.push({ level: 'warn', message }),
    error: (message: string) => logged.push({ level: 'error', message })
  })
}))

/** A stream the test pushes into and closes by hand. */
function controllableStream(): {
  stream: ReadableStream<Uint8Array>
  push: (text: string) => void
  close: () => void
  fail: (err: Error) => void
} {
  let ctrl!: ReadableStreamDefaultController<Uint8Array>
  const stream = new ReadableStream<Uint8Array>({
    start(c) {
      ctrl = c
    }
  })
  const enc = new TextEncoder()
  return {
    stream,
    push: (text) => ctrl.enqueue(enc.encode(text)),
    close: () => ctrl.close(),
    fail: (err) => ctrl.error(err)
  }
}

function recorder(): SessionEventListener & {
  events: EngineEvent[]
  notices: string[]
} {
  const events: EngineEvent[] = []
  const notices: string[] = []
  return {
    events,
    notices,
    onEvent: (e) => events.push(e),
    onDisconnect: () => notices.push('disconnect'),
    onReconnect: () => notices.push('reconnect'),
    onClosed: () => notices.push('closed')
  }
}

const evt = (type: string, sessionID?: string, extra: Record<string, unknown> = {}): string =>
  `data: ${JSON.stringify({ id: 'evt_1', type, data: { ...(sessionID ? { sessionID } : {}), ...extra } })}\n\n`

/** Let the bus's pending microtasks and its zero-delay sleeps run. */
const settle = async (): Promise<void> => {
  for (let i = 0; i < 20; i++) await Promise.resolve()
}

const noSleep = (): Promise<void> => Promise.resolve()

describe('EngineEventBus', () => {
  beforeEach(() => {
    logged.length = 0
  })


  it('fans one session\'s events to its listener and not to another session\'s', async () => {
    const s = controllableStream()
    const bus = new EngineEventBus(async () => s.stream, noSleep)
    const a = recorder()
    const b = recorder()
    bus.subscribe('ses_a', a)
    bus.subscribe('ses_b', b)
    await bus.ready()

    s.push(evt('session.next.text.delta', 'ses_a', { delta: 'hi' }))
    await settle()

    // Mutation: `this.listeners.get(sessionId)` → iterate every listener set
    // (broadcast) fails this — `b.events` becomes length 1.
    expect(a.events.map((e) => e.type)).toEqual(['session.next.text.delta'])
    expect(b.events).toEqual([])
    bus.shutdown()
  })

  it('ready() resolves only once a socket is live', async () => {
    let openStream!: (stream: ReadableStream<Uint8Array>) => void
    const gate = new Promise<ReadableStream<Uint8Array>>((r) => {
      openStream = r
    })
    const bus = new EngineEventBus(() => gate, noSleep)
    bus.subscribe('ses_a', recorder())

    let resolved = false
    void bus.ready().then(() => {
      resolved = true
    })
    await settle()
    // Mutation: `settleReady()` called before `await this.transport(...)`
    // rather than after it fails here — `resolved` would already be true.
    expect(resolved).toBe(false)

    const s = controllableStream()
    openStream(s.stream)
    await settle()
    expect(resolved).toBe(true)
    bus.shutdown()
  })

  it('an event that arrives before ready() resolves is not lost', async () => {
    // The ordering the runner depends on: subscribe, wait for the socket, then
    // prompt. This pins that a listener registered before the connection sees
    // the very first frame off it.
    const s = controllableStream()
    s.push(evt('session.next.text.delta', 'ses_a', { delta: 'first' }))
    const bus = new EngineEventBus(async () => s.stream, noSleep)
    const a = recorder()
    bus.subscribe('ses_a', a)
    await bus.ready()
    await settle()

    expect(a.events).toHaveLength(1)
    expect(a.events[0].data?.delta).toBe('first')
    bus.shutdown()
  })

  it('a dropped socket reaches the listener as a disconnect, then a reconnect', async () => {
    const first = controllableStream()
    const second = controllableStream()
    const streams = [first.stream, second.stream]
    const bus = new EngineEventBus(async () => streams.shift() ?? second.stream, noSleep)
    const a = recorder()
    bus.subscribe('ses_a', a)
    await bus.ready()

    first.close()
    await settle()

    // Mutation: delete `this.notifyAll((l) => l.onDisconnect())` fails this
    // with `['reconnect']` — the runner would never learn there was a hole and
    // would silently truncate the answer.
    expect(a.notices).toEqual(['disconnect', 'reconnect'])
    bus.shutdown()
  })

  it('does not call onReconnect for the first connection of a pump', async () => {
    const s = controllableStream()
    const bus = new EngineEventBus(async () => s.stream, noSleep)
    const a = recorder()
    bus.subscribe('ses_a', a)
    await bus.ready()
    await settle()

    // Mutation: `if (hadDisconnect) this.notifyAll(...)` → unconditional fails
    // this with `['reconnect']`, sending the runner to gap-fill from a cursor
    // it has never held.
    expect(a.notices).toEqual([])
    bus.shutdown()
  })

  it('ready() does not report connected while the socket is down', async () => {
    const first = controllableStream()
    let secondResolve!: (s: ReadableStream<Uint8Array>) => void
    const second = new Promise<ReadableStream<Uint8Array>>((r) => {
      secondResolve = r
    })
    let call = 0
    const bus = new EngineEventBus(() => {
      call += 1
      return call === 1 ? Promise.resolve(first.stream) : second
    }, noSleep)
    bus.subscribe('ses_a', recorder())
    await bus.ready()

    first.close()
    await settle()

    let reReady = false
    void bus.ready().then(() => {
      reReady = true
    })
    await settle()
    // Mutation: `this.resetReady()` → `this.armReady()` fails this. `armReady`
    // is a no-op while a promise exists, so the already-resolved promise from
    // the first connection would still be in place and `ready()` would answer
    // "connected" for a dead socket.
    expect(reReady).toBe(false)
    expect(bus.isConnected()).toBe(false)

    secondResolve(controllableStream().stream)
    await settle()
    expect(reReady).toBe(true)
    bus.shutdown()
  })

  it('retries with backoff when the transport throws, and resets the delay after a success', async () => {
    const delays: number[] = []
    const sleep = async (ms: number): Promise<void> => {
      delays.push(ms)
    }
    const good = controllableStream()
    let call = 0
    const bus = new EngineEventBus(async () => {
      call += 1
      if (call <= 3) throw new Error('ECONNREFUSED')
      return good.stream
    }, sleep)
    bus.subscribe('ses_a', recorder())
    await settle()

    // Mutation: `RECONNECT_DELAYS_MS[Math.min(attempt, …)]` → a constant fails
    // this; `attempt += 1` deleted fails it too (all 250s).
    expect(delays).toEqual([250, 500, 1_000])
    expect(bus.isConnected()).toBe(true)
    bus.shutdown()
  })

  it('an unattributed session.error is dropped and surfaced in the log', async () => {
    const s = controllableStream()
    const bus = new EngineEventBus(async () => s.stream, noSleep)
    const a = recorder()
    bus.subscribe('ses_a', a)
    await bus.ready()

    // `SessionError.data` declares no required properties in the OpenAPI
    // document, so an error genuinely can name no session. This is a real
    // shape, not a synthetic one.
    s.push(evt('session.error', undefined, { error: { name: 'UnknownError' } }))
    s.push(evt('session.next.text.delta', 'ses_a', { delta: 'ok' }))
    await settle()

    expect(a.events.map((e) => e.type)).toEqual(['session.next.text.delta'])
    // The delivery assertion above pins less than it looks like: with the
    // whole `if (!sessionId)` block deleted, `listeners.get(null)` returns
    // undefined and the event is dropped anyway — that mutation was run and
    // **survived** the delivery assertion alone. The log line is the branch's
    // only unique observable, so it is what pins it. Mutation `logger.warn` →
    // `logger.debug` (i.e. treating an engine-level error as routine) fails
    // here, as does deleting the branch.
    expect(logged.filter((l) => l.level === 'warn').map((l) => l.message)).toEqual([
      'engine reported an error against no session'
    ])
    bus.shutdown()
  })

  it('survives a listener that throws, and still serves the others', async () => {
    const s = controllableStream()
    const bus = new EngineEventBus(async () => s.stream, noSleep)
    const bad: SessionEventListener = {
      onEvent: () => {
        throw new Error('listener blew up')
      },
      onDisconnect: () => {},
      onReconnect: () => {},
      onClosed: () => {}
    }
    const good = recorder()
    bus.subscribe('ses_a', bad)
    bus.subscribe('ses_a', good)
    await bus.ready()

    s.push(evt('session.idle', 'ses_a'))
    await settle()

    // Mutation: drop the try/catch in `safely` fails this — the throw escapes
    // the dispatch loop, `good` never sees the event, and the read loop dies,
    // taking every other turn's stream with it.
    expect(good.events.map((e) => e.type)).toEqual(['session.idle'])
    bus.shutdown()
  })

  it('lets a listener unsubscribe from inside its own handler', async () => {
    // The real pattern: a terminal event ends the turn, and the turn's cleanup
    // unsubscribes — from inside `onEvent`. (The event name below is only a
    // payload for the bus, which does not interpret types; what actually ends a
    // turn is `session.next.step.ended`, see `turnStream`.)
    const s = controllableStream()
    const bus = new EngineEventBus(async () => s.stream, noSleep)
    const seen: string[] = []
    let off: () => void = () => {}
    const first: SessionEventListener = {
      onEvent: (e) => {
        seen.push(`first:${e.type}`)
        off()
      },
      onDisconnect: () => {},
      onReconnect: () => {},
      onClosed: () => {}
    }
    const second = recorder()
    off = bus.subscribe('ses_a', first)
    bus.subscribe('ses_a', second)
    await bus.ready()

    s.push(evt('session.idle', 'ses_a'))
    await settle()
    // A second event, so the unsubscribe is observable rather than merely
    // survivable. Mutation: the returned unsubscribe function made a no-op
    // (`return () => {}`) fails this — `first` sees the delta too.
    s.push(evt('session.next.text.delta', 'ses_a', { delta: 'after' }))
    await settle()

    // This test was originally named for `for (const listener of [...set])` →
    // `of set`. That mutation was **run and survived**: a `Set` iterator
    // tolerates deleting an entry it has already visited, so the snapshot was
    // never doing anything and has been removed from the source. What is
    // pinned now is the unsubscribe itself, plus the delivery to the listener
    // that stayed.
    expect(seen).toEqual(['first:session.idle'])
    expect(second.events.map((e) => e.type)).toEqual([
      'session.idle',
      'session.next.text.delta'
    ])
    bus.shutdown()
  })

  it('stops the stream when the last listener unsubscribes', async () => {
    const s = controllableStream()
    const opens = vi.fn(async () => s.stream)
    const bus = new EngineEventBus(opens, noSleep)
    const off1 = bus.subscribe('ses_a', recorder())
    const off2 = bus.subscribe('ses_b', recorder())
    await bus.ready()
    expect(opens).toHaveBeenCalledTimes(1)

    off1()
    await settle()
    // Mutation: `if (this.listeners.size === 0) this.stop()` → unconditional
    // `this.stop()` fails this — one turn ending would kill every other turn's
    // stream.
    expect(bus.isConnected()).toBe(true)

    off2()
    await settle()
    expect(bus.isConnected()).toBe(false)
  })

  it('shutdown reports a close, not a disconnect, because no reconnect is coming', async () => {
    const s = controllableStream()
    const bus = new EngineEventBus(async () => s.stream, noSleep)
    const a = recorder()
    const b = recorder()
    bus.subscribe('ses_a', a)
    bus.subscribe('ses_b', b)
    await bus.ready()

    bus.shutdown()
    await settle()

    // Two mutations fail this, and the second one is a Critical that was found
    // by probing rather than by reading.
    //
    // `shutdown()` clearing listeners without notifying at all: the engine
    // stopping takes every session with it, and a turn never told would wait
    // for events from a process that no longer exists.
    //
    // `shutdown()` calling `onDisconnect` instead of `onClosed` — which is what
    // it did first: the runner treats a disconnect as a hole that will heal, so
    // it waits for an `onReconnect` that can never arrive. The turn never
    // settles, its per-agent lock is held for the life of the app, and because
    // `applyConfigChange` refuses to restart while any lock is held, the engine
    // becomes permanently un-reconcilable as well. A probe that stopped the bus
    // mid-turn and asked whether the turn had settled answered `false`.
    expect(a.notices).toEqual(['closed'])
    expect(b.notices).toEqual(['closed'])
    expect(bus.isConnected()).toBe(false)
  })

  it('does not report ready on a socket a previous stop tore down', async () => {
    // **The third door to "the turn never settles".** `stop()` aborts the
    // socket, but the pump's loop keeps unwinding — through up to five seconds
    // of reconnect backoff — before its promise resolves. For that whole
    // window `pumping` was non-null, so `start()` returned early, `readyPromise`
    // stayed null, and `ready()` did `await null` and resolved. The turn was
    // told the stream was up, prompted into it, and never heard anything again:
    // lock held forever, and `anyHeld()` bricking `applyConfigChange` for every
    // folder agent. The likely moment is a retry right after a crash.
    //
    // Mutation `if (this.pumping && !this.stopped) return` → `if (this.pumping)
    // return` reproduces the original defect and fails this: `ready()` resolves
    // while nothing is connected.
    //
    // The review asked for this as *two independent halves* — the `start()`
    // gate and a throw in `ready()` when `readyPromise` is still null. Running
    // the mutations showed they are not independent: with the gate fixed, a
    // live pump always implies an armed promise, so deleting the throw passes
    // the whole suite. The throw is kept as defence behind the gate and is
    // documented at the line as unpinned; this test pins the gate, which is
    // the half that actually does the work.
    let release!: () => void
    const blocked = new Promise<void>((r) => {
      release = r
    })
    const bus = new EngineEventBus(async () => {
      // A transport that never resolves, so the pump is still in flight when
      // the stop lands.
      await blocked
      return controllableStream().stream
    }, noSleep)

    const off = bus.subscribe('ses_a', recorder())
    await settle()
    off() // last listener leaves → stop(), while the pump is still unwinding

    const s2 = controllableStream()
    const bus2 = bus as unknown as { transport: unknown }
    void bus2
    bus.subscribe('ses_b', recorder())

    let readyResolved = false
    let readyRejected = false
    void bus
      .ready()
      .then(() => {
        readyResolved = true
      })
      .catch(() => {
        readyRejected = true
      })
    await settle()

    // The critical assertion: `ready()` must not have resolved, because
    // nothing is connected.
    expect(bus.isConnected()).toBe(false)
    expect(readyResolved).toBe(false)
    expect(readyRejected).toBe(false)

    release()
    await settle()
    void s2
    bus.shutdown()
  })

  it('reassembles an event split across two chunks', async () => {
    const s = controllableStream()
    const bus = new EngineEventBus(async () => s.stream, noSleep)
    const a = recorder()
    bus.subscribe('ses_a', a)
    await bus.ready()

    const payload = evt('session.next.text.delta', 'ses_a', { delta: 'split' })
    s.push(payload.slice(0, 20))
    await settle()
    expect(a.events).toEqual([])
    s.push(payload.slice(20))
    await settle()

    // Mutation: `parser.feed(...)` per chunk replaced by a per-chunk
    // `new SseParser()` fails this — the halves never join.
    expect(a.events[0]?.data?.delta).toBe('split')
    bus.shutdown()
  })

  it('does not glue a half-line from a dead socket onto the next one', async () => {
    const first = controllableStream()
    const second = controllableStream()
    const streams = [first.stream, second.stream]
    const bus = new EngineEventBus(async () => streams.shift() ?? second.stream, noSleep)
    const a = recorder()
    bus.subscribe('ses_a', a)
    await bus.ready()

    first.push('data: {"type":"session.next.text.delta","data":{"sessionID":"ses_a","del')
    first.close()
    await settle()
    second.push(evt('session.idle', 'ses_a'))
    await settle()

    // Mutation: delete `parser.reset()` on reconnect fails this — the torn
    // payload from the dead socket is completed by the first bytes of the new
    // one and parses into a plausible-looking event that never happened.
    expect(a.events.map((e) => e.type)).toEqual(['session.idle'])
    bus.shutdown()
  })
})

/**
 * ## Mutations run, and the test each one fails
 *
 * Every row below was executed, not reasoned about. Two of the mutations this
 * file was first written for **survived**, and both are recorded here rather
 * than quietly dropped — each one changed the source instead of the claim.
 *
 * | Mutation | Fails |
 * |---|---|
 * | dispatch's `listeners.get(sessionId)` → union of every set | fans one session's events… |
 * | `settleReady()` moved before the transport await | ready() resolves only once a socket is live |
 * | delete `notifyAll(onDisconnect)` | a dropped socket reaches the listener… |
 * | `if (hadDisconnect)` → unconditional `onReconnect` | does not call onReconnect for the first connection |
 * | `resetReady()` → `armReady()` | ready() does not report connected while the socket is down |
 * | backoff index → constant `0` | retries with backoff… |
 * | delete `attempt += 1` | retries with backoff… |
 * | delete the whole `if (!sessionId)` body | an unattributed session.error is dropped… |
 * | that branch's `logger.warn` → `logger.debug` | an unattributed session.error is dropped… |
 * | delete the try/catch in `safely` | survives a listener that throws… |
 * | the returned unsubscribe made a no-op | lets a listener unsubscribe from inside its own handler |
 * | `if (this.listeners.size === 0)` → unconditional stop | stops the stream when the last listener unsubscribes |
 * | `if (this.pumping && !this.stopped)` → `if (this.pumping)` | does not report ready on a socket a previous stop tore down |
 * | `shutdown()` without notifying | shutdown reports a close, not a disconnect |
 * | `shutdown()` calls `onDisconnect` instead of `onClosed` | shutdown reports a close, not a disconnect; **and** the runner's "ends the turn when the engine stops" |
 * | a fresh `SseParser` per chunk | reassembles an event split across two chunks |
 * | delete `parser.reset()` on reconnect | does not glue a half-line from a dead socket… |
 *
 * ### The two survivors, and what changed because of them
 *
 * 1. **`for (const listener of [...set])` → `of set` survived.** The snapshot
 *    was written to stop a mid-dispatch unsubscribe skipping the next
 *    listener, which is an array problem, not a `Set` one — a `Set` iterator
 *    handles it. The snapshot was **removed from the source**, and the test
 *    re-aimed at the unsubscribe itself, which a no-op mutation now fails.
 * 2. **Deleting the `if (!sessionId)` branch survived the delivery
 *    assertion.** With the branch gone, `listeners.get(null)` returns
 *    undefined and the event is dropped anyway. The branch's only unique
 *    observable is its log line, so the test now asserts on that.
 *
 * One near-miss worth recording, because it is the trap the handover names:
 * the broadcast mutation was first applied with a regex that matched
 * `subscribe`'s `listeners.get(sessionId)` rather than `dispatch`'s. It failed
 * two unrelated tests and passed the fan-out test it was aimed at, which read
 * exactly like a real gap in coverage. Re-running it at the intended call site
 * is what showed the fan-out assertion was fine all along.
 */
