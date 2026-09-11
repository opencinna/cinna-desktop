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
 * real over real bytes. Replaced: `a2aSessionRepo` (in memory, with the real
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
 * | Skip `a2aSessionRepo.upsert` on the success path | 15 effects expectations and the contract's `session` clause — **no** `{ events, result }` golden, which is why effects are pinned separately |
 * | (phase 2, `a2aDriver.ts`) `respond` answers `delivered: true` | the contract's `respond.unknown` |
 * | (phase 2, `a2aDriver.ts`) readiness rethrows a card-fetch failure | the contract's `readiness.never_throws` |
 * | (phase 2, `capabilities.ts`) every row of a driver shares one capabilities object | the contract's `capabilities.stable` on all three drivers, and `auth_required_401` — the re-auth flag read the object that clause had edited |
 *
 * Phase 6 connects cancellation to HTTP, including silent streams. Both abort
 * contract clauses now pass without a server response; stopped turns preserve
 * streamed parts and do not advance the saved session checkpoint.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { FakeSessionRepo, SessionPatch } from './__golden__/a2a/fakeAgent'

const sessions = vi.hoisted(() => ({ current: undefined as FakeSessionRepo | undefined }))

vi.mock('../../logger/logger', () => ({
  createLogger: () => ({ debug: () => {}, info: () => {}, warn: () => {}, error: () => {} })
}))
vi.mock('../../db/agents', () => ({
  a2aSessionRepo: {
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
vi.mock('../jobService', () => ({ jobService: {} }))

import { runAgentTurn, type RunAgentTurnResult } from '../a2aStreamingService'
import { fetchAgentCard } from '../../agents/a2a-client'
import { createA2aDriver, type A2aDriverDeps } from '../../agents/drivers/a2aDriver'
import type { AgentDriver } from '../../agents/drivers/driver'
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
  it('settles on Stop while the server stays silent and leaves the saved session untouched', async () => {
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
    expect(repo.upserts).toEqual([])
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
      // Failures to the user that come back without `result.error` today —
      // listed so the contract knows about them, and pinned as successes in
      // `knownFailureViolations` below until they carry an error.
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

describeDriverContract('a2a', makeSubject, {
  knownFailureViolations: {
    task_failed:
      'a task that ends `failed` returns success; its reason merges into the answer text and the job is reported succeeded',
    nonstreaming_rpc_error:
      'the SDK returns a message/send JSON-RPC error as a value, so the turn is an empty success and the job is reported succeeded'
  }
})
