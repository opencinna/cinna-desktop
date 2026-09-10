/**
 * The OpenCode runner's golden world: a fake engine, driven by a fixture file.
 *
 * `localAgentTurnRunner.test.ts` already drives the whole main-side turn with
 * only HTTP faked — the real `EngineEventBus`, `TurnStream`,
 * `StreamPartsAccumulator`, `pendingRequests` and `turnLock` wired together.
 * This is that harness **copied, not imported**: importing a test file registers
 * its tests, and a golden run that silently re-ran 40 unrelated cases would
 * make the test count lie. Keep the two in step by hand when the fake changes.
 *
 * ## What a fixture is
 *
 * Data, not code. `<scenario>.fixture.json` carries the world the turn runs in
 * (`setup`: which agent, which routes answer what) and a **step script** — push
 * this frame, answer that request, stop the engine, abort — that
 * {@link runFixture} interprets in order. Frames are the engine's own JSON as it
 * crosses the socket inside `data: …`; nothing here builds them.
 *
 * ## Why a second expectation file
 *
 * `expectGolden` compares `{events, result}` and nothing else. For this runner
 * that is half the behaviour: a permission answer is a `POST …/reply`, a stop is
 * a `POST …/interrupt` followed by a reject for whatever was still parked, and
 * none of it reaches `onEvent`. So the HTTP calls, the registry traffic and the
 * `saveSession` inputs are captured as **effects** and compared against
 * `<scenario>.effects.expected.json` under the same rules the shared harness
 * sets — written only when missing under `GOLDEN_WRITE=1`, never overwritten,
 * `_notes` not compared. Phase 1 rewrites the event vocabulary and should leave
 * these untouched; phase 3 replaces the transport and is expected to rewrite
 * them wholesale.
 */

import { vi } from 'vitest'
import { EngineEventBus } from '../../engineEventBus'
import { LocalAgentTurnRunner, type LocalTurnDeps } from '../../localAgentTurnRunner'
import { pendingRequests, type RequestResolution } from '../../pendingRequests'
import { turnLock } from '../../../localAgents/turnLock'
import { expectGoldenSidecar } from '../harness'
import type { RunAgentTurnInput, RunAgentTurnResult } from '../../../a2aStreamingService'
import type { AgentStreamEvent } from '../../../../../shared/agentStreamEvents'
import type { LocalAgentKind } from '../../../../../shared/localAgents'
import type { LocalPermissionRequest } from '../../../../../shared/localAgentRequests'
import type { EngineModelRef } from '../../../../engine/configGenerator'

export const CHAT_ID = 'chat_1'
export const AGENT_ID = 'folder:abc'

const AGENT_KEY = 'assistant_ab12'
const MODEL: EngineModelRef = { providerID: 'anthropic', id: 'claude-sonnet-4-6' }

/** One engine event exactly as it crosses the wire inside `data: …`. */
export interface EngineFrame {
  id?: string
  type: string
  durable?: { aggregateID: string; seq: number; version: number }
  data: Record<string, unknown>
}

/** What a scripted route answers. `sse` makes it a finished event-stream body. */
export interface RouteReply {
  status?: number
  body?: unknown
  sse?: EngineFrame[]
}

interface AgentOnDisk {
  name: string
  path: string
  kind: LocalAgentKind
  enabled: boolean
  readiness: string
  readinessReason: string | null
}

export interface WorldSetup {
  /** Merged over the default agent; `null` is a folder that is gone. */
  agent?: Partial<AgentOnDisk> | null
  agentKey?: string | null
  agentModel?: EngineModelRef | null
  engineStatus?: string
  engineError?: string | null
  /** The engine session id this chat already remembers. */
  remembered?: string | null
  /** A standing grant covers every permission ask. */
  isGranted?: boolean
  /** What `POST /api/session` mints. */
  sessionId?: string
  /**
   * Scripted answers, keyed `"METHOD /path?query"` or `"METHOD /path"`. An array
   * is answered in order and its last entry repeats — how a cold engine that
   * warms up between polls is written down.
   */
  routes?: Record<string, RouteReply | RouteReply[]>
  turnCeilingMs?: number
  engineReadyMs?: number
  /** Force the registry's park timer — the test-only knob `register` exposes. */
  parkTimeoutMs?: number
  /** Fake `setTimeout` for this run, so a readiness poll costs no real second. */
  fakeTimers?: boolean
}

export type Step =
  /** Wait until the runner has posted its prompt and is reading events. */
  | { op: 'awaitPrompt' }
  | { op: 'push'; frame: EngineFrame }
  /** Answer a parked ask the way the IPC layer does. */
  | { op: 'resolve'; requestId: string; resolution: RequestResolution }
  | { op: 'awaitRegistered'; requestId: string }
  | { op: 'awaitReleased'; requestId: string }
  /** End the global socket's body — a drop the bus will reconnect from. */
  | { op: 'closeStream' }
  /** What `agentTurn/index.ts` does when the engine leaves `running`. */
  | { op: 'shutdownBus' }
  | { op: 'abort' }
  /** Advance fake timers once one is armed. Needs `setup.fakeTimers`. */
  | { op: 'advance'; ms: number }
  /** Record what is pending right now into the effects. */
  | { op: 'checkpoint'; name: string }

export interface OpenCodeFixture {
  recorded_from: string
  /** The inline test(s) the frames were lifted from, when hand-written. */
  source?: string | string[]
  description: string
  setup?: WorldSetup
  steps: Step[]
}

export interface EngineCall {
  method: string
  path: string
  body?: unknown
}

export type SavedSession = Parameters<LocalTurnDeps['saveSession']>[0]

export interface Registration {
  requestId: string
  chatId: string
  agentId: string
  kind: 'permission' | 'question'
  request?: LocalPermissionRequest
}

export interface Effects {
  /** `ensureRunning`, `lock`, `unlock` — the reconcile-before-lock rule. */
  order: string[]
  /** Every request to the engine, in the order it was made. */
  calls: EngineCall[]
  registered: Registration[]
  saved: SavedSession[]
  checkpoints: { name: string; pending: { requestId: string; kind: string }[]; busConnected: boolean }[]
  /** What the turn left behind once it settled. */
  after: { pending: { requestId: string; kind: string }[]; locked: boolean; busConnected: boolean }
}

export interface World {
  runner: LocalAgentTurnRunner
  bus: EngineEventBus
  calls: EngineCall[]
  order: string[]
  saved: SavedSession[]
  push(frame: EngineFrame): void
  closeStream(): void
  promptCount(): number
  input(io: { signal: AbortSignal; onEvent?: (event: AgentStreamEvent) => void }): RunAgentTurnInput
}

const frameText = (frame: EngineFrame): string => `data: ${JSON.stringify(frame)}\n\n`

/** A finished SSE body, for the durable per-session replay. */
function sseBody(frames: EngineFrame[]): Response {
  const enc = new TextEncoder()
  return new Response(
    new ReadableStream<Uint8Array>({
      start(c) {
        for (const f of frames) c.enqueue(enc.encode(frameText(f)))
        c.close()
      }
    }),
    { status: 200 }
  )
}

function reply(r: RouteReply): Response {
  if (r.sse) return sseBody(r.sse)
  const body = typeof r.body === 'string' ? r.body : JSON.stringify(r.body ?? {})
  return new Response(body, { status: r.status ?? 200 })
}

const PROMPT_PATH = /^\/api\/session\/[^/]+\/prompt$/

/**
 * A runner over a fake engine. `hooks.onRead` sees every `readSession` answer,
 * which is how the contract's session clause learns what the second turn read.
 */
export function buildWorld(
  setup: WorldSetup = {},
  hooks: { onRead?: (sessionId: string | null) => void } = {}
): World {
  const calls: EngineCall[] = []
  const order: string[] = []
  const saved: SavedSession[] = []
  const store = new Map<string, string>()
  const storeKey = (chatId: string, agentId: string): string => `${chatId}|${agentId}`
  if (setup.remembered) store.set(storeKey(CHAT_ID, AGENT_ID), setup.remembered)

  const routes = new Map<string, RouteReply[]>(
    Object.entries(setup.routes ?? {}).map(([k, v]) => [k, Array.isArray(v) ? [...v] : [v]])
  )
  const scripted = (key: string): RouteReply | undefined => {
    const queue = routes.get(key)
    if (!queue || queue.length === 0) return undefined
    return queue.length > 1 ? queue.shift() : queue[0]
  }

  let ctrl: ReadableStreamDefaultController<Uint8Array> | null = null
  const enc = new TextEncoder()

  const request: LocalTurnDeps['request'] = async (path, init) => {
    const method = init?.method ?? 'GET'
    const body = init?.body ? JSON.parse(String(init.body)) : undefined
    calls.push({ method, path, ...(body === undefined ? {} : { body }) })

    if (path === '/api/event') {
      return new Response(
        new ReadableStream<Uint8Array>({
          start(c) {
            ctrl = c
          }
        }),
        { status: 200 }
      )
    }
    // The exact path first, so a fixture can script `?after=7` apart from the
    // readiness probes' `?location[directory]=…`, then the route without it.
    const route = path.split('?')[0]
    const override = scripted(`${method} ${path}`) ?? scripted(`${method} ${route}`)
    if (override) return reply(override)
    // A warm engine, as the inline fake answers one.
    if (route === '/api/agent') {
      return reply({ body: { data: [{ id: AGENT_KEY }] } })
    }
    if (route === '/api/model') {
      return reply({
        body: { data: [{ ...MODEL, api: { type: 'aisdk', package: '@ai-sdk/anthropic' } }] }
      })
    }
    if (path === '/api/session' && method === 'POST') {
      return reply({ body: { data: { id: setup.sessionId ?? 'ses_new' } } })
    }
    return reply({})
  }

  const bus = new EngineEventBus(
    (signal) => request('/api/event', { signal }).then((r) => r.body),
    () => Promise.resolve()
  )

  const deps: LocalTurnDeps = {
    ensureEngineRunning: async () => {
      order.push('ensureRunning')
      return { status: setup.engineStatus ?? 'running', error: setup.engineError ?? null }
    },
    agentKey: () => (setup.agentKey === undefined ? AGENT_KEY : setup.agentKey),
    agentModel: () => (setup.agentModel === undefined ? MODEL : setup.agentModel),
    skipReason: () => null,
    request,
    bus,
    getAgent: () =>
      setup.agent === null
        ? null
        : {
            name: 'Helper',
            path: '/agents/helper',
            kind: 'kit',
            enabled: true,
            readiness: 'ok',
            readinessReason: null,
            ...setup.agent
          },
    readSession: (chatId, agentId) => {
      const value = store.get(storeKey(chatId, agentId)) ?? null
      hooks.onRead?.(value)
      return value
    },
    saveSession: (input) => {
      saved.push({ ...input })
      store.set(storeKey(input.chatId, input.agentId), input.sessionId)
    },
    isGranted: () => setup.isGranted === true,
    // The real lock, so a turn that leaks it fails the next one as "busy".
    // `lock` is recorded only once it is actually held.
    withLock: async (agentId, owner, fn) => {
      let took = false
      try {
        return await turnLock.withLock(agentId, owner, () => {
          took = true
          order.push('lock')
          return fn()
        })
      } finally {
        if (took) order.push('unlock')
      }
    },
    userId: () => 'settings-user',
    turnCeilingMs: setup.turnCeilingMs,
    engineReadyMs: setup.engineReadyMs,
    autoReplyRetryMs: 0
  }

  return {
    runner: new LocalAgentTurnRunner(deps),
    bus,
    calls,
    order,
    saved,
    push: (frame) => ctrl?.enqueue(enc.encode(frameText(frame))),
    closeStream: () => ctrl?.close(),
    promptCount: () => calls.filter((c) => c.method === 'POST' && PROMPT_PATH.test(c.path)).length,
    input: (io) => ({
      chatId: CHAT_ID,
      agentId: AGENT_ID,
      agentName: 'Helper',
      wireContent: 'hello',
      signal: io.signal,
      onEvent: io.onEvent
    })
  }
}

/** Let queued microtasks drain. */
export const drain = async (): Promise<void> => {
  for (let i = 0; i < 80; i++) await Promise.resolve()
}

/**
 * `setImmediate`, not `setTimeout`: a fixture that fakes `setTimeout` for a
 * readiness poll must still be able to wait on the turn.
 */
const macrotask = (): Promise<void> => new Promise((resolve) => setImmediate(resolve))

export async function waitFor(cond: () => boolean, what: string, ms = 2_000): Promise<void> {
  const deadline = Date.now() + ms
  while (!cond()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`)
    await macrotask()
  }
}

/** Wait for a prompt beyond the first `before`, then for the runner to read on. */
export async function admitted(world: World, before = 0): Promise<void> {
  await waitFor(() => world.promptCount() > before, 'the prompt to be posted')
  await drain()
}

/** Run one fixture to its end and return everything it produced. */
export async function runFixture(
  fixture: OpenCodeFixture
): Promise<{ events: AgentStreamEvent[]; result: RunAgentTurnResult; effects: Effects }> {
  const setup = fixture.setup ?? {}
  if (setup.fakeTimers) vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })

  const registered: Registration[] = []
  const original = pendingRequests.register.bind(pendingRequests)
  const spy = vi.spyOn(pendingRequests, 'register').mockImplementation((input) => {
    registered.push({
      requestId: input.requestId,
      chatId: input.chatId,
      agentId: input.agentId,
      kind: input.kind,
      ...(input.request ? { request: input.request } : {})
    })
    return original(
      setup.parkTimeoutMs === undefined ? input : { ...input, timeoutMs: setup.parkTimeoutMs }
    )
  })

  try {
    const world = buildWorld(setup)
    const events: AgentStreamEvent[] = []
    const checkpoints: Effects['checkpoints'] = []
    const controller = new AbortController()
    let result: RunAgentTurnResult | undefined

    void world.runner
      .runTurn(world.input({ signal: controller.signal, onEvent: (e) => void events.push(e) }))
      .then((r) => {
        result = r
      })

    for (const step of fixture.steps) {
      switch (step.op) {
        case 'awaitPrompt':
          await waitFor(
            () => world.promptCount() > 0 || result !== undefined,
            'the prompt to be posted'
          )
          if (world.promptCount() === 0) {
            throw new Error(`the turn settled before it prompted: ${JSON.stringify(result)}`)
          }
          await drain()
          break
        case 'push':
          world.push(step.frame)
          await drain()
          break
        case 'resolve':
          if (!pendingRequests.resolve(step.requestId, step.resolution)) {
            throw new Error(`nothing is parked under ${step.requestId}`)
          }
          await drain()
          break
        case 'awaitRegistered':
          await waitFor(
            () => pendingRequests.owner(step.requestId) !== null,
            `${step.requestId} to be registered`
          )
          break
        case 'awaitReleased':
          await waitFor(
            () => pendingRequests.owner(step.requestId) === null,
            `${step.requestId} to be released`
          )
          await drain()
          break
        case 'closeStream':
          world.closeStream()
          await drain()
          break
        case 'shutdownBus':
          world.bus.shutdown()
          await drain()
          break
        case 'abort':
          controller.abort()
          await drain()
          break
        case 'advance':
          await waitFor(() => vi.getTimerCount() > 0, 'a timer to be armed')
          await vi.advanceTimersByTimeAsync(step.ms)
          break
        case 'checkpoint':
          checkpoints.push({
            name: step.name,
            pending: pendingRequests.listForChat(CHAT_ID),
            busConnected: world.bus.isConnected()
          })
          break
      }
    }

    await waitFor(() => result !== undefined, 'the turn to settle')
    // A parked ask swept in `finally` posts its reject fire-and-forget, after
    // the result is already returned. Let it land before the calls are read.
    await drain()
    await macrotask()
    await drain()

    return {
      events,
      result: result as RunAgentTurnResult,
      effects: {
        order: world.order,
        calls: world.calls,
        registered,
        saved: world.saved,
        checkpoints,
        after: {
          pending: pendingRequests.listForChat(CHAT_ID),
          locked: turnLock.isLocked(AGENT_ID),
          busConnected: world.bus.isConnected()
        }
      }
    }
  } finally {
    spy.mockRestore()
    if (setup.fakeTimers) vi.useRealTimers()
  }
}

/** Compare effects with `<scenario>.effects.expected.json`, by the harness's rules. */
export function expectEffects(scenario: string, effects: Effects): void {
  expectGoldenSidecar('opencode', scenario, 'effects', effects)
}
