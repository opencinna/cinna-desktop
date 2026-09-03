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

import { EngineEventBus, type SessionEventListener } from './engineEventBus'
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
    // Overrides match on the route, so a test does not have to spell the
    // location query the readiness probe appends.
    const route = path.split('?')[0]
    const override =
      overrides[`${method} ${path}`] ??
      overrides[path] ??
      overrides[`${method} ${route}`] ??
      overrides[route]
    if (override) return override()
    // The readiness probes a turn makes before it opens a session. A cold
    // engine answers its health check ~30–60s before either of these is
    // populated, so the fake answers them the way a *warm* one does and the
    // tests that care about the cold window override them.
    if (route === '/api/agent') {
      return new Response(JSON.stringify({ data: [{ id: 'assistant_ab12' }] }), { status: 200 })
    }
    if (route === '/api/model') {
      return new Response(
        JSON.stringify({ data: [{ providerID: 'anthropic', id: 'claude-sonnet-4-6' }] }),
        { status: 200 }
      )
    }
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
  agentModel?: { providerID: string; id: string } | null
  engineStatus?: string
  remembered?: string | null
  engine?: ReturnType<typeof fakeEngine>
  /** Use the real `turnLock` instead of the pass-through, so refusal is real. */
  realLock?: boolean
  turnCeilingMs?: number
  engineReadyMs?: number
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
    agentModel: () =>
      opts.agentModel === undefined ? { providerID: 'anthropic', id: 'claude-sonnet-4-6' } : opts.agentModel,
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
    turnCeilingMs: opts.turnCeilingMs,
    engineReadyMs: opts.engineReadyMs
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
  for (let i = 0; i < 80; i++) await Promise.resolve()
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

  it('refuses a turn against an agent whose folder is not in a runnable state', async () => {
    // The `enabled` gate above has a test; **this sibling gate had none**, and
    // the mutation `if (agent.readiness === 'invalid' || agent.readiness ===
    // 'contract_too_new')` → `if (false)` passed the whole suite. The two gates
    // stand or fall together: both are the runner deciding what a turn may
    // reach, because `collectEngineAgents` writes a config entry either way.
    const invalid = harness({
      agent: { readiness: 'invalid', readinessReason: 'agent.toml is malformed.' }
    })
    const result = await invalid.runner.runTurn(invalid.input())
    // The reason is surfaced, not swallowed — it is the only line that can say
    // what to fix.
    expect(result.error?.message).toBe('agent.toml is malformed.')
    expect(invalid.engine.calls).toEqual([])
    expect(invalid.order).toEqual([])

    const tooNew = harness({
      agent: { readiness: 'contract_too_new', readinessReason: null }
    })
    const second = await tooNew.runner.runTurn(tooNew.input())
    // And with no reason recorded it still refuses rather than falling through.
    expect(second.error?.message).toBe(
      'This agent’s folder is not in a state it can be run from.'
    )
    expect(tooNew.engine.calls).toEqual([])
  })

  it('surfaces a failed engine POST instead of waiting out the turn ceiling', async () => {
    // **`post()`'s `if (!res.ok) throw` had nothing pinning it**: the mutation
    // `if (false)` passed 758/758. Every call to the engine goes through this
    // one door — the session create, the prompt, both reply endpoints and
    // `/interrupt` — so without the throw a rejected prompt is swallowed whole
    // and the turn hangs to the 20-minute ceiling with nothing said. Reachable
    // on an expired session, a 500, or an agent key the engine does not know.
    const engine = fakeEngine({
      'POST /api/session/ses_new/prompt': () => new Response('nope', { status: 500 })
    })
    // A short ceiling so the mutation's symptom is a *different error message*
    // rather than a five-second timeout — the two outcomes stay legible apart.
    const h = harness({ engine, turnCeilingMs: 50 })
    const result = await h.runner.runTurn(h.input())

    // Mutation: `if (!res.ok) { throw }` → `if (false)` on `post()`'s call site
    // fails this with 'The agent stopped responding…' — the ceiling firing,
    // twenty minutes later in production, on a turn that was refused instantly.
    expect(result.error?.message).toBe('The local agent could not complete this turn.')
    expect(result.error?.raw).toContain('500')
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
    // The readiness probes carry the folder the session will be opened in: the
    // engine's catalog and agent registry are per-location, and an unscoped
    // probe answers for the engine's own cwd, which is always warm. Mutation:
    // drop the `location[directory]` query → this fails, and in production the
    // first turn in a fresh folder goes out with no system prompt.
    const at = '?location%5Bdirectory%5D=%2Fagents%2Fhelper'
    expect(paths(h)).toEqual([
      `GET /api/agent${at}`,
      `GET /api/model${at}`,
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

    // **The re-point, which nothing asserted before.** `openSession`'s contract
    // is that a resumed session whose agent key has moved — the config changed
    // and the engine restarted — is *switched* rather than abandoned, so the
    // conversation survives. Mutation: delete the `POST .../agent` call from
    // `openSession` → this fails. Without it a resumed chat keeps answering as
    // whatever agent the session was originally opened against, which is
    // invisible until the agent's prompt has changed underneath the user.
    const repoint = h.engine.calls.find((c) => c.path === '/api/session/ses_old/agent')
    expect(repoint?.method).toBe('POST')
    expect(repoint?.body).toEqual({ agent: 'assistant_ab12' })

    // **And the model, for the same reason.** A remembered session carries the
    // model it was opened with; a runtime changed in the Runtime card since
    // then only reaches the engine if the session is re-pointed at it too.
    // Mutation: delete the `POST .../model` call → this fails, and the chat
    // silently keeps answering on the previous model.
    const remodel = h.engine.calls.find((c) => c.path === '/api/session/ses_old/model')
    expect(remodel?.method).toBe('POST')
    expect(remodel?.body).toEqual({ model: { providerID: 'anthropic', id: 'claude-sonnet-4-6' } })

    h.engine.push(endTurn('stop', 'ses_old'))
    await run
  })

  it('opens a session on the model the running engine loaded for the agent', async () => {
    const h = harness()
    const run = h.runner.runTurn(h.input())
    await settle()

    // **The whole point of Phase 6's model fix.** OpenCode 1.18.27's v2 runner
    // resolves a model from the *session's* `model` and never from
    // `agent.<key>.model`, so a create call without one runs the turn on the
    // engine's own default — observed on 3 Sep 2026 to be a free
    // `opencode/muse-spark-*` gateway where every tool call fails in ~3 ms.
    // Mutation: drop `model` from the `POST /api/session` body → this fails.
    const created = h.engine.calls.find((c) => c.path === '/api/session')
    expect(created?.body).toEqual({
      agent: 'assistant_ab12',
      model: { providerID: 'anthropic', id: 'claude-sonnet-4-6' },
      location: { directory: '/agents/helper' }
    })

    h.engine.push(endTurn())
    await run
  })

  it('opens a session without a model when the loaded config named none', async () => {
    // Null is the old behaviour, not a new failure: a config generated before
    // the model was recorded has no answer to give, and refusing the turn over
    // it would be worse than the engine picking a default. Mutation: send
    // `model: null` unconditionally → the engine rejects the body and this
    // fails on the missing key.
    const h = harness({ agentModel: null })
    const run = h.runner.runTurn(h.input())
    await settle()

    const created = h.engine.calls.find((c) => c.path === '/api/session')
    expect(created?.body).toEqual({
      agent: 'assistant_ab12',
      location: { directory: '/agents/helper' }
    })

    h.engine.push(endTurn())
    await run
  })

  it('refuses when the engine answers a session create with no usable id', async () => {
    // `POST /api/session` is expected to return `{data:{id:'ses_*'}}`. An error
    // envelope, a `{data:{}}`, or an id in some other namespace must not be
    // carried forward as a session id — every later call would be built on it
    // and 404, and the user would see an unexplained failure per turn.
    //
    // Mutation: `if (typeof id !== 'string' || !id.startsWith('ses'))` →
    // `if (false)` fails this — the turn proceeds against `undefined` as its
    // session id.
    const engine = fakeEngine({
      'POST /api/session': () =>
        new Response(JSON.stringify({ data: { notAnId: true } }), { status: 200 })
    })
    const h = harness({ engine, turnCeilingMs: 50 })
    const result = await h.runner.runTurn(h.input())

    expect(result.error?.message).toBe('Could not start a session with the local engine.')
    expect(paths(h)).not.toContain('POST /api/session/undefined/prompt')
  })

  it('releases its bus subscription when the turn ends', async () => {
    // The bus connects on the first subscriber and disconnects on the last, so
    // a turn that never unsubscribes holds the engine socket open for the life
    // of the app and leaves a dead `ses_…` listener taking delivery of every
    // later event on that id.
    //
    // Mutation: delete `unsubscribe()` from `stream()`'s `finally` fails this —
    // the bus stays connected after the turn is over.
    const h = harness()
    const run = h.runner.runTurn(h.input())
    await settle()
    expect(h.engineBus.isConnected()).toBe(true)

    h.engine.push(endTurn())
    await run
    await settle()

    expect(h.engineBus.isConnected()).toBe(false)
  })

  it('replays the whole durable stream when the socket dies before any cursor exists', async () => {
    // **The branch the heal test above cannot reach.** That test hands its
    // `text.delta` a fabricated `durable` block — but the contract, verified
    // against the binary and restated in this file's own header, says
    // `session.next.text.delta` carries **no** `durable` block at all. So the
    // real shape of "the socket died early" is `turn.lastSeq() === null`, and
    // the `after === null ? '' : …` branch is what runs.
    //
    // Reachable whenever the engine drops between `bus.ready()` and the first
    // durable event — a restart landing in that window, which is exactly when a
    // reconnect happens.
    //
    // Mutation: `const query = after === null ? '' : \`?after=\${after}\`` →
    // `const query = \`?after=\${after}\`` on `replayDurable`'s call site fails
    // this. The request becomes `?after=null`, which is not the same resource;
    // the replay returns nothing usable and the turn hangs to the ceiling with
    // its answer lost.
    const engine = fakeEngine({
      'GET /api/session/ses_new/event': () =>
        sseBody([
          `data: ${JSON.stringify({
            id: 'evt',
            type: 'session.next.text.ended',
            durable: { aggregateID: 'ses_new', seq: 2, version: 1 },
            data: {
              sessionID: 'ses_new',
              assistantMessageID: 'msg_1',
              textID: 't1',
              text: 'recovered'
            }
          })}\n\n`,
          `data: ${JSON.stringify({
            id: 'evt',
            type: 'session.next.step.ended',
            durable: { aggregateID: 'ses_new', seq: 3, version: 1 },
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
    const h = harness({ engine, turnCeilingMs: 50 })
    const run = h.runner.runTurn(h.input())
    await settle()

    // Nothing durable has been seen — the socket dies with no cursor to resume
    // from.
    h.engine.closeStream()
    await settle()

    const result = await run

    expect(result.error).toBeUndefined()
    expect(result.parts).toEqual([{ kind: 'text', text: 'recovered' }])
    expect(paths(h)).toContain('GET /api/session/ses_new/event')
    expect(paths(h).some((p) => p.includes('after='))).toBe(false)
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

  it('fails the turn when the engine never gets the model, instead of hanging on it', async () => {
    // **The failure this replaces is invisible.** A model the engine cannot
    // resolve produces `SessionRunnerModel.ModelUnavailableError` in its own
    // log and **no event at all** on `/api/event` — verified against 1.18.27 on
    // 3 Sep 2026 — so the turn used to sit in the streaming state until the
    // twenty-minute ceiling, holding its lock and, through `turnLock.anyHeld()`,
    // blocking every engine reconcile with it.
    //
    // Mutation: delete the `awaitEngineReady` call in `stream()` → this fails
    // by hanging until the ceiling instead of returning a message.
    const engine = fakeEngine({
      'GET /api/model': () =>
        new Response(JSON.stringify({ data: [{ providerID: 'openai', id: 'gpt-4o' }] }), {
          status: 200
        })
    })
    const h = harness({ engine, engineReadyMs: 30, turnCeilingMs: 5_000 })
    const result = await h.runner.runTurn(h.input())

    expect(result.error?.message).toContain('anthropic/claude-sonnet-4-6')
    expect(result.error?.message).toContain('no such model')
    // And no session was opened against it: an engine that cannot run the turn
    // should not be left holding a session for one.
    expect(paths(h)).not.toContain('POST /api/session')
  })

  it('fails the turn when the engine never loads the agent, instead of running it promptless', async () => {
    // The other half of the same cold window, and the quieter one: an engine
    // that does not yet know the agent runs the turn with **no system prompt**
    // — watched at a probe server — so the folder agent answers as a generic
    // assistant and nothing anywhere says why.
    //
    // Mutation: check only the model and not the agent → this fails.
    const engine = fakeEngine({
      'GET /api/agent': () => new Response(JSON.stringify({ data: [{ id: 'someone-else' }] }), { status: 200 })
    })
    const h = harness({ engine, engineReadyMs: 30, turnCeilingMs: 5_000 })
    const result = await h.runner.runTurn(h.input())

    expect(result.error?.message).toContain('not loaded in the local engine yet')
    expect(paths(h)).not.toContain('POST /api/session')
  })

  it('runs the turn anyway when the readiness probe itself cannot be read', async () => {
    // **A diagnostic must not be able to refuse a turn on its own trouble.**
    // The probe is an addition; "try it and see" is what the runner did before
    // it, and is strictly better than blocking on an endpoint that 500s, moves
    // in a later OpenCode, or answers a shape we did not expect.
    //
    // Mutation: treat a non-OK probe as "not ready" → this fails.
    const engine = fakeEngine({
      'GET /api/agent': () => new Response('nope', { status: 500 })
    })
    const h = harness({ engine, engineReadyMs: 30 })
    const run = h.runner.runTurn(h.input())
    await settle()

    expect(paths(h)).toContain('POST /api/session')
    h.engine.push(endTurn())
    const result = await run
    expect(result.error).toBeUndefined()
  })

  it('gives up the readiness wait the moment the user stops the turn', async () => {
    // **The wait happens inside the per-agent lock**, and `turnLock.anyHeld()`
    // blocks every engine reconcile while any lock is held — so a stop pressed
    // during a cold start used to hold the whole app's engine still for the
    // rest of `ENGINE_READY_MS` with nothing to show for it. `realLock` so the
    // release is the real one and not the pass-through.
    //
    // The bound is **below one poll interval**, deliberately. At anything above
    // `ENGINE_READY_POLL_MS` the assertion passes against a plain `setTimeout`
    // too — the loop's own top-of-iteration abort check catches it one tick
    // later — and the test would read as if it pinned the early wake while
    // pinning nothing. Measured at ~1 s with a plain sleep; a few ms without.
    const engine = fakeEngine({
      'GET /api/model': () => new Response(JSON.stringify({ data: [] }), { status: 200 })
    })
    const controller = new AbortController()
    const h = harness({ engine, realLock: true, engineReadyMs: 30_000 })
    const started = Date.now()
    const run = h.runner.runTurn(h.input({ signal: controller.signal }))
    await settle()
    controller.abort()
    const result = await run

    expect(Date.now() - started).toBeLessThan(500)
    // A stop is not an error. The mid-turn abort path returns parts with no
    // `error` field, and this one has no parts to return; reporting "the engine
    // has no such model" for something the user did on purpose would be worse
    // than saying nothing.
    expect(result.error).toBeUndefined()
    expect(result.parts).toEqual([])
    // And the lock is genuinely back, so the next turn — and every engine
    // reconcile — can proceed.
    expect(turnLock.isLocked('folder:abc')).toBe(false)
    expect(paths(h)).not.toContain('POST /api/session')
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

    // **The cursor comes from `text.started`, not from the delta, and that is
    // fidelity rather than fussiness.** This fixture used to hang a `durable`
    // block off the `session.next.text.delta` — which the binary never does:
    // "`session.next.text.delta` carries no `durable` block at all" is a
    // verified line in `opencode_contract.md` §2 *and* in this file's own
    // header, and the whole point of §5 is that a fake faithful to something
    // other than the binary passes every test and fails in the app. A fixture
    // that contradicts the contract is a defect whatever it proves today.
    //
    // The real trace is `…admitted(1) → prompted(2) → step.started(3) →
    // text.started(4) → delta, delta, delta (no durable) → text.ended(5) →
    // step.ended(6)`. So the last cursor a turn holds when deltas are flowing
    // is the one off `text.started`, and that is what `?after=` must carry.
    h.engine.push(
      `data: ${JSON.stringify({
        id: 'evt',
        type: 'session.next.text.started',
        durable: { aggregateID: 'ses_new', seq: 7, version: 1 },
        data: { sessionID: 'ses_new', assistantMessageID: 'msg_1', textID: 't1' }
      })}\n\n`
    )
    // One delta lands — carrying **no** `durable` block, as the binary emits it
    // — then the socket dies mid-answer and the rest of the turn, including its
    // end, happens inside the hole.
    h.engine.push(
      `data: ${JSON.stringify({
        id: 'evt',
        type: 'session.next.text.delta',
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

  it('does not gap-fill on a reconnect that followed no disconnect', async () => {
    // **Driven through the `listener` seam directly, not through the bus.**
    //
    // The runner's contract is with the `SessionEventListener` interface, not
    // with `EngineEventBus` specifically. The invariant that makes this guard
    // look redundant — `hadDisconnect` in `pump()` — lives on the *other* side
    // of that seam, in code the runner does not own and cannot see. So the
    // guard is insurance against the other side changing, and the only way to
    // reach it is to hand the runner a bus that does the thing the real one
    // currently promises not to do. Through the real bus the mutation deleting
    // this line survives the whole suite; through the seam it does not.
    //
    // The observable effect of deleting `if (!disconnected) return` is not
    // "a function was not called" — it is **a durable replay the turn never
    // needed**, and everything that replay delivers gets folded into the turn.
    // Here the engine's durable stream already holds the turn's end, so the
    // spurious replay ends the turn early, on an answer that is still being
    // written. (How bad it gets depends on what the durable stream holds at
    // that instant; that it should not be asked at all does not.)
    const engine = fakeEngine({
      'GET /api/session/ses_new/event?after=4': () =>
        sseBody([
          `data: ${JSON.stringify({
            id: 'evt',
            type: 'session.next.step.ended',
            durable: { aggregateID: 'ses_new', seq: 5, version: 1 },
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
    const h = harness({ engine, turnCeilingMs: 5_000 })

    // A bus that hands the test the listener the runner registered.
    let listener!: SessionEventListener
    const capturingBus = {
      subscribe: (_sessionId: string, l: SessionEventListener) => {
        listener = l
        return () => {}
      },
      ready: async () => {}
    } as unknown as EngineEventBus
    const runner = new LocalAgentTurnRunner({
      ...(h.runner as unknown as { deps: LocalTurnDeps }).deps,
      bus: capturingBus
    })

    let settled = false
    const run = runner.runTurn(h.input()).then((r) => {
      settled = true
      return r
    })
    await settle()

    // A cursor exists and one delta has streamed — the turn is mid-answer.
    listener.onEvent({
      type: 'session.next.text.started',
      durable: { aggregateID: 'ses_new', seq: 4, version: 1 },
      data: { sessionID: 'ses_new', assistantMessageID: 'msg_1', textID: 't1' }
    })
    listener.onEvent({
      type: 'session.next.text.delta',
      data: { sessionID: 'ses_new', assistantMessageID: 'msg_1', textID: 't1', delta: 'Hel' }
    })
    await settle()

    // A reconnect notice with **no disconnect before it**. There is no hole, so
    // there is nothing to fill.
    listener.onReconnect()
    await settle()

    // Mutation: delete `if (!disconnected) return` from `listener.onReconnect`
    // fails both of these, and the **first** is the one that says why it
    // matters: the turn settles on a `step.ended` that the spurious replay
    // handed it, ending the answer at 'Hel' while the agent was still writing.
    // The user sees a truncated reply and nothing reports it. The second
    // assertion names the mechanism — a durable replay of a stream that never
    // dropped — and is deliberately the weaker of the two, so it is checked
    // second and the failure message leads with the consequence.
    expect(settled).toBe(false)
    expect(paths(h)).not.toContain('GET /api/session/ses_new/event?after=4')

    // The turn ends the ordinary way, and the answer is whole.
    listener.onEvent({
      type: 'session.next.text.delta',
      data: { sessionID: 'ses_new', assistantMessageID: 'msg_1', textID: 't1', delta: 'lo' }
    })
    listener.onEvent({
      type: 'session.next.step.ended',
      durable: { aggregateID: 'ses_new', seq: 5, version: 1 },
      data: { sessionID: 'ses_new', assistantMessageID: 'msg_1', finish: 'stop' }
    })
    const result = await run
    expect(result.parts).toEqual([{ kind: 'text', text: 'Hello' }])
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
 * | delete the readiness `invalid`/`contract_too_new` gate in `runTurn` | refuses a turn against an agent whose folder is not in a runnable state |
 * | `post()`'s `if (!res.ok) { throw }` → `if (false)` | surfaces a failed engine POST instead of waiting out the turn ceiling |
 * | delete the `POST .../agent` re-point in `openSession` | resumes a remembered session when the engine still has it |
 * | delete the `POST .../model` re-point in `openSession` | resumes a remembered session when the engine still has it |
 * | drop `model` from the `POST /api/session` body | opens a session on the model the running engine loaded for the agent |
 * | send `model` unconditionally rather than when non-null | opens a session without a model when the loaded config named none |
 * | delete the `awaitEngineReady` call in `stream()` | fails the turn when the engine never gets the model… (hangs to the ceiling) |
 * | check only the model and not the agent in `awaitEngineReady` | fails the turn when the engine never loads the agent… |
 * | treat an unreadable readiness probe as "not ready" | runs the turn anyway when the readiness probe itself cannot be read |
 * | drop the `signal` from `awaitEngineReady` / plain `setTimeout` | gives up the readiness wait the moment the user stops the turn |
 * | delete the returned-session-id validation in `openSession` | refuses when the engine answers a session create with no usable id |
 * | delete `unsubscribe()` from `stream()`'s `finally` | releases its bus subscription when the turn ends |
 * | `after === null ? '' : …` → `?after=${after}` in `replayDurable` | replays the whole durable stream when the socket dies before any cursor exists |
 * | delete `if (!disconnected) return` in `listener.onReconnect` | does not gap-fill on a reconnect that followed no disconnect |
 *
 * ### `if (!disconnected) return` — was listed as untestable, and is not
 *
 * This guard sat in the "survives, no test added" list below on the grounds
 * that `hadDisconnect` in `pump()` already prevents a spurious `onReconnect`.
 * **That was wrong, and the row has been moved out of that list**, because a
 * stale entry saying a line is untestable licenses deleting it.
 *
 * Two things changed the verdict. First, the invariant that makes the guard
 * look redundant lives on the **other side of a seam** — in `EngineEventBus`,
 * which the runner does not own; the runner's contract is with the
 * `SessionEventListener` interface, so the test drives that interface directly
 * with a capturing bus and reaches the branch easily.
 *
 * Second, and the part worth remembering: the effect of deleting it is **not**
 * the spurious HTTP request it first appears to be. The replay is folded into
 * the live turn, so if the durable stream already holds `step.ended` the turn
 * **settles on it while the agent is still writing** — a truncated answer,
 * delivered silently. The assertions are ordered `settled` first and the
 * request-path check second for that reason: with the path check first the
 * failure short-circuited there and read as a spurious fetch, understating a
 * silent truncation. Assertion order decides what a future reader believes the
 * test is for; keep it this way round.
 *
 * ### What the Phase 6 independent audit changed here
 *
 * Six of the rows above are new, and every one of them was a **survivor**: the
 * mutation passed all 758 tests before the adversarial input was added. The
 * sharpest was `post()`'s `if (!res.ok) { throw }` — with it gone, a 500 on
 * `POST /prompt` was swallowed whole and the turn hung to the twenty-minute
 * ceiling with nothing said to the user. `post()` is the single door to the
 * engine for the session create, the prompt, both reply endpoints and
 * `/interrupt`, so that one line carries all five.
 *
 * The `?after=` pair is worth reading together. `heals a mid-turn stream drop…`
 * gives its `text.delta` a `durable` block, and the verified contract says a
 * real `text.delta` carries **none** — so that test exercises the
 * `after !== null` branch only, and the null branch (the socket dying before
 * any durable event, which is the ordinary early-drop case) had no coverage at
 * all. Both branches are pinned now; keep both if this file is reorganised.
 *
 * ### Mutations that SURVIVE, and why no test was added for them
 *
 * | Mutation | Why nothing can fail |
 * |---|---|
 * | delete `parked.delete(update.settled)` in `ingest` | `pendingRequests.drop()` on the next line removes the entry, and `settle` no-ops when the entry is gone — so the later `cancel()` sweep does nothing either way |
 * | drop the `!res.ok` half of `replayDurable`'s guard | a non-OK replay body parses to nothing an `EngineEvent` can be made of, so it is dropped one layer further down |
 */
