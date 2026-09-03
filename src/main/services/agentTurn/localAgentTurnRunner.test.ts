/**
 * The whole main-side turn path, with only HTTP faked.
 *
 * The real `EngineEventBus`, the real `TurnStream`, the real
 * `StreamPartsAccumulator` and the real `pendingRequests` registry are all
 * wired together here; what is replaced is the socket to `opencode` and the
 * three things that need a database or a disk. That split is deliberate. Every
 * defect this phase can still have is a defect of *sequence* — prompt before
 * the socket is live, the lock taken before the engine is reconciled, a parked
 * question outliving the turn that raised it — and a test that stubs the bus
 * cannot see any of them.
 *
 * **Real turns have since been run against the binary with a live credential**,
 * and the fakes below were corrected where they disagreed with it. Confirmed on
 * real data: deltas are true deltas and `text.ended` carries the cumulative
 * text; `session.next.text.delta` carries no `durable` block at all;
 * `admittedSeq` matches the `durable.seq` of `session.next.prompt.admitted`;
 * tool failures use the `{type:'unknown', message}` shape; and the permission
 * ask flow fires correctly.
 *
 * Two things the binary contradicted outright, and both are why every test here
 * now ends its turn through `endTurn()`: **`session.idle` is never emitted**,
 * and `POST /wait` answers 503 "not available yet". These fakes were faithful
 * to the OpenAPI document, and the document was wrong about behaviour — a fake
 * can only ever be as right as the contract you believed when you wrote it.
 *
 * Still not covered from here: how a turn behaves under a *real* reconnect, and
 * which `finish` values actually occur beyond the two observed. The code is
 * built to be order-tolerant and the tests say which assumption they encode.
 *
 * Every mutation named in a comment was **run**; the table at the bottom
 * records the outcome of each.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const logged: string[] = []
vi.mock('../../logger/logger', () => ({
  createLogger: () => ({
    debug: (m: string) => logged.push(m),
    info: (m: string) => logged.push(m),
    warn: (m: string) => logged.push(m),
    error: (m: string) => logged.push(m)
  })
}))

import { EngineEventBus } from './engineEventBus'
import { LocalAgentTurnRunner, type LocalTurnDeps } from './localAgentTurnRunner'
import { pendingRequests } from './pendingRequests'
import { turnLock } from '../localAgents/turnLock'
import type { RunAgentTurnInput } from '../a2aStreamingService'
import type { AgentStreamEvent } from '../../../shared/agentStreamEvents'

interface Call {
  path: string
  method: string
  body?: unknown
}

/** A fake engine: records every call, and lets the test push SSE frames. */
function fakeEngine(overrides: Record<string, () => Response> = {}): {
  request: LocalTurnDeps['request']
  calls: Call[]
  push: (frame: string) => void
  closeStream: () => void
  streamOpened: () => boolean
  globalStreamsOpened: () => number
} {
  const calls: Call[] = []
  const ctrls: ReadableStreamDefaultController<Uint8Array>[] = []
  let ctrl: ReadableStreamDefaultController<Uint8Array> | null = null
  const enc = new TextEncoder()

  const request: LocalTurnDeps['request'] = async (path, init) => {
    const method = init?.method ?? 'GET'
    const body = init?.body ? JSON.parse(String(init.body)) : undefined
    calls.push({ path, method, body })

    if (path === '/api/event') {
      const stream = new ReadableStream<Uint8Array>({
        start(c) {
          ctrl = c
          ctrls.push(c)
        }
      })
      return new Response(stream, { status: 200 })
    }
    const override = overrides[`${method} ${path}`] ?? overrides[path]
    if (override) return override()
    if (path === '/api/session' && method === 'POST') {
      return new Response(JSON.stringify({ data: { id: 'ses_new' } }), { status: 200 })
    }
    return new Response('{}', { status: 200 })
  }

  return {
    request,
    calls,
    push: (frame) => ctrl?.enqueue(enc.encode(frame)),
    closeStream: () => ctrl?.close(),
    streamOpened: () => ctrl !== null,
    globalStreamsOpened: () => ctrls.length
  }
}

/** A finished SSE body, for the durable per-session replay. */
function sseBody(frames: string[]): Response {
  const enc = new TextEncoder()
  return new Response(
    new ReadableStream<Uint8Array>({
      start(c) {
        for (const f of frames) c.enqueue(enc.encode(f))
        c.close()
      }
    }),
    { status: 200 }
  )
}

const frame = (type: string, data: Record<string, unknown>): string =>
  `data: ${JSON.stringify({ id: 'evt', type, data: { sessionID: 'ses_new', ...data } })}\n\n`

/**
 * How a turn really ends on 1.18.27.
 *
 * `session.idle` is never emitted and `POST /wait` answers 503 "not available
 * yet", both observed against the real binary — so every test that used to end
 * a turn with `session.idle` was ending it in a way production never will. This
 * helper exists so that cannot quietly come back: if a test needs a turn to
 * finish, it finishes the way the engine finishes one.
 */
const endTurn = (finish = 'stop', sessionID = 'ses_new'): string =>
  `data: ${JSON.stringify({
    id: 'evt',
    type: 'session.next.step.ended',
    data: {
      sessionID,
      assistantMessageID: 'msg_1',
      finish,
      cost: 0,
      tokens: { input: 1, output: 1, reasoning: 0, cache: { read: 0, write: 0 } }
    }
  })}\n\n`

interface Harness {
  runner: LocalAgentTurnRunner
  engineBus: EngineEventBus
  engine: ReturnType<typeof fakeEngine>
  order: string[]
  saved: { sessionId: string }[]
  input: (over?: Partial<RunAgentTurnInput>) => RunAgentTurnInput
  events: AgentStreamEvent[]
}

function harness(opts: {
  agent?: Partial<{
    name: string
    path: string
    enabled: boolean
    readiness: string
    readinessReason: string | null
  }> | null
  agentKey?: string | null
  engineStatus?: string
  remembered?: string | null
  engine?: ReturnType<typeof fakeEngine>
  /** Use the real `turnLock` instead of the pass-through, so refusal is real. */
  realLock?: boolean
  turnCeilingMs?: number
} = {}): Harness {
  const engine = opts.engine ?? fakeEngine()
  const order: string[] = []
  const saved: { sessionId: string }[] = []
  const events: AgentStreamEvent[] = []
  const bus = new EngineEventBus((signal) => engine.request('/api/event', { signal }).then((r) => r.body), () => Promise.resolve())

  const deps: LocalTurnDeps = {
    ensureEngineRunning: async () => {
      order.push('ensureRunning')
      return { status: opts.engineStatus ?? 'running', error: null }
    },
    agentKey: () => (opts.agentKey === undefined ? 'assistant_ab12' : opts.agentKey),
    skipReason: () => null,
    request: engine.request,
    bus,
    getAgent: () =>
      opts.agent === null
        ? null
        : {
            name: 'Helper',
            path: '/agents/helper',
            enabled: true,
            readiness: 'ok',
            readinessReason: null,
            ...opts.agent
          },
    readSession: () => opts.remembered ?? null,
    saveSession: (i) => void saved.push({ sessionId: i.sessionId }),
    withLock: opts.realLock
      ? (agentId, owner, fn) => turnLock.withLock(agentId, owner, fn)
      : async (_agentId, _owner, fn) => {
          order.push('lock')
          try {
            return await fn()
          } finally {
            order.push('unlock')
          }
        },
    userId: () => 'settings-user',
    turnCeilingMs: opts.turnCeilingMs
  }

  return {
    runner: new LocalAgentTurnRunner(deps),
    engineBus: bus,
    engine,
    order,
    saved,
    events,
    input: (over) => ({
      chatId: 'chat_1',
      agentId: 'folder:abc',
      agentName: 'Helper',
      wireContent: 'hello',
      signal: new AbortController().signal,
      onEvent: (e) => void events.push(e),
      ...over
    })
  }
}

/** Let queued microtasks drain. */
const settle = async (): Promise<void> => {
  for (let i = 0; i < 30; i++) await Promise.resolve()
}

const paths = (h: Harness): string[] => h.engine.calls.map((c) => `${c.method} ${c.path}`)

describe('LocalAgentTurnRunner', () => {
  beforeEach(() => {
    logged.length = 0
    pendingRequests.clear()
  })

  it('refuses a turn against a disabled agent, and touches the engine not at all', async () => {
    const h = harness({ agent: { enabled: false } })
    const result = await h.runner.runTurn(h.input())

    // **The named mutation for this test is "remove the `enabled` check".**
    // With it removed the turn proceeds, the engine is reached, and an agent
    // the user switched off answers — the gate exists nowhere else, because
    // `collectEngineAgents` still writes a config entry and a prompt file for
    // a disabled agent by design.
    expect(result.error?.message).toContain('switched off')
    expect(h.engine.calls).toEqual([])
    expect(h.order).toEqual([])
  })

  it('reconciles the engine before taking the turn lock, never after', async () => {
    const h = harness()
    const run = h.runner.runTurn(h.input())
    await settle()
    h.engine.push(endTurn())
    await run

    // `ensureRunning` restarts the engine when the config moved, and one
    // restart ends every streaming turn — which is why `applyConfigChange`
    // refuses while any lock is held. Calling it inside the lock is not unsafe,
    // it is *useless*: the change is deferred past the very turn that asked for
    // it. Mutation: move `ensureEngineRunning` inside the `withLock` callback
    // fails this with ['lock', 'ensureRunning', 'unlock'].
    expect(h.order).toEqual(['ensureRunning', 'lock', 'unlock'])
  })

  it('subscribes to the event stream before prompting', async () => {
    const h = harness()
    const run = h.runner.runTurn(h.input())
    await settle()

    // Mutation: move `bus.subscribe(...)` below the `prompt(...)` call fails
    // this — `GET /api/event` lands after the prompt.
    //
    // Note what this does **not** pin: moving `await bus.ready()` after
    // `prompt()` was run against it and **passed**, because `subscribe()`
    // issues the transport call synchronously either way, so the recorded
    // order is identical. The await is about the socket being *live*, which
    // this fake resolves too quickly to distinguish. The next test is the one
    // that pins it.
    expect(paths(h)).toEqual([
      'POST /api/session',
      'GET /api/event',
      'POST /api/session/ses_new/prompt'
    ])

    h.engine.push(endTurn())
    await run
  })

  it('does not prompt while the event socket is still being opened', async () => {
    // The failure this prevents: `POST /prompt` is admitted and the agent loop
    // starts, but the socket that carries the deltas is still in its HTTP
    // handshake. `GET /api/event` takes no cursor, so every event emitted in
    // that window is gone with no way to ask for it again — the turn appears
    // to hang until whatever the model does next happens to land after the
    // socket opens.
    //
    // A real handshake takes milliseconds and the fake resolves in a
    // microtask, which is why the recorded call order cannot see this and a
    // gate is needed instead.
    let openSocket!: (body: ReadableStream<Uint8Array> | null) => void
    const gate = new Promise<ReadableStream<Uint8Array> | null>((r) => {
      openSocket = r
    })
    const engine = fakeEngine()
    const h = harness({ engine })
    // Re-wire the bus behind a transport that does not resolve until told.
    const gatedBus = new EngineEventBus(() => gate, () => Promise.resolve())
    const runner = new LocalAgentTurnRunner({
      ...(h.runner as unknown as { deps: LocalTurnDeps }).deps,
      bus: gatedBus
    })

    const run = runner.runTurn(h.input())
    await settle()

    // Mutation: `await this.deps.bus.ready()` moved after `this.prompt(...)`
    // fails here — the prompt is issued into a session whose stream nobody is
    // reading yet.
    expect(paths(h)).not.toContain('POST /api/session/ses_new/prompt')

    const stream = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(
          new TextEncoder().encode(
            endTurn()
          )
        )
      }
    })
    openSocket(stream)
    await run
    expect(paths(h)).toContain('POST /api/session/ses_new/prompt')
  })

  it('assembles a turn from deltas and ends on idle', async () => {
    const h = harness()
    const run = h.runner.runTurn(h.input())
    await settle()
    h.engine.push(
      frame('session.next.text.delta', { assistantMessageID: 'msg_1', textID: 't1', delta: 'Hel' })
    )
    h.engine.push(
      frame('session.next.text.delta', { assistantMessageID: 'msg_1', textID: 't1', delta: 'lo' })
    )
    await settle()
    h.engine.push(endTurn())
    const result = await run

    expect(result.error).toBeUndefined()
    expect(result.parts).toEqual([{ kind: 'text', text: 'Hello' }])
    expect(result.text).toBe('Hello')
    // Mutation: drop `contextId: sessionId` from the success return fails this.
    // `agent:get-session` reads `a2a_sessions.context_id`, so without it the
    // renderer stops recognising the chat as an agent chat after a reload.
    expect(result.contextId).toBe('ses_new')
    expect(h.saved).toEqual([{ sessionId: 'ses_new' }])
    expect(h.events.filter((e) => e.type === 'delta').map((e) => (e as { text: string }).text)).toEqual([
      'Hel',
      'lo'
    ])
  })

  it('keeps the partial answer when the turn errors after streaming', async () => {
    const h = harness()
    const run = h.runner.runTurn(h.input())
    await settle()
    h.engine.push(
      frame('session.next.text.delta', { assistantMessageID: 'msg_1', textID: 't1', delta: 'part' })
    )
    await settle()
    h.engine.push(frame('session.error', { error: { name: 'APIError', data: { message: '429' } } }))
    const result = await run

    // Mutation: the error branch returning `fail(...)` (empty parts) fails
    // this. An error after a partial answer must not blank the answer — the
    // A2A path keeps `result.parts` on its error branch too.
    expect(result.error?.message).toBe('429')
    expect(result.parts).toEqual([{ kind: 'text', text: 'part' }])
  })

  it('interrupts the engine when the user cancels, rather than just walking away', async () => {
    const controller = new AbortController()
    const h = harness()
    const run = h.runner.runTurn(h.input({ signal: controller.signal }))
    await settle()
    controller.abort()
    await run

    // Mutation: delete the `/interrupt` POST fails this. An agent loop we
    // stopped reading keeps running, keeps spending the user's tokens, and
    // keeps the session busy so the next turn cannot start.
    expect(paths(h)).toContain('POST /api/session/ses_new/interrupt')
  })

  it('parks a question, and posts the answer to the question reply endpoint', async () => {
    const h = harness()
    const run = h.runner.runTurn(h.input())
    await settle()
    h.engine.push(
      frame('question.v2.asked', {
        id: 'que_7',
        questions: [{ question: 'Which?', header: 'Pick', options: [{ label: 'A', description: 'a' }] }],
        tool: { messageID: 'msg_1', callID: 'c1' }
      })
    )
    await settle()

    expect(pendingRequests.listForChat('chat_1')).toEqual([
      { requestId: 'que_7', kind: 'question' }
    ])

    pendingRequests.resolve('que_7', { kind: 'question', answers: [['A']] })
    await settle()

    const reply = h.engine.calls.find((c) => c.path.includes('/question/que_7/reply'))
    // Mutation: post `{answer: 'A'}` or a flat `['A']` instead of `string[][]`
    // fails this. OpenCode's `QuestionV2Reply` is one array of selected labels
    // *per question*, and the wrong shape is a 400 the user sees as the agent
    // hanging.
    expect(reply?.body).toEqual({ answers: [['A']] })
    expect(reply?.path).toBe('/api/session/ses_new/question/que_7/reply')

    h.engine.push(endTurn())
    await run
  })

  it('posts a permission decision as OpenCode\'s own reply enum', async () => {
    const h = harness()
    const run = h.runner.runTurn(h.input())
    await settle()
    h.engine.push(
      frame('permission.v2.asked', {
        id: 'per_2',
        action: 'bash',
        resources: ['rm -rf build'],
        save: ['bash:rm *'],
        source: { type: 'tool', messageID: 'msg_1', callID: 'c1' }
      })
    )
    await settle()
    pendingRequests.resolve('per_2', { kind: 'permission', reply: 'always' })
    await settle()

    const reply = h.engine.calls.find((c) => c.path.includes('/permission/per_2/reply'))
    // Mutation: send `{reply: 'allow'}` fails this. `once | always | reject` is
    // OpenCode's enum, and it already maps one-to-one onto the design's Allow
    // once / Always / Deny — inventing a fourth spelling is a 400.
    expect(reply?.body).toEqual({ reply: 'always' })

    h.engine.push(endTurn())
    await run
  })

  it('rejects a still-parked question when the turn ends, so the session cannot wedge', async () => {
    const controller = new AbortController()
    const h = harness()
    const run = h.runner.runTurn(h.input({ signal: controller.signal }))
    await settle()
    h.engine.push(
      frame('question.v2.asked', {
        id: 'que_7',
        questions: [{ question: 'Which?', header: 'Pick', options: [{ label: 'A' }] }]
      })
    )
    await settle()
    controller.abort()
    await run
    await settle()

    // Mutation: delete the `for (const [, cancel] of parked) cancel()` in the
    // `finally` fails this. A question nobody will ever answer leaves the
    // agent loop parked forever: the session never goes idle, and every later
    // turn on that chat waits behind it.
    expect(paths(h)).toContain('POST /api/session/ses_new/question/que_7/reject')
    expect(pendingRequests.listForChat('chat_1')).toEqual([])
  })

  it('resumes a remembered session when the engine still has it', async () => {
    const engine = fakeEngine({ 'GET /api/session/ses_old': () => new Response('{}', { status: 200 }) })
    const h = harness({ remembered: 'ses_old', engine })
    const run = h.runner.runTurn(h.input())
    await settle()

    expect(paths(h)).toContain('GET /api/session/ses_old')
    // Mutation: skip the verification GET and prompt straight into the
    // remembered id fails the *next* test, not this one — see there.
    expect(paths(h)).not.toContain('POST /api/session')
    expect(paths(h)).toContain('POST /api/session/ses_old/prompt')

    h.engine.push(endTurn('stop', 'ses_old'))
    await run
  })

  it('opens a fresh session when the remembered one is gone from the engine', async () => {
    const engine = fakeEngine({
      'GET /api/session/ses_old': () => new Response('{}', { status: 404 })
    })
    const h = harness({ remembered: 'ses_old', engine })
    const run = h.runner.runTurn(h.input())
    await settle()

    // Mutation: trust the remembered id without the verification GET fails
    // this. OpenCode's own storage can be cleared independently of ours, and
    // prompting into a session it no longer has is a 404 the user reads as an
    // unexplained failure with no way to recover except deleting the chat.
    expect(paths(h)).toContain('POST /api/session')
    expect(paths(h)).toContain('POST /api/session/ses_new/prompt')

    h.engine.push(endTurn())
    await run
  })

  it('refuses when the running engine has no key for this agent', async () => {
    const h = harness({ agentKey: null })
    const result = await h.runner.runTurn(h.input())

    // `agentKey` answers from the config the running process **loaded**, not
    // the last one generated — so null covers "the engine is not running",
    // "the generation skipped this agent" and "the restart that would load it
    // is still waiting on somebody else's turn". Mutation: fall back to a
    // derived key rather than refusing fails this, and would open a session
    // against an agent entry the engine has never heard of.
    expect(result.error?.message).toContain('not available in the running engine')
    expect(paths(h)).toEqual([])
  })

  it('ends the turn when the engine stops mid-answer, instead of waiting forever', async () => {
    // **Found by probing, not by reading, and it was a Critical.** The bus
    // originally reported its own shutdown as an ordinary `onDisconnect`. The
    // runner treats a disconnect as a hole that will heal, so it waited for an
    // `onReconnect` that could never come: the turn never settled, its
    // per-agent lock was held for the life of the app, and because
    // `applyConfigChange` refuses to restart while any lock is held, the engine
    // became permanently un-reconcilable too. One stopped engine bricked one
    // agent and the reconcile for every other.
    //
    // Mutation: `onClosed` in the listener delegating to the same body as
    // `onDisconnect` (or being a no-op) fails this — the promise never
    // resolves and the test times out rather than asserting.
    const h = harness()
    let settled = false
    const run = h.runner.runTurn(h.input()).then((r) => {
      settled = true
      return r
    })
    await settle()
    expect(settled).toBe(false)

    // What `agentTurn/index.ts` does on a non-running engine state.
    h.engineBus.shutdown()
    const result = await run

    expect(settled).toBe(true)
    expect(result.error?.message).toContain('engine stopped')
  })

  it('heals a mid-turn stream drop from the durable stream alone', async () => {
    // **The recovery path, and it got simpler once the real binary was
    // watched.** It used to replay the durable stream for content and then call
    // `POST /wait` for completion, because `session.idle` is not one of the 28
    // durable variants. But `session.idle` is never emitted at all, and `/wait`
    // answers 503 "Session wait is not available yet" — so that design
    // recovered the words and then hung.
    //
    // The signal that works, `session.next.step.ended`, **is** durable. So one
    // resumable call now carries both halves: the text that was missed and the
    // end of the turn. Nothing else is contacted.
    const engine = fakeEngine({
      'GET /api/session/ses_new/event?after=7': () =>
        sseBody([
          `data: ${JSON.stringify({
            id: 'evt',
            type: 'session.next.text.ended',
            durable: { aggregateID: 'ses_new', seq: 9, version: 1 },
            data: {
              sessionID: 'ses_new',
              assistantMessageID: 'msg_1',
              textID: 't1',
              text: 'Hello world'
            }
          })}\n\n`,
          `data: ${JSON.stringify({
            id: 'evt',
            type: 'session.next.step.ended',
            durable: { aggregateID: 'ses_new', seq: 10, version: 1 },
            data: {
              sessionID: 'ses_new',
              assistantMessageID: 'msg_1',
              finish: 'stop',
              cost: 0,
              tokens: { input: 1, output: 1, reasoning: 0, cache: { read: 0, write: 0 } }
            }
          })}\n\n`
        ])
    })
    const h = harness({ engine })
    const run = h.runner.runTurn(h.input())
    await settle()

    // One delta lands, then the socket dies mid-answer and the rest of the
    // turn — including its end — happens inside the hole.
    h.engine.push(
      `data: ${JSON.stringify({
        id: 'evt',
        type: 'session.next.text.delta',
        durable: { aggregateID: 'ses_new', seq: 7, version: 1 },
        data: { sessionID: 'ses_new', assistantMessageID: 'msg_1', textID: 't1', delta: 'Hel' }
      })}\n\n`
    )
    await settle()
    h.engine.closeStream()
    await settle()

    const result = await run

    // Mutation: delete the `onReconnect` → `heal()` call → this times out.
    // The turn would sit on 'Hel' forever waiting for an end that already
    // happened inside the hole.
    expect(result.error).toBeUndefined()
    expect(result.parts).toEqual([{ kind: 'text', text: 'Hello world' }])

    // Mutation: `?after=${after}` → no query string fails this. Replaying from
    // seq 0 re-delivers text already rendered; the never-shrink rule absorbs
    // the visible damage, so the request would be wrong while the output
    // looked right — and the next reader would inherit it as a contract.
    expect(paths(h)).toContain('GET /api/session/ses_new/event?after=7')

    // Mutation: re-introduce the `POST /wait` call fails this. It is not merely
    // useless now, it is a 503 and a delay on every recovery.
    expect(paths(h).some((p) => p.includes('/wait'))).toBe(false)
    expect(h.engine.globalStreamsOpened()).toBeGreaterThan(1)
  })

  it('reports a busy agent as a turn error instead of hanging the chat', async () => {
    // **Uses the real `turnLock`, not the harness pass-through.** That is the
    // whole point: `turnLock.acquire` *throws* `LocalAgentError` and never
    // queues, and a pass-through lock can never produce the refusal. With the
    // injected fake this defect was invisible while looking fully covered.
    //
    // The escape route it had: `runTurn` returned `withLock(...)` unguarded,
    // `streamToAgent`'s try had only a `finally`, and the IPC listener's
    // try/catches both sit above the call — so the port closed having posted
    // neither `done` nor `error` and the renderer never left the streaming
    // state. Reachable by opening one folder agent in two chats.
    //
    // Mutation: drop the try/catch around `withLock` in `runTurn` → this
    // rejects instead of resolving, and the assertion never runs.
    const held = turnLock.acquire('folder:abc', 'someone-else')
    try {
      const h = harness({ realLock: true })
      const result = await h.runner.runTurn(h.input())

      expect(result.error?.message).toContain('busy right now')
      expect(result.parts).toEqual([])
      // Nothing was sent to the engine: a refusal must not open a session.
      expect(paths(h)).toEqual([])
    } finally {
      held.release()
    }
  })

  it('ends a turn that never settles, rather than holding its lock forever', async () => {
    // The systemic backstop. Three separate defects in this phase all ended at
    // "the turn never settles", and each was fixed at its own door — a held
    // lock is unrecoverable without restarting the app, because
    // `turnLock.anyHeld()` also stops the engine being reconciled for every
    // other folder agent. This caps the doors nobody has found.
    //
    // Mutation: delete the ceiling `setTimeout` → this times out, which is the
    // production symptom exactly.
    const h = harness({ realLock: true, turnCeilingMs: 20 })
    const result = await h.runner.runTurn(h.input())

    expect(result.error?.message).toContain('stopped responding')
    // And the lock is free again, which is the part that actually matters.
    expect(turnLock.isLocked('folder:abc')).toBe(false)
  })

  it('drops an engine-settled request from the registry, not just from the turn', async () => {
    // A reply can be made from somewhere other than this window, and the
    // engine tells us via `permission.v2.replied`. Dropping only the turn's
    // local handle left the module registry entry alive for the full park
    // timeout: `isPending` kept returning true, the block kept rendering
    // answerable, and answering it returned `{ok:true}` while the reply 404'd
    // into a warn — telling the user their decision landed when it had not.
    //
    // Mutation: `pendingRequests.drop(update.settled)` deleted fails this.
    const h = harness()
    const run = h.runner.runTurn(h.input())
    await settle()
    h.engine.push(
      frame('permission.v2.asked', {
        id: 'per_5',
        action: 'bash',
        resources: ['ls'],
        source: { type: 'tool', messageID: 'msg_1', callID: 'c1' }
      })
    )
    await settle()
    expect(pendingRequests.owner('per_5')).not.toBeNull()

    h.engine.push(
      frame('permission.v2.replied', { requestID: 'per_5', reply: 'once' })
    )
    await settle()
    expect(pendingRequests.owner('per_5')).toBeNull()

    h.engine.push(endTurn())
    await run
  })

  it('refuses when the engine did not come up', async () => {
    const h = harness({ engineStatus: 'failed' })
    const result = await h.runner.runTurn(h.input())
    expect(result.error?.message).toBe('The local engine is not running.')
    expect(h.order).toEqual(['ensureRunning'])
  })
})

/**
 * ## Mutations run, and the test each one fails
 *
 * | Mutation | Fails |
 * |---|---|
 * | **remove the `enabled` check** | refuses a turn against a disabled agent… |
 * | `ensureEngineRunning` moved inside `withLock` | reconciles the engine before taking the turn lock |
 * | `bus.subscribe()` moved below `prompt()` | subscribes to the event stream before prompting |
 * | `await bus.ready()` moved after `prompt()` | does not prompt while the event socket is still being opened |
 * | drop `contextId` from the success return | assembles a turn from deltas and ends on idle |
 * | error branch returns `fail()` (empty parts) | keeps the partial answer when the turn errors… |
 * | delete the `/interrupt` POST on abort | interrupts the engine when the user cancels |
 * | question reply body → `{answer}` / flat array | parks a question, and posts the answer… |
 * | permission reply `'always'` → `'allow'` | posts a permission decision as OpenCode's own enum |
 * | delete the parked-request sweep in `finally` | rejects a still-parked question when the turn ends |
 * | skip the session verification GET | opens a fresh session when the remembered one is gone |
 * | fall back to a derived key when `agentKey` is null | refuses when the running engine has no key… |
 * | drop the try/catch around `withLock` in `runTurn` | reports a busy agent as a turn error instead of hanging |
 * | delete the ceiling `setTimeout` | ends a turn that never settles (times out) |
 * | delete `pendingRequests.drop(update.settled)` | drops an engine-settled request from the registry |
 * | `onClosed` behaves like `onDisconnect` (or is a no-op) | ends the turn when the engine stops mid-answer |
 * | delete the `onReconnect` → `heal()` call | heals a mid-turn stream drop from the durable stream alone |
 * | `?after=${after}` → no query string | heals a mid-turn stream drop from the durable stream alone |
 * | re-introduce the `POST /wait` call | heals a mid-turn stream drop from the durable stream alone |
 */
