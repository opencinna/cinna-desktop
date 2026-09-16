/**
 * What an A2A turn emits, pinned — phase 0 of the agent runtime plan
 * (`drafts/agent_runtime/phase_0_characterization.md`, steps
 * 0.2 and 0.3).
 *
 * Every scenario under `__golden__/a2a/` is replayed through the real
 * `runAgentTurn` and compared, whole, with its expectation file: every
 * `onEvent` call in order, and the returned `RunAgentTurnResult`. Phase 1
 * rewrites those files mechanically into the new vocabulary and phase 2 moves
 * client construction and the session store behind a driver; both are moments
 * when a quiet change to the sequence would otherwise go unnoticed.
 *
 * **Through the `a2a` driver, since phase 2.** Every scenario runs
 * `createA2aDriver(…).run` over the real `runAgentTurn`, with the connection
 * resolved the way `resolveEndpointIfNeeded` / `resolveAccessToken` would
 * answer for the fixture (its endpoint and token) and the row's owner saying
 * what `isCinnaTokenAuth` used to. So the driver's own pre-flight, its re-auth
 * flag and its cancel-on-abort are part of what is pinned. The factory takes
 * its world by injection, so none of `agents/drivers/index.ts`'s production
 * wiring — the engine manager, the folder services, Electron — is loaded. The
 * abort characterisation below still calls `runAgentTurn` alone: it is
 * evidence about the pump, not the driver.
 *
 * **The fake is `fetch`, not the SDK client** (`__golden__/a2a/fakeAgent.ts`
 * says why at length). The card fetch, the bearer header, the 401/403
 * intercept, the SSE tee, the SDK's JSON-RPC ids and its SSE parser all run for
 * real over real bytes. Replaced: `agentSessionRepo` (in memory, with the real
 * merge rule), the logger, and `messageRepo` / `jobService` as **empty
 * objects** — `runAgentTurn` imports both and must call neither, since
 * persistence is its caller's job; a call would throw inside its `try` and show
 * up in the golden diff as a turn error.
 *
 * **Side effects get an expectation of their own.** `expectGolden` compares
 * `{ events, result }` only, and what a turn *sends* (a remembered
 * contextId/taskId, `cinna_file_ids`, the bearer) and what it hands the session
 * store are invisible there — while being exactly what phase 2 moves. So each
 * scenario also has `<scenario>.effects.expected.json`, under the same rules
 * (`__golden__/a2a/effects.ts`).
 *
 * **No generated id reaches the events or the result.** Task, context and
 * artifact ids and notice part keys all come from the fixture, so the golden
 * comparison passes no id patterns. The one id the code mints is the user
 * message's nanoid `messageId` in the request body, normalised in the effects
 * by exact match on the value that was sent.
 *
 * The plan's seven scenarios, plus the paths `runAgentTurn` plainly has that
 * they miss: a `/run:*` tool pair and a `command_result`, a stream of bare
 * `message` events, a turn that resumes a remembered session, a JSON-RPC error
 * frame mid-stream, a task that ends `failed`, a 403 on a manually added agent,
 * a refused connection, and the non-streaming `message/send` path returning a
 * Task, a Message, and a JSON-RPC error. Phase 1 added `auth_required_state`:
 * the agent parking its task in `auth-required`, which is the only way to
 * reach the `auth` kind of `needs_input` — `auth_required_401` is a transport
 * rejection and never gets that far.
 *
 * Several expectations pin behaviour that looks wrong. Each says why in its
 * `_notes`; none is fixed here, because phase 0 records and does not change.
 *
 * Mutations run against `a2aStreamingService.ts`, each restored from a copy:
 *
 * | Mutation | Caught by |
 * |---|---|
 * | Drop the `status` onEvent in the `status-update` branch | 12 goldens (every scenario with a status-update frame) and the abort characterisation, which times out waiting for its first event |
 * | Skip `agentSessionRepo.upsert` on the success path | 15 effects expectations and the contract's `session` clause — **no** `{ events, result }` golden, which is why effects are pinned separately |
 * | (phase 2, `a2aDriver.ts`) `respond` answers `delivered: true` | the contract's `respond.unknown` |
 * | (phase 2, `a2aDriver.ts`) readiness rethrows a card-fetch failure | the contract's `readiness.never_throws` |
 * | (phase 2, `capabilities.ts`) every row of a driver shares one capabilities object | the contract's `capabilities.stable` on all three drivers, and `auth_required_401` — the re-auth flag read the object that clause had edited |
 *
 * Phase 6 connects cancellation to HTTP, including silent streams. Both abort
 * contract clauses now pass without a server response; stopped turns preserve
 * streamed parts and do not advance the saved session checkpoint past the ids
 * the stream's first task event carried (crash recovery).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { FakeSessionRepo, Frame, RecordedRequest, SessionPatch } from './__golden__/a2a/fakeAgent'

const sessions = vi.hoisted(() => ({ current: undefined as FakeSessionRepo | undefined }))

vi.mock('../../logger/logger', () => ({
  createLogger: () => ({ debug: () => {}, info: () => {}, warn: () => {}, error: () => {} })
}))
vi.mock('../../db/agents', () => ({
  agentSessionRepo: {
    getByChatAndAgent: (chatId: string, agentId: string) => {
      if (!sessions.current) throw new Error('golden a2a: no session repo installed')
      return sessions.current.getByChatAndAgent(chatId, agentId)
    },
    upsert: (patch: SessionPatch) => {
      if (!sessions.current) throw new Error('golden a2a: no session repo installed')
      sessions.current.upsert(patch)
    }
  }
}))
vi.mock('../../db/messages', () => ({ messageRepo: {} }))
vi.mock('../../services/jobService', () => ({ jobService: {} }))

import { runAgentTurn, type RunAgentTurnResult } from '../../services/a2aStreamingService'
import { fetchAgentCard } from '../a2a-client'
import { collectPollDelays } from '../a2aTaskCollect'
import { CINNA_REAUTH_REQUIRED_CODE, CINNA_SESSION_EXPIRED_MESSAGE } from '../../../shared/cinnaErrors'
import { createA2aDriver, type A2aDriverDeps } from './a2aDriver'
import type { AgentDriver } from './driver'
import type { AgentRow } from '../../db/agents'
import { expectGolden, listScenarios, readFixture, type NormaliseOptions } from './__golden__/harness'
import {
  describeDriverContract,
  type ContractTurn,
  type DriverContractSubject,
  type DriverUnderTest,
  type TurnIO
} from './__golden__/driverContract'
import { goldenRow } from './__golden__/driverWorld'
import { fakeA2aAgent, fakeSessionRepo, type A2aFixture, type FakeAgent } from './__golden__/a2a/fakeAgent'
import { expectEffects } from './__golden__/a2a/effects'
import type { RunEvent } from '../../../shared/runEvents'

const SCENARIOS = [
  'plain_text',
  'tool_roundtrip',
  'input_required',
  'input_required_replayed_tool',
  'auth_required_state',
  'auth_required_401',
  'canceled_midway',
  'canceled_then_stream_error',
  'notice',
  'file_part',
  'command_result',
  'run_command_pair',
  'stream_message_events',
  'resume_remembered_context',
  'stream_rpc_error',
  'task_failed',
  'auth_rejected_403_local',
  'network_refused',
  'nonstreaming_task',
  'nonstreaming_message',
  'nonstreaming_rpc_error'
] as const
type Scenario = (typeof SCENARIOS)[number]

it('runs every a2a fixture on disk', () => {
  expect([...SCENARIOS].sort()).toEqual(listScenarios('a2a'))
})

const fixtureOf = (scenario: Scenario): A2aFixture => readFixture<A2aFixture>('a2a', scenario)

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

afterEach(() => {
  vi.unstubAllGlobals()
  sessions.current = undefined
})

interface TurnHooks extends TurnIO {
  onClient?: () => void
  onTaskId?: (taskId: string) => void
}

/** The scope that owns every golden row. */
const OWNER = 'user-golden'

/**
 * The row a fixture's agent is. Its owner stands for what the fixture used to
 * say with `isCinnaTokenAuth`: a Cinna-synced row is what makes a stream-level
 * 401 a re-auth.
 */
function rowOf(fixture: A2aFixture): AgentRow {
  const { input } = fixture
  return goldenRow({
    id: input.agentId,
    name: input.agentName,
    driver: 'a2a',
    source: input.isCinnaTokenAuth ? 'remote' : 'local',
    cardUrl: input.cardUrl,
    endpointUrl: input.endpointUrl,
    protocolInterfaceUrl: input.endpointUrl,
    accessTokenEncrypted: input.accessToken ? Buffer.from('golden-token') : null
  })
}

/**
 * The `a2a` driver over the real `runAgentTurn`, with the connection resolved
 * as `resolveEndpointIfNeeded` / `resolveAccessToken` would answer for this
 * fixture. `hooks` taps the two callbacks the driver hands the runner — that is
 * how the effects still count them — and passes each on to the driver.
 */
function a2aDriverFor(
  fixture: A2aFixture,
  hooks: Pick<TurnHooks, 'onClient' | 'onTaskId'> = {},
  over: Partial<A2aDriverDeps> = {}
): AgentDriver {
  return createA2aDriver({
    runTurn: (input) =>
      runAgentTurn({
        ...input,
        onClient: (client) => {
          hooks.onClient?.()
          input.onClient?.(client)
        },
        onTaskId: (taskId) => {
          hooks.onTaskId?.(taskId)
          input.onTaskId?.(taskId)
        }
      }),
    resolveEndpoint: async () => fixture.input.endpointUrl,
    resolveAccessToken: async () => fixture.input.accessToken,
    fetchCard: (cardUrl, accessToken) => fetchAgentCard(cardUrl, accessToken),
    isReauthRequired: () => false,
    saveTaskState: ({ chatId, agentId, taskId, taskState }) =>
      sessions.current?.upsert({ chatId, agentId, contextId: null, taskId, taskState }),
    ...over
  })
}

/**
 * Start one turn: install the fakes, call the driver's `run` exactly once, and
 * return its promise untouched — no `catch`, so the contract's never-rejects
 * clause tests the driver and not this function.
 */
function startTurn(
  fixture: A2aFixture,
  agent: FakeAgent,
  repo: FakeSessionRepo,
  hooks: TurnHooks
): Promise<RunAgentTurnResult> {
  sessions.current = repo
  vi.stubGlobal('fetch', agent.fetch)
  return a2aDriverFor(fixture, hooks).run(OWNER, rowOf(fixture), {
    chatId: fixture.input.chatId,
    wireContent: fixture.input.wireContent,
    fileIds: fixture.input.fileIds,
    ...(fixture.input.messageId ? { messageId: fixture.input.messageId } : {}),
    signal: hooks.signal,
    onEvent: hooks.onEvent
  })
}

/** `runAgentTurn` alone — for the characterisation that is evidence about the pump itself. */
function startPumpTurn(
  fixture: A2aFixture,
  agent: FakeAgent,
  repo: FakeSessionRepo,
  hooks: TurnHooks
): Promise<RunAgentTurnResult> {
  sessions.current = repo
  vi.stubGlobal('fetch', agent.fetch)
  return runAgentTurn({
    ...fixture.input,
    signal: hooks.signal,
    onEvent: hooks.onEvent,
    onClient: hooks.onClient,
    onTaskId: hooks.onTaskId
  })
}

function seededRepo(fixture: A2aFixture): FakeSessionRepo {
  return fakeSessionRepo(
    fixture.session
      ? { chatId: fixture.input.chatId, agentId: fixture.input.agentId, ...fixture.session }
      : undefined
  )
}

/** `buildSendParams` mints the user message's id with nanoid; match the value it sent. */
function messageIdPatterns(agent: FakeAgent): NonNullable<NormaliseOptions['ids']> {
  return agent.requests.flatMap((request) => {
    const params = request.body?.params as { message?: { messageId?: unknown } } | undefined
    const id = params?.message?.messageId
    if (typeof id !== 'string') return []
    return [{ label: 'messageId', pattern: new RegExp(id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')) }]
  })
}

/** `plain_text` cut after its `working` status, with the stream left open. */
function heldPlainText(): A2aFixture {
  const fixture = fixtureOf('plain_text')
  const rpc = fixture.http.rpc
  if (!rpc || !('sse' in rpc)) throw new Error('plain_text must be a streaming fixture')
  return { ...fixture, http: { ...fixture.http, rpc: { sse: rpc.sse.slice(0, 2), hold: true } } }
}

describe('golden: a2a (driver over runAgentTurn)', () => {
  it.each(SCENARIOS)('%s', async (scenario) => {
    const fixture = fixtureOf(scenario)
    const agent = fakeA2aAgent(fixture)
    const repo = seededRepo(fixture)
    const controller = new AbortController()
    const events: RunEvent[] = []
    const taskIdsSurfaced: string[] = []
    let clientsSurfaced = 0
    const abortAt = fixture.script?.abortAfterEmitted

    const result = await startTurn(fixture, agent, repo, {
      signal: controller.signal,
      onEvent: (event) => {
        events.push(event)
        // Synchronously, inside the call — the same point a user's stop lands
        // relative to the pump as a port message handler would see it.
        if (events.length === abortAt) controller.abort()
      },
      onClient: () => void clientsSurfaced++,
      onTaskId: (taskId) => void taskIdsSurfaced.push(taskId)
    })

    // Both comparisons run before either failure is thrown, so one run shows
    // both diffs and a first `GOLDEN_WRITE=1` run writes both files.
    let streamFailure: unknown
    try {
      expectGolden('a2a', scenario, { events, result })
    } catch (err) {
      streamFailure = err
    }
    expectEffects(
      scenario,
      {
        requests: agent.requests,
        sessionReads: repo.reads,
        sessionUpserts: repo.upserts,
        taskIdsSurfaced,
        clientsSurfaced
      },
      { ids: messageIdPatterns(agent) }
    )
    if (streamFailure) throw streamFailure
  })
})

describe('a2a abort', () => {
  it('settles on Stop while the server stays silent and keeps only the ids its stream carried', async () => {
    const fixture = heldPlainText()
    const agent = fakeA2aAgent(fixture)
    const repo = seededRepo(fixture)
    const controller = new AbortController()
    const events: RunEvent[] = []
    let markStarted!: () => void
    const started = new Promise<void>((resolve) => { markStarted = resolve })
    const promise = startPumpTurn(fixture, agent, repo, {
      signal: controller.signal,
      onEvent: (event) => {
        events.push(event)
        if (event.type === 'status' && event.state === 'working') markStarted()
      }
    })
    await started
    controller.abort()
    const outcome = await Promise.race([
      promise.then(() => 'settled' as const),
      sleep(100).then(() => 'still pending' as const)
    ])
    expect(outcome).toBe('settled')
    expect(agent.requests.map((r) => [r.method, r.signal])).toEqual([['GET', true], ['POST', true]])
    const result = await promise
    expect(result.error).toBeDefined()
    // The first event's ids were saved as it arrived; the stop adds nothing.
    expect(repo.upserts).toEqual([
      { chatId: 'chat-golden', agentId: 'agent-remote-1', contextId: 'ctx-plain-1', taskId: 'task-plain-1', taskState: null }
    ])
    expect(events.map((e) => e.type)).toEqual(['status', 'status'])
    agent.close()
  })
})

/** A contract turn over one fixture, with a fresh fake agent per run. */
function fixtureTurn(fixture: A2aFixture, repo: FakeSessionRepo = seededRepo(fixture)): ContractTurn {
  return { run: (io) => startTurn(fixture, fakeA2aAgent(fixture), repo, io) }
}

function makeSubject(): DriverContractSubject {
  return {
    completes: () => fixtureTurn(fixtureOf('plain_text')),

    failures: () => ({
      'transport 401 on message/stream (A2aHttpError, Cinna token)': fixtureTurn(fixtureOf('auth_required_401')),
      'network throw at the card fetch (ECONNREFUSED)': fixtureTurn(fixtureOf('network_refused')),
      'JSON-RPC error frame mid-stream': fixtureTurn(fixtureOf('stream_rpc_error')),
      // Protocol-level failures must also carry result.error, including
      // terminal failed tasks and non-streaming JSON-RPC errors.
      task_failed: fixtureTurn(fixtureOf('task_failed')),
      nonstreaming_rpc_error: fixtureTurn(fixtureOf('nonstreaming_rpc_error'))
    }),

    // Nothing on the far side reacts to the abort: `runAgentTurn` has to end
    // the turn by itself.
    hangs: () => heldTurn({ serverEndsStreamOnAbort: false }),

    // Clean server EOF racing Stop must report cancellation too.
    hangsServerAssisted: () => heldTurn({ serverEndsStreamOnAbort: true }),

    underTest: () => {
      const fixture = fixtureOf('plain_text')
      return { driver: a2aDriverFor(fixture), row: rowOf(fixture), grantsWritten: () => 0 }
    },

    readinessWorlds: () => {
      // Readiness resolves a token, then fetches the card. Each world breaks
      // one of those before any real request could go out.
      const fixture = fixtureOf('plain_text')
      const world = (over: Partial<A2aDriverDeps>, row: AgentRow = rowOf(fixture)): DriverUnderTest => ({
        driver: a2aDriverFor(fixture, {}, over),
        row,
        grantsWritten: () => 0
      })
      return {
        'the token resolution rejects': world({
          resolveAccessToken: () => Promise.reject(new Error('the keystore is locked'))
        }),
        'the token resolution throws synchronously': world({
          resolveAccessToken: () => {
            throw new Error('safeStorage is not available')
          }
        }),
        'the card fetch rejects with an Error': world({
          fetchCard: () => Promise.reject(new Error('Unexpected token < in JSON at position 0'))
        }),
        'the card fetch rejects with a TypeError (the socket never opened)': world({
          fetchCard: () => Promise.reject(new TypeError('fetch failed'))
        }),
        'the card fetch throws synchronously': world({
          fetchCard: () => {
            throw new TypeError('fetch is not a function')
          }
        }),
        'the card never answers': world({
          fetchCard: () => new Promise<never>(() => {}),
          readinessTimeoutMs: 20
        }),
        'the row has no card URL': world({}, { ...rowOf(fixture), cardUrl: null })
      }
    },

    session: () => {
      // One store for both turns. `resume_remembered_context`'s own seeded row
      // is ignored here: the second turn must find what the first one saved.
      const repo = fakeSessionRepo()
      const first = fixtureOf('plain_text')
      const second = fixtureOf('resume_remembered_context')
      if (first.input.chatId !== second.input.chatId || first.input.agentId !== second.input.agentId) {
        throw new Error('session pair fixtures must share a chat and an agent')
      }
      return {
        first: fixtureTurn(first, repo),
        second: fixtureTurn(second, repo),
        saved: () => repo.upserts.flatMap((u) => (u.contextId ? [u.contextId] : [])),
        readBySecond: () => repo.reads[1]?.contextId ?? null
      }
    }
  }
}

/**
 * A turn on a stream that stays open until something ends it.
 *
 * `serverEndsStreamOnAbort` is the whole difference between the contract's two
 * abort clauses: without it the runner alone must end the turn; with it the
 * fake server ends the stream, as a real one does after `tasks/cancel`.
 */
function heldTurn({
  serverEndsStreamOnAbort
}: {
  serverEndsStreamOnAbort: boolean
}): ReturnType<DriverContractSubject['hangs']> {
  const fixture = heldPlainText()
  let markStarted: () => void = () => {}
  const started = new Promise<void>((resolve) => {
    markStarted = resolve
  })
  return {
    started: () => started,
    run: (io) => {
      const agent = fakeA2aAgent(fixture)
      if (serverEndsStreamOnAbort) agent.closeOnAbort(io.signal)
      return startTurn(fixture, agent, fakeSessionRepo(), {
        signal: io.signal,
        onEvent: (event) => {
          io.onEvent(event)
          if (event.type === 'status' && event.state === 'working') markStarted()
        }
      })
    }
  }
}

describeDriverContract('a2a', makeSubject)

describe('the quit flush snapshot', () => {
  it('reads what the pump has streamed while the stream is still open, through the driver', async () => {
    // Mutation: drop `registerSnapshot` in `runAgentTurn`, or its forwarding in
    // the driver → nothing is registered, and a quit loses the streamed text.
    // `plain_text` held open after its first text frame.
    const base = fixtureOf('plain_text')
    const rpc = base.http.rpc
    if (!rpc || !('sse' in rpc)) throw new Error('plain_text must be a streaming fixture')
    const fixture: A2aFixture = { ...base, http: { ...base.http, rpc: { sse: rpc.sse.slice(0, 3), hold: true } } }
    const agent = fakeA2aAgent(fixture)
    const controller = new AbortController()
    let read: (() => { parts: { kind: string; text: string }[] }) | undefined
    let streamed: () => void = () => {}
    const delta = new Promise<void>((resolve) => { streamed = resolve })
    sessions.current = fakeSessionRepo()
    vi.stubGlobal('fetch', agent.fetch)
    agent.closeOnAbort(controller.signal)
    const turn = a2aDriverFor(fixture).run(OWNER, rowOf(fixture), {
      chatId: fixture.input.chatId,
      wireContent: fixture.input.wireContent,
      signal: controller.signal,
      onEvent: (event) => { if (event.type === 'delta') streamed() },
      registerSnapshot: (snapshot) => { read = snapshot }
    })
    await delta
    expect(read).toBeDefined()
    const held = read!().parts
    expect(held.length).toBeGreaterThan(0)
    controller.abort()
    const result = await turn
    expect(result.parts.slice(0, held.length)).toEqual(held)
  })
})

/**
 * Crash recovery against the Cinna A2A contract (`docs/agents/turn_recovery/turn_recovery_tech.md`):
 * ids saved from the first task event, the user row id as `messageId`, and a
 * stream that ends without `final: true` (or drops) collected from
 * `tasks/get` — only when the history proves the backend can report it.
 */
describe('crash recovery', () => {
  const MESSAGE_ID = 'user-row-1'
  const saved = { ...collectPollDelays }
  beforeEach(() => {
    collectPollDelays.fastMs = 1
    collectPollDelays.slowMs = 1
  })
  afterEach(() => {
    Object.assign(collectPollDelays, saved)
  })

  const text = (t: string): { kind: 'text'; text: string; metadata: Record<string, string> } => ({
    kind: 'text', text: t, metadata: { 'cinna.content_kind': 'text' }
  })
  const working = { result: { kind: 'status-update', taskId: 'task-r', contextId: 'ctx-r', status: { state: 'working' }, final: false } }
  const partial = { result: { kind: 'artifact-update', taskId: 'task-r', contextId: 'ctx-r', artifact: { artifactId: 'art-r', parts: [text('Partial')] } } }

  /** A `tasks/get` answer in the Cinna shape. */
  const task = (state: string, history: unknown[]): Frame => ({
    result: { kind: 'task', id: 'task-r', contextId: 'ctx-r', status: { state }, history }
  })
  const userMsg = (id: string, clientId?: string): unknown => ({
    kind: 'message', role: 'user', messageId: `srv-${id}`, parts: [text(`question ${id}`)],
    ...(clientId ? { metadata: { 'cinna.client_message_id': clientId } } : {})
  })
  const agentMsg = (id: string, parts: unknown[], state = 'complete'): unknown => ({
    kind: 'message', role: 'agent', messageId: `srv-${id}`, parts, metadata: { 'cinna.message_state': state }
  })
  /** An earlier finished turn, then ours. */
  const finished = (state: string, answer: unknown[]): Frame => task(state, [
    userMsg('old', 'earlier-row'),
    agentMsg('old-a', [text('Old answer')]),
    userMsg('ours', MESSAGE_ID),
    agentMsg('ours-a', answer)
  ])

  function recoveryFixture(rpc: A2aFixture['http']['rpc'], over: Partial<A2aFixture['http']> = {}): A2aFixture {
    const base = fixtureOf('plain_text')
    return {
      ...base,
      input: { ...base.input, messageId: MESSAGE_ID },
      http: { ...base.http, rpc, ...over }
    }
  }

  /**
   * One turn. `dropAfterDelta` holds the stream open and drops it once the
   * turn has streamed its first text — the moment a real connection would go.
   */
  async function run(fixture: A2aFixture, { dropAfterDelta = false } = {}): Promise<{
    result: RunAgentTurnResult
    events: RunEvent[]
    agent: FakeAgent
    repo: FakeSessionRepo
  }> {
    const agent = fakeA2aAgent(fixture)
    const repo = fakeSessionRepo()
    const events: RunEvent[] = []
    const result = await startTurn(fixture, agent, repo, {
      signal: new AbortController().signal,
      onEvent: (e) => {
        events.push(e)
        if (dropAfterDelta && e.type === 'delta') queueMicrotask(() => agent.drop())
      }
    })
    return { result, events, agent, repo }
  }

  const tasksGets = (agent: FakeAgent): RecordedRequest[] =>
    agent.requests.filter((r) => r.body?.method === 'tasks/get')
  const partTexts = (result: RunAgentTurnResult): string[] => result.parts.map((p) => p.text)

  it('saves the ids while the stream is still open', async () => {
    // Mutation: drop `saveFirstIds` from `setStreamTaskId` → nothing is saved
    // until the stream ends, and a quit or a drop loses the session.
    const fixture = heldPlainText()
    const agent = fakeA2aAgent(fixture)
    const repo = fakeSessionRepo()
    const controller = new AbortController()
    agent.closeOnAbort(controller.signal)
    let markWorking!: () => void
    const isWorking = new Promise<void>((resolve) => { markWorking = resolve })
    const turn = startTurn(fixture, agent, repo, {
      signal: controller.signal,
      onEvent: (e) => { if (e.type === 'status' && e.state === 'working') markWorking() }
    })
    await isWorking
    expect(repo.upserts).toEqual([
      { chatId: 'chat-golden', agentId: 'agent-remote-1', contextId: 'ctx-plain-1', taskId: 'task-plain-1', taskState: null }
    ])
    controller.abort()
    await turn
  })

  it('sends the given messageId, and asks tasks/get nothing after a final event', async () => {
    const fixture = fixtureOf('plain_text')
    const { agent, result } = await run({ ...fixture, input: { ...fixture.input, messageId: MESSAGE_ID } })
    const params = agent.requests[1].body?.params as { message: { messageId: string } }
    expect(params.message.messageId).toBe(MESSAGE_ID)
    expect(tasksGets(agent)).toEqual([])
    expect(result.error).toBeUndefined()
  })

  it('polls a stream that ended without a final event and replaces the streamed parts', async () => {
    // Mutation: skip `collectFromServer` after the loop → the turn fails with
    // "ended with task state working" and keeps "Partial".
    const fixture = recoveryFixture({ sse: [working, partial] }, {
      tasksGet: [
        task('working', [userMsg('ours', MESSAGE_ID), agentMsg('ours-a', [text('Part')], 'streaming')]),
        finished('completed', [text('Full answer'), { kind: 'text', text: 'Environment ready', metadata: { 'cinna.content_kind': 'notice' } }])
      ]
    })
    const { result, events, agent } = await run(fixture)
    expect(result.error).toBeUndefined()
    expect(partTexts(result)).toEqual(['Full answer'])
    expect(result.text).toBe('Full answer')
    expect(result.notices.map((n) => n.text)).toEqual(['Environment ready'])
    expect(result.taskState).toBe('completed')
    expect(events.at(-1)).toEqual({ type: 'status', state: 'completed', taskId: 'task-r', contextId: 'ctx-r' })
    const gets = tasksGets(agent)
    expect(gets).toHaveLength(2)
    expect(gets[0].body?.params).toEqual({ id: 'task-r', historyLength: 50 })
  })

  it('keeps the streamed parts and takes the state when our message is not in the history', async () => {
    const fixture = recoveryFixture({ sse: [working, partial] }, {
      tasksGet: [task('completed', [userMsg('old', 'earlier-row'), agentMsg('old-a', [text('Old answer')])])]
    })
    const { result } = await run(fixture)
    expect(partTexts(result)).toEqual(['Partial'])
    expect(result.taskState).toBe('completed')
    expect(result.error).toBeUndefined()
  })

  it.each([
    ['a history without cinna keys (old backend)', [task('working', [{ kind: 'message', role: 'user', messageId: 'm', parts: [text('q')] }])]],
    ['no tasks/get at all', undefined]
  ])('behaves as before on %s', async (_label, tasksGet) => {
    const fixture = recoveryFixture({ sse: [working, partial] }, tasksGet ? { tasksGet } : {})
    const { result, agent } = await run(fixture)
    expect(tasksGets(agent)).toHaveLength(1)
    expect(partTexts(result)).toEqual(['Partial'])
    expect(result.taskState).toBe('working')
    expect(result.error).toMatchObject({ code: 'agent_task_failed', raw: 'A2A task state: working' })
  })

  it('collects a turn whose stream dropped mid-response', async () => {
    // Mutation: drop the `isTransportDrop` branch in the catch → the result is
    // the connection error.
    const fixture = recoveryFixture({ sse: [working, partial], hold: true }, {
      tasksGet: [finished('completed', [text('Done after the drop')])]
    })
    const { result, repo } = await run(fixture, { dropAfterDelta: true })
    expect(result.error).toBeUndefined()
    expect(partTexts(result)).toEqual(['Done after the drop'])
    expect(result.taskState).toBe('completed')
    expect(repo.upserts.at(-1)).toMatchObject({ taskId: 'task-r', taskState: 'completed' })
  })

  describe('a backend that is down when the stream drops', () => {
    const refused = { network: { message: 'fetch failed', causeCode: 'ECONNREFUSED', causeMessage: 'connect ECONNREFUSED' } }
    const badGateway = { status: 502, statusText: 'Bad Gateway' }
    const DROPPED = 'Agent connection closed unexpectedly (server disconnected mid-response).'
    /** `plain_text` is a hand-added agent; these turns are a synced Cinna agent's. */
    const cinna = (fixture: A2aFixture): A2aFixture => ({ ...fixture, input: { ...fixture.input, isCinnaTokenAuth: true } })

    it.each([
      ['a refused connection', refused],
      ['a proxy 502', badGateway]
    ])('rides out %s on the first tasks/get of a Cinna agent, and collects the turn', async (_label, down) => {
      // Mutation: drop `rideOutFirstRead` (or, for the 502,
      // `transientStatusUnreachable`) in `collectFromServer` → the stream error.
      const fixture = cinna(recoveryFixture({ sse: [working, partial], hold: true }, {
        tasksGet: [down, down, finished('completed', [text('Done once it was back')])]
      }))
      const { result, agent } = await run(fixture, { dropAfterDelta: true })
      expect(result.error).toBeUndefined()
      expect(partTexts(result)).toEqual(['Done once it was back'])
      expect(result.taskState).toBe('completed')
      expect(tasksGets(agent)).toHaveLength(3)
    })

    it('keeps the stream error once the backend stays down past the patience', async () => {
      collectPollDelays.dropsForMs = 20
      const fixture = cinna(recoveryFixture({ sse: [working, partial], hold: true }, { tasksGet: [refused] }))
      const { result, agent } = await run(fixture, { dropAfterDelta: true })
      expect(tasksGets(agent).length).toBeGreaterThan(1)
      expect(partTexts(result)).toEqual(['Partial'])
      expect(result.error?.message).toBe(DROPPED)
    })

    it.each([
      ['a refused connection', refused],
      ['a proxy 502', badGateway]
    ])('fails at once on %s for an agent that is not Cinna', async (_label, down) => {
      const base = recoveryFixture({ sse: [working, partial], hold: true }, {
        tasksGet: [down, finished('completed', [text('never read')])]
      })
      const fixture: A2aFixture = { ...base, input: { ...base.input, isCinnaTokenAuth: false } }
      const { result, agent } = await run(fixture, { dropAfterDelta: true })
      expect(tasksGets(agent)).toHaveLength(1)
      expect(partTexts(result)).toEqual(['Partial'])
      expect(result.error?.message).toBe(DROPPED)
    })
  })

  describe('a turn the server ended with no reply', () => {
    const CUT_OFF = { code: 'reply_cut_off', message: 'The agent’s reply was cut off before it finished. Send your message again to retry.' }

    it.each(['completed', 'failed'])('keeps what streamed and ends cut off when the history, %s, has only our message', async (state) => {
      // The backend crashed mid-turn; its orphan repair ended the turn
      // without writing the agent's row. Mutation: take `found` alone as a
      // server reply in `finishTurn` → the parts are replaced with nothing.
      const fixture = recoveryFixture({ sse: [working, partial], hold: true }, {
        tasksGet: [task(state, [userMsg('ours', MESSAGE_ID)])]
      })
      const { result, events, repo } = await run(fixture, { dropAfterDelta: true })
      expect(partTexts(result)).toEqual(['Partial'])
      expect(result.text).toBe('Partial')
      // Mutation: drop the `lost` state in `collectFromServer` → completed,
      // no error (or, under `failed`, the generic task failure).
      expect(result.taskState).toBe('aborted')
      expect(result.error).toMatchObject(CUT_OFF)
      expect(events.at(-1)).toEqual({ type: 'status', state: 'unknown', taskId: 'task-r', contextId: 'ctx-r' })
      expect(repo.upserts.at(-1)).toMatchObject({ taskId: 'task-r', taskState: 'aborted' })
    })

    it('keeps what streamed after a stream that closed without a final event, too', async () => {
      const fixture = recoveryFixture({ sse: [working, partial] }, {
        tasksGet: [task('completed', [userMsg('ours', MESSAGE_ID)])]
      })
      const { result } = await run(fixture)
      expect(partTexts(result)).toEqual(['Partial'])
      expect(result.error).toMatchObject(CUT_OFF)
    })

    it('keeps the stream’s outcome for a stop the server reports with no reply', async () => {
      const fixture = recoveryFixture({ sse: [working, partial] }, {
        tasksGet: [task('canceled', [userMsg('ours', MESSAGE_ID)])]
      })
      const { result } = await run(fixture)
      expect(partTexts(result)).toEqual(['Partial'])
      expect(result.taskState).toBe('canceled')
      expect(result.error).toBeUndefined()
    })

    it('ends cut off when nothing streamed either', async () => {
      // Mutation: require streamed output for `lost` in `collectFromServer`
      // → the turn ends completed, with no reply and no card.
      const fixture = recoveryFixture({ sse: [working] }, {
        tasksGet: [task('completed', [userMsg('ours', MESSAGE_ID)])]
      })
      const { result, repo } = await run(fixture)
      expect(result.parts).toEqual([])
      expect(result.taskState).toBe('aborted')
      expect(result.error).toMatchObject(CUT_OFF)
      expect(repo.upserts.at(-1)).toMatchObject({ taskId: 'task-r', taskState: 'aborted' })
    })

    it('does not end cut off when a later message follows ours and the agent answered after it', async () => {
      // The backend may answer two queued messages in one reply. Mutation:
      // drop `answeredWithNext` from `replyLost` → a cut-off failure.
      const fixture = recoveryFixture({ sse: [working, partial], hold: true }, {
        tasksGet: [task('completed', [userMsg('ours', MESSAGE_ID), userMsg('later', 'later-row'), agentMsg('both', [text('Both answered')])])]
      })
      const { result } = await run(fixture, { dropAfterDelta: true })
      expect(partTexts(result)).toEqual(['Partial'])
      expect(result.taskState).toBe('completed')
      expect(result.error).toBeUndefined()
    })

    it('takes a completed reply that is only a notice, and saves the notice', async () => {
      // Mutation: `hasReply: parts.length > 0` in `readTurn` → the turn ends
      // cut off and the notice is lost.
      const notice = { kind: 'text', text: 'Env started', metadata: { 'cinna.content_kind': 'notice' } }
      const fixture = recoveryFixture({ sse: [working] }, {
        tasksGet: [task('completed', [userMsg('ours', MESSAGE_ID), agentMsg('ours-a', [notice])])]
      })
      const { result, repo } = await run(fixture)
      expect(result.error).toBeUndefined()
      expect(result.parts).toEqual([])
      expect(result.notices.map((n) => n.text)).toEqual(['Env started'])
      expect(result.taskState).toBe('completed')
      expect(repo.upserts.at(-1)).toMatchObject({ taskId: 'task-r', taskState: 'completed' })
    })

    it.each(['aborted', 'complete'])('keeps what streamed under a %s row whose only part is empty text, and ends cut off', async (rowState) => {
      // The backend writes a cut-off row with nothing flushed as one empty
      // text part. Mutation: `hasReply: !!lastAgentMessage` in `readTurn` →
      // under `complete`, the empty server copy replaces "Partial" and the
      // turn reads completed (under `aborted` the richness check still keeps it).
      const fixture = recoveryFixture({ sse: [working, partial], hold: true }, {
        tasksGet: [task('completed', [userMsg('ours', MESSAGE_ID), agentMsg('ours-a', [text('')], rowState)])]
      })
      const { result } = await run(fixture, { dropAfterDelta: true })
      expect(partTexts(result)).toEqual(['Partial'])
      expect(result.text).toBe('Partial')
      expect(result.taskState).toBe('aborted')
      expect(result.error).toMatchObject(CUT_OFF)
    })
  })

  describe('a cut-off reply on the server beside what streamed here', () => {
    const CUT_OFF = { code: 'reply_cut_off', message: 'The agent’s reply was cut off before it finished. Send your message again to retry.' }
    const tool = { kind: 'text', text: 'Using tool: bash', metadata: { 'cinna.content_kind': 'tool', 'cinna.tool_name': 'bash', 'cinna.tool_id': 't1' } }
    const toolFrame = { result: { kind: 'artifact-update', taskId: 'task-r', contextId: 'ctx-r', artifact: { artifactId: 'art-t', parts: [tool] } } }

    it('keeps the stream when the server’s aborted row holds less, and still ends cut off', async () => {
      // The backend crashed after flushing only the first text; the tool part
      // streamed here after it. Mutation: drop the richness check in
      // `serverCopyWins` → the tool part vanishes.
      const fixture = recoveryFixture({ sse: [working, partial, toolFrame] }, {
        tasksGet: [task('completed', [userMsg('ours', MESSAGE_ID), agentMsg('ours-a', [text('Partial')], 'aborted')])]
      })
      const { result } = await run(fixture)
      expect(result.parts.map((p) => p.kind)).toEqual(['text', 'tool'])
      expect(result.taskState).toBe('aborted')
      expect(result.error).toMatchObject(CUT_OFF)
    })

    it('takes the server’s aborted row when it holds more than the stream', async () => {
      // Mutation: never let a cut-off server copy win → "Partial" stays.
      const fixture = recoveryFixture({ sse: [working, partial] }, {
        tasksGet: [task('completed', [userMsg('ours', MESSAGE_ID), agentMsg('ours-a', [text('Partial, and more'), tool], 'aborted')])]
      })
      const { result } = await run(fixture)
      expect(partTexts(result)).toEqual(['Partial, and more', 'Using tool: bash'])
      expect(result.taskState).toBe('aborted')
      expect(result.error).toMatchObject(CUT_OFF)
    })

    it('keeps the stream when a dropped turn’s aborted copy holds less, and ends cut off', async () => {
      // The task itself failed; the row says the reply was cut off. Mutation:
      // drop the richness check in `serverCopyWins` → "Part" replaces the stream.
      const fixture = recoveryFixture({ sse: [working, partial, toolFrame], hold: true }, {
        tasksGet: [task('failed', [userMsg('ours', MESSAGE_ID), agentMsg('ours-a', [text('Part')], 'aborted')])]
      })
      const agent = fakeA2aAgent(fixture)
      const repo = fakeSessionRepo()
      const result = await startTurn(fixture, agent, repo, {
        signal: new AbortController().signal,
        onEvent: (e) => { if (e.type === 'delta' && e.kind === 'tool') queueMicrotask(() => agent.drop()) }
      })
      expect(result.parts.map((p) => [p.kind, p.text])).toEqual([['text', 'Partial'], ['tool', 'Using tool: bash']])
      expect(result.taskState).toBe('aborted')
      expect(result.error).toMatchObject(CUT_OFF)
    })

    it('keeps the stream when a failed task’s still-streaming copy holds less', async () => {
      // Mutation: `isCutOff` back to `aborted`/`canceled` only → "Part"
      // replaces the stream.
      const fixture = recoveryFixture({ sse: [working, partial], hold: true }, {
        tasksGet: [task('failed', [userMsg('ours', MESSAGE_ID), agentMsg('ours-a', [text('Part')], 'streaming')])]
      })
      const { result } = await run(fixture, { dropAfterDelta: true })
      expect(partTexts(result)).toEqual(['Partial'])
      expect(result.taskState).toBe('failed')
      expect(result.error).toMatchObject({ code: 'agent_task_failed', raw: 'A2A task state: failed' })
    })

    it('takes a normally ended reply even when it is shorter than the stream', async () => {
      const fixture = recoveryFixture({ sse: [working, partial, toolFrame] }, {
        tasksGet: [task('completed', [userMsg('ours', MESSAGE_ID), agentMsg('ours-a', [text('Done')])])]
      })
      const { result } = await run(fixture)
      expect(partTexts(result)).toEqual(['Done'])
      expect(result.error).toBeUndefined()
    })
  })

  it('shows the still-running line once while it polls a dropped turn, and saves nothing of it', async () => {
    // Mutation: drop the notice in `onPoll` → no line while the turn waits.
    const fixture = recoveryFixture({ sse: [working, partial], hold: true }, {
      tasksGet: [
        task('working', [userMsg('ours', MESSAGE_ID)]),
        task('working', [userMsg('ours', MESSAGE_ID)]),
        finished('completed', [text('Done')])
      ]
    })
    const { result, events } = await run(fixture, { dropAfterDelta: true })
    const notices = events.filter((e) => e.type === 'delta' && e.kind === 'notice')
    expect(notices).toEqual([{ type: 'delta', kind: 'notice', text: 'Still running on the agent. The reply will appear here when it finishes.' }])
    expect(result.notices).toEqual([])
    expect(partTexts(result)).toEqual(['Done'])
  })

  describe('a poll the server refuses while a dropped turn is collected', () => {
    const unauthorized = { status: 401, statusText: 'Unauthorized' }
    const cinna = (fixture: A2aFixture): A2aFixture => ({ ...fixture, input: { ...fixture.input, isCinnaTokenAuth: true } })

    it('asks again through a client built with a freshly resolved token', async () => {
      // Mutation: drop `renewClient` in `collectFromServer` → the refusal
      // ends the collection and the stream's drop error stands.
      const fixture = cinna(recoveryFixture({ sse: [working, partial], hold: true }, {
        tasksGet: [task('working', [userMsg('ours', MESSAGE_ID)]), unauthorized, finished('completed', [text('Done later')])]
      }))
      const agent = fakeA2aAgent(fixture)
      sessions.current = fakeSessionRepo()
      vi.stubGlobal('fetch', agent.fetch)
      let tokens = 0
      const driver = a2aDriverFor(fixture, {}, { resolveAccessToken: async () => `tok-${++tokens}` })
      const result = await driver.run(OWNER, rowOf(fixture), {
        chatId: fixture.input.chatId,
        wireContent: fixture.input.wireContent,
        messageId: MESSAGE_ID,
        signal: new AbortController().signal,
        onEvent: (e) => { if (e.type === 'delta' && e.kind === 'text') queueMicrotask(() => agent.drop()) }
      })
      expect(result.error).toBeUndefined()
      expect(partTexts(result)).toEqual(['Done later'])
      expect(tokens).toBe(2)
      const gets = tasksGets(agent)
      expect(gets.map((r) => r.authorization)).toEqual(['Bearer tok-1', 'Bearer tok-1', 'Bearer tok-2'])
    })

    it('ends with the re-auth prompt when the renewed token needs a sign-in', async () => {
      // Mutation: return null for an `unauthorized` collection in
      // `collectFromServer` → "Agent connection closed unexpectedly", no code.
      class Reauth extends Error {}
      const fixture = cinna(recoveryFixture({ sse: [working, partial], hold: true }, {
        tasksGet: [task('working', [userMsg('ours', MESSAGE_ID)]), unauthorized, finished('completed', [text('never read')])]
      }))
      const agent = fakeA2aAgent(fixture)
      sessions.current = fakeSessionRepo()
      vi.stubGlobal('fetch', agent.fetch)
      let tokens = 0
      const driver = a2aDriverFor(fixture, {}, {
        resolveAccessToken: async () => {
          if (++tokens > 1) throw new Reauth('No Cinna tokens stored')
          return 'tok-1'
        },
        isReauthRequired: (err) => err instanceof Reauth
      })
      const result = await driver.run(OWNER, rowOf(fixture), {
        chatId: fixture.input.chatId,
        wireContent: fixture.input.wireContent,
        messageId: MESSAGE_ID,
        signal: new AbortController().signal,
        onEvent: (e) => { if (e.type === 'delta' && e.kind === 'text') queueMicrotask(() => agent.drop()) }
      })
      expect(tasksGets(agent)).toHaveLength(2)
      expect(partTexts(result)).toEqual(['Partial'])
      expect(result.error).toMatchObject({ message: CINNA_SESSION_EXPIRED_MESSAGE, code: CINNA_REAUTH_REQUIRED_CODE })
    })
  })

  it('reports a dropped stream as before when the backend cannot be collected from', async () => {
    const fixture = recoveryFixture({ sse: [working, partial], hold: true })
    const { result, agent } = await run(fixture, { dropAfterDelta: true })
    expect(tasksGets(agent)).toHaveLength(1)
    expect(partTexts(result)).toEqual(['Partial'])
    expect(result.error?.message).toBe('Agent connection closed unexpectedly (server disconnected mid-response).')
  })

  it('does not collect after a JSON-RPC error frame', async () => {
    const base = fixtureOf('stream_rpc_error')
    const fixture = { ...base, input: { ...base.input, messageId: MESSAGE_ID }, http: { ...base.http, tasksGet: [finished('completed', [text('x')])] } }
    const { result, agent } = await run(fixture)
    expect(tasksGets(agent)).toEqual([])
    expect(result.error).toBeDefined()
  })

  it('ends a turn a later message followed, while the task works on that one', async () => {
    const fixture = recoveryFixture({ sse: [working, partial] }, {
      tasksGet: [task('working', [
        userMsg('ours', MESSAGE_ID), agentMsg('ours-a', [text('Our answer')]),
        userMsg('later', 'later-row'), agentMsg('later-a', [text('Their answer')], 'streaming')
      ])]
    })
    // Mutation: skip later user messages and judge only the task → polls for
    // as long as the later turn runs (here, for ever).
    const outcome = await Promise.race([run(fixture), sleep(1_000).then(() => null)])
    expect(outcome).not.toBeNull()
    const { result, agent } = outcome!
    expect(tasksGets(agent)).toHaveLength(1)
    expect(result.error).toBeUndefined()
    expect(partTexts(result)).toEqual(['Our answer'])
    expect(result.taskState).toBe('completed')
  })

  it('reports a collected turn the agent marks aborted as failed, even under a completed task', async () => {
    const fixture = recoveryFixture({ sse: [working, partial] }, {
      tasksGet: [task('completed', [userMsg('ours', MESSAGE_ID), agentMsg('ours-a', [text('Cut short')], 'aborted')])]
    })
    const { result } = await run(fixture)
    expect(partTexts(result)).toEqual(['Cut short'])
    expect(result.taskState).toBe('aborted')
    expect(result.error).toMatchObject({
      code: 'reply_cut_off',
      message: 'The agent’s reply was cut off before it finished. Send your message again to retry.'
    })
  })

  it('asks the question an input-required task was collected with', async () => {
    const fixture = recoveryFixture({ sse: [working, partial] }, {
      tasksGet: [finished('input-required', [text('Which cluster?')])]
    })
    const { result, events } = await run(fixture)
    expect(result.error).toBeUndefined()
    expect(result.taskState).toBe('input-required')
    expect(events.slice(-2)).toEqual([
      { type: 'status', state: 'needs_input', taskId: 'task-r', contextId: 'ctx-r' },
      {
        type: 'needs_input',
        requestId: 'task-r',
        request: { kind: 'question', questions: [{ question: 'Which cluster?', multiSelect: false, options: [] }] },
        resume: 'next_message'
      }
    ])
  })

  it('stops polling promptly on Stop, and tells the agent to cancel', async () => {
    collectPollDelays.fastMs = 60_000
    collectPollDelays.slowMs = 60_000
    const fixture = recoveryFixture({ sse: [working, partial] }, {
      tasksGet: [task('working', [userMsg('ours', MESSAGE_ID)])]
    })
    const agent = fakeA2aAgent(fixture)
    const controller = new AbortController()
    const turn = startTurn(fixture, agent, fakeSessionRepo(), { signal: controller.signal, onEvent: () => {} })
    for (let i = 0; i < 200 && tasksGets(agent).length === 0; i++) await sleep(5)
    expect(tasksGets(agent)).toHaveLength(1)
    controller.abort()
    const outcome = await Promise.race([turn.then(() => 'settled' as const), sleep(200).then(() => 'still polling' as const)])
    expect(outcome).toBe('settled')
    const result = await turn
    expect(partTexts(result)).toEqual(['Partial'])
    expect(agent.requests.filter((r) => r.body?.method === 'tasks/cancel')).toHaveLength(1)
    expect(tasksGets(agent)).toHaveLength(1)
  })

  it.each([
    ['completed', false],
    ['canceled', false],
    ['working', true]
  ])('a tasks/cancel answered %s shows the unconfirmed-stop notice: %s', async (state, shown) => {
    const base = fixtureOf('canceled_midway')
    const fixture: A2aFixture = {
      ...base,
      http: { ...base.http, cancel: { result: { kind: 'task', id: 'task-cancel-1', contextId: 'ctx-cancel-1', status: { state } } } }
    }
    const agent = fakeA2aAgent(fixture)
    const controller = new AbortController()
    let emitted = 0
    const result = await startTurn(fixture, agent, fakeSessionRepo(), {
      signal: controller.signal,
      onEvent: () => { if (++emitted === 3) controller.abort() }
    })
    const notice = result.notices.some((n) => n.text.includes('stop was not confirmed'))
    expect(notice).toBe(shown)
  })

  it.each([
    ['canceled', false],
    // The same backend's `tasks/get` still reports the previous turn's
    // `completed` for a turn stopped before its output: not a confirmation.
    // Mutation: accept `isStopConfirmed` from the read → no notice.
    ['completed', true],
    ['working', true]
  ])('an empty tasks/cancel answer is confirmed by one tasks/get answering %s — notice shown: %s', async (state, shown) => {
    // An older Cinna backend answers the cancel with `{"result":{}}`.
    const base = fixtureOf('canceled_midway')
    const fixture: A2aFixture = {
      ...base,
      http: { ...base.http, cancel: { result: {} }, tasksGet: [{ result: { kind: 'task', id: 'task-cancel-1', contextId: 'ctx-cancel-1', status: { state } } }] }
    }
    const agent = fakeA2aAgent(fixture)
    const repo = fakeSessionRepo()
    const controller = new AbortController()
    let emitted = 0
    const result = await startTurn(fixture, agent, repo, {
      signal: controller.signal,
      onEvent: () => { if (++emitted === 3) controller.abort() }
    })
    expect(result.notices.some((n) => n.text.includes('stop was not confirmed'))).toBe(shown)
    expect(tasksGets(agent)).toHaveLength(1)
    expect(repo.upserts.at(-1)?.taskState).toBe(shown ? null : state)
  })
})
