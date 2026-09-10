/**
 * The driver contract — what every `AgentDriver` promises its callers,
 * asserted the same way for each implementation.
 *
 * Phase 0 of the agent runtime plan wrote this as the runner contract, over
 * `AgentTurnRunner.runTurn`. Phase 2 moved every subject up to the driver that
 * wraps the runner — a turn is now `driver.run(userId, row, input)`, which is
 * what production dispatches — kept every assertion and every known violation
 * exactly, and added three clauses about the driver itself: stable
 * capabilities, readiness that never throws, and an answer to nothing.
 *
 * The suite owns the assertions and the `pendingRequests` instrumentation. A
 * subject only says how to build a turn in each situation — so a driver cannot
 * pass by describing its own behaviour back to the suite.
 *
 * What is asserted, for every implementation:
 *
 * - `run` never rejects; every failure is `result.error` with a non-empty
 *   `message` and `raw`.
 * - The first `onEvent` is never `done` or `error`.
 * - After `signal.abort()` the promise settles and no further `onEvent`
 *   arrives (`abort.settles`), and the result carries `error` or a `canceled`
 *   task state (`abort.reports`).
 * - A parked ask (where the driver parks) is the turn's only registration in
 *   `pendingRequests` and is gone on every exit: answer, reject, abort, timeout.
 * - A parked ask is announced: exactly one `needs_input` for the registered id,
 *   `resume: 'reply'`, of the registration's kind, before any answer is posted
 *   (`park.needs_input`, phase 1).
 * - A parked ask settled while the turn is open says so once: exactly one
 *   `input_resolved`, after its `needs_input`, carrying the answer that was
 *   posted (`park.input_resolved`) — or `{kind: 'rejected'}` when it was
 *   rejected or timed out. An ask swept away by an abort gets none: the
 *   terminal event posted above the driver already says the park is gone.
 * - A session id the turn produces reaches `saveSession`, and the next turn on
 *   the same chat receives it through `readSession`.
 * - `capabilities(row)` is the same answer on every call and for every subject
 *   built for that row, and no caller can change the next answer by editing
 *   the one it was handed (`capabilities.stable`, phase 2).
 * - `readiness` resolves — never rejects, never throws — with a state this build
 *   knows and a sentence when it is not `ok`, whatever its dependencies do
 *   (`readiness.never_throws`, phase 2).
 * - `respond` to an ask nothing is waiting on answers `{delivered: false}` and
 *   writes no grant; where the driver parks, an ask already answered is one of
 *   those (`respond.unknown`, phase 2).
 */

import { afterEach, beforeEach, describe, expect, it, vi, type TestFunction } from 'vitest'
import { pendingRequests, type RequestResolution } from '../pendingRequests'
import type { RunEvent } from '../../../../shared/runEvents'
import type { AgentReadinessState } from '../../../../shared/agentDrivers'
import type { RunAgentTurnResult } from '../../a2aStreamingService'
import type { AgentDriver, AgentReadiness } from '../../../agents/drivers/driver'
import type { AgentRow } from '../../../db/agents'

/** The sink and signal the suite hands a turn. */
export interface TurnIO {
  onEvent: (event: RunEvent) => void
  signal: AbortSignal
}

export interface ContractTurn {
  /**
   * Start the turn with the suite's sink and signal. Calls the driver's `run`
   * exactly once and returns its promise untouched — no `catch`, or the
   * never-rejects assertion is testing the subject instead of the driver.
   */
  run(io: TurnIO): Promise<RunAgentTurnResult>
}

export interface HangingTurn extends ContractTurn {
  /**
   * Resolves once the driver is mid-turn — past its readiness checks and
   * waiting on the agent — so the abort lands inside the stream, not before it.
   */
  started(): Promise<void>
}

export interface ParkedTurn extends ContractTurn {
  /** What the suite posts through `pendingRequests.resolve` as the user's answer. */
  answer: RequestResolution
  /**
   * Whatever has to happen after the ask settles for the turn to end — the
   * engine's end-of-turn frame, the SDK generator's final `result`. Called once
   * the registry has let go of the request, on every exit except abort.
   */
  afterSettle?(): void | Promise<void>
}

export interface SessionPair {
  /** A turn on a chat with no remembered session. */
  first: ContractTurn
  /** A turn on the same chat, sharing `first`'s session store. */
  second: ContractTurn
  /** Session ids the driver handed to `saveSession`, in order. */
  saved(): string[]
  /** What `readSession` returned to the second turn; null if it was never read. */
  readBySecond(): string | null
}

/** A driver and a row it runs, for the clauses about the driver rather than a turn. */
export interface DriverUnderTest {
  driver: AgentDriver
  row: AgentRow
  /** How many *Always allow* rules the driver has asked its world to write so far. */
  grantsWritten(): number
}

export interface DriverContractSubject {
  /** A turn that ends normally. */
  completes(): ContractTurn
  /** Every failure scenario this driver has, by name. At least one. */
  failures(): Record<string, ContractTurn>
  /**
   * A turn that stays open until its signal aborts. Nothing on the far side
   * reacts to the abort: `abort.settles` judges the driver on its own.
   */
  hangs(): HangingTurn
  /**
   * The same hanging turn, with its far side ending the stream once the signal
   * aborts — what a server does after `tasks/cancel`. Only for a driver that
   * cannot end an aborted turn by itself, so that `abort.reports` can still see
   * what the result says. Never used by `abort.settles`.
   */
  hangsServerAssisted?(): HangingTurn
  /**
   * A turn that parks on an ask. Omit for drivers whose asks end the turn
   * instead (A2A `input-required`); the parked-ask cases are then skipped.
   */
  parks?(): ParkedTurn
  session(): SessionPair
  /** The driver and a row it runs. Fresh on every call: two calls are two subjects for one row. */
  underTest(): DriverUnderTest
  /**
   * Worlds whose dependencies fail — throw, reject with an `Error` or a
   * `TypeError`, never answer — by name. At least one.
   */
  readinessWorlds(): Record<string, DriverUnderTest>
}

const SETTLE_MS = 2_000
/** Long enough for a stray event loop turn to post something it should not. */
const QUIET_MS = 30

/** The user and chat the driver-level clauses speak as. */
const CONTRACT_USER = 'user-contract'
const CONTRACT_CHAT = 'chat-contract'

/** Every state readiness may answer — a `Record`, so a new state fails the typecheck here. */
const READINESS_STATES: Record<AgentReadinessState, true> = {
  ok: true,
  credentials_needed: true,
  invalid: true,
  contract_too_new: true,
  not_installed: true,
  not_logged_in: true,
  unreachable: true
}

/**
 * A wait that failed **before** the clause reached what it asserts — the turn
 * never started, the ask was never registered.
 *
 * Its own class so the known-violation wrapper can refuse it outright. A
 * recorded `by: 'timeout'` means "the aborted turn never settles", and a driver
 * that never reaches the agent at all must not satisfy that entry by timing out
 * one step earlier.
 */
class ContractSetupError extends Error {
  override name = 'ContractSetupError'
}

/** The suite's own timeouts on the turn under test, told apart from assertion failures. */
const TIMEOUT = /did not settle within|timed out waiting for/

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

interface WaitOptions {
  /** A precondition of the clause, not its subject: failing it is a {@link ContractSetupError}. */
  setup?: boolean
}

async function until(cond: () => boolean, what: string, { setup = false }: WaitOptions = {}): Promise<void> {
  const deadline = Date.now() + SETTLE_MS
  while (!cond()) {
    if (Date.now() > deadline) {
      const message = `timed out waiting for ${what}`
      throw setup ? new ContractSetupError(message) : new Error(message)
    }
    await sleep(5)
  }
}

/** Fail rather than hang when a driver never settles. */
async function settled<T>(promise: Promise<T>, what: string, { setup = false }: WaitOptions = {}): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      const message = `${what} did not settle within ${SETTLE_MS}ms`
      reject(setup ? new ContractSetupError(message) : new Error(message))
    }, SETTLE_MS)
  })
  try {
    return await Promise.race([promise, timeout])
  } finally {
    clearTimeout(timer)
  }
}

interface Driven {
  events: RunEvent[]
  controller: AbortController
  promise: Promise<RunAgentTurnResult>
}

function drive(turn: ContractTurn): Driven {
  const events: RunEvent[] = []
  const controller = new AbortController()
  const promise = turn.run({ onEvent: (e) => void events.push(e), signal: controller.signal })
  return { events, controller, promise }
}

function expectNotTerminalFirst(events: RunEvent[]): void {
  if (events.length === 0) return
  expect(['done', 'error']).not.toContain(events[0].type)
}

/** Every event of one variant, in the order it was posted. */
function ofType<T extends RunEvent['type']>(events: RunEvent[], type: T): Extract<RunEvent, { type: T }>[] {
  return events.filter((e): e is Extract<RunEvent, { type: T }> => e.type === type)
}

/**
 * The turn said its one ask was settled, once, with `resolution`.
 *
 * Every `input_resolved` the turn posted is counted, not only those for this
 * id: a `parks()` turn asks exactly once, so any other is a stray.
 */
function expectResolvedOnce(events: RunEvent[], requestId: string, resolution: RequestResolution): void {
  const resolved = ofType(events, 'input_resolved')
  expect(resolved.map((e) => e.requestId), 'input_resolved events this turn posted').toEqual([requestId])
  expect(resolved[0].resolution).toEqual(resolution)
}

export type ContractClause =
  | 'completes'
  | 'failures'
  | 'abort.settles'
  | 'abort.reports'
  | 'session'
  | 'park.answer'
  | 'park.needs_input'
  | 'park.input_resolved'
  | 'park.reject'
  | 'park.abort'
  | 'park.timeout'
  | 'capabilities.stable'
  | 'readiness.never_throws'
  | 'respond.unknown'

/**
 * A clause a driver breaks today: the reason, and — when it is not an ordinary
 * assertion — how it breaks. `by: 'timeout'` is a turn that never settles.
 */
export type KnownViolation = string | { reason: string; by: 'timeout' | 'assertion' }

export interface DriverContractOptions {
  /**
   * Clauses this driver breaks **today**. Phase 0 pins behaviour rather than
   * fixing it, so a real violation is recorded here instead of bent to pass.
   *
   * The clause then passes only if it fails **the way the entry says** — an
   * assertion unless `by: 'timeout'` — and fails outright once the driver keeps
   * it, so the entry has to be deleted by whoever fixed it. A failure while
   * setting the clause up (the turn never started, the ask never registered)
   * never matches an entry. Deliberately not `it.fails`, which passes on *any*
   * throw: a driver that started hanging on abort would have kept a
   * result-shape violation green.
   */
  knownViolations?: Partial<Record<ContractClause, KnownViolation>>
  /**
   * Failure scenarios that come back as a **success** today, by name, each with
   * the reason. Finer than `knownViolations.failures`, which would mark the
   * whole clause over one bad scenario and stop checking the rest. A name here
   * must exist in `failures()`.
   */
  knownFailureViolations?: Record<string, string>
}

export function describeDriverContract(
  name: string,
  makeSubject: () => DriverContractSubject,
  options: DriverContractOptions = {}
): void {
  const clause = (key: ContractClause, title: string, fn: TestFunction): void => {
    const known = options.knownViolations?.[key]
    if (!known) {
      it(title, fn)
      return
    }
    const { reason, by } =
      typeof known === 'string' ? { reason: known, by: 'assertion' as const } : known
    it(`${title} — known violation: ${reason}`, async (ctx) => {
      let failure: unknown
      try {
        await fn(ctx)
      } catch (err) {
        failure = err
      }
      if (failure === undefined) {
        throw new Error(
          `"${key}" now holds for ${name}: delete its knownViolations entry, and update the goldens the fix changed`
        )
      }
      if (failure instanceof ContractSetupError) throw failure
      const message = failure instanceof Error ? failure.message : String(failure)
      const cameAs = TIMEOUT.test(message) ? 'timeout' : 'assertion'
      if (cameAs !== by) {
        throw new Error(`"${key}" is recorded as failing by ${by}, but failed by ${cameAs}: ${message}`)
      }
    })
  }

  /**
   * Decided at collection, not inside each test: a `ctx.skip()` thrown inside a
   * known-violation wrapper would be caught and read as the violation.
   */
  const hasParks = typeof makeSubject().parks === 'function'

  describe(`driver contract: ${name}`, () => {
    /** Every `register` call this test made, in order. */
    let registered: { requestId: string; kind: 'permission' | 'question'; timeoutMs?: number }[]
    /** Set by a test to force the park timeout through the real timer path. */
    let forceTimeoutMs: number | undefined

    beforeEach(() => {
      registered = []
      forceTimeoutMs = undefined
      pendingRequests.clear()
      const original = pendingRequests.register.bind(pendingRequests)
      vi.spyOn(pendingRequests, 'register').mockImplementation((input) => {
        registered.push({ requestId: input.requestId, kind: input.kind, timeoutMs: input.timeoutMs })
        return original(forceTimeoutMs === undefined ? input : { ...input, timeoutMs: forceTimeoutMs })
      })
    })

    afterEach(() => {
      vi.restoreAllMocks()
      pendingRequests.clear()
    })

    clause('completes', 'never rejects on a turn that completes, and posts no terminal event first', async () => {
      const d = drive(makeSubject().completes())
      const result = await settled(d.promise, 'a completing turn')
      expect(result.error).toBeUndefined()
      expectNotTerminalFirst(d.events)
    })

    clause('failures', 'turns every failure into result.error with a message and raw detail', async () => {
      const failures = Object.entries(makeSubject().failures())
      expect(failures.length).toBeGreaterThan(0)
      const knownSuccesses = options.knownFailureViolations ?? {}
      for (const name of Object.keys(knownSuccesses)) {
        expect(failures.map(([scenario]) => scenario), 'a known violation names no failure').toContain(name)
      }
      for (const [scenario, turn] of failures) {
        const d = drive(turn)
        const result = await settled(d.promise, `failure "${scenario}"`)
        const known = knownSuccesses[scenario]
        if (known) {
          // Pinned the other way round: this failure comes back as a success
          // today. Once it carries `error`, this line fails and the entry goes.
          expect(result.error, `${scenario} — known violation: ${known}`).toBeUndefined()
          continue
        }
        expect(result.error, scenario).toBeDefined()
        expect(result.error?.message, scenario).toEqual(expect.any(String))
        expect(result.error?.message.length, scenario).toBeGreaterThan(0)
        expect(result.error?.raw, scenario).toEqual(expect.any(String))
        expect(result.error?.raw.length, scenario).toBeGreaterThan(0)
        expectNotTerminalFirst(d.events)
      }
    })

    clause('abort.settles', 'settles on abort by itself, and goes quiet', async () => {
      const turn = makeSubject().hangs()
      const d = drive(turn)
      await settled(turn.started(), 'the hanging turn starting', { setup: true })
      d.controller.abort()
      await settled(d.promise, 'an aborted turn')
      const count = d.events.length
      await sleep(QUIET_MS)
      expect(d.events.length, 'events posted after the aborted turn settled').toBe(count)
    })

    clause('abort.reports', 'reports the cancellation in its result', async () => {
      const subject = makeSubject()
      const turn = subject.hangsServerAssisted?.() ?? subject.hangs()
      const d = drive(turn)
      await settled(turn.started(), 'the hanging turn starting', { setup: true })
      d.controller.abort()
      const result = await settled(d.promise, 'an aborted turn')
      expect(
        result.error !== undefined || result.taskState === 'canceled',
        'an aborted turn reported neither error nor canceled'
      ).toBe(true)
    })

    clause('session', 'hands the turn’s session to saveSession and back through readSession', async () => {
      const pair = makeSubject().session()
      const first = await settled(drive(pair.first).promise, 'the first session turn')
      expect(first.error).toBeUndefined()
      expect(first.contextId).toEqual(expect.any(String))
      expect(pair.saved()).toContain(first.contextId)
      const second = await settled(drive(pair.second).promise, 'the second session turn')
      expect(second.error).toBeUndefined()
      expect(pair.readBySecond()).toBe(first.contextId)
    })

    clause(
      'capabilities.stable',
      'answers the same capabilities for the same row, and hands out none a caller can change',
      async () => {
        const a = makeSubject().underTest()
        const b = makeSubject().underTest()
        expect(a.driver.id, 'the driver the row names').toBe(a.row.driver)

        const first = a.driver.capabilities(a.row)
        const snapshot = structuredClone(first)
        expect(a.driver.capabilities(a.row), 'a second call for the same row').toEqual(snapshot)
        expect(b.driver.capabilities(b.row), 'a second subject for the same row').toEqual(snapshot)

        // A caller that edits what it was handed must not change the next
        // answer — the composer and the send path both read these, and a
        // shared object edited by one would put them into disagreement.
        try {
          const edited = first as unknown as {
            streaming: boolean
            attachments: string
            input: { permission: boolean }
          }
          edited.streaming = !edited.streaming
          edited.attachments = 'edited by a caller'
          edited.input.permission = !edited.input.permission
        } catch {
          // A frozen answer refuses the edit, which is the other way to keep this.
        }
        expect(a.driver.capabilities(a.row), 'capabilities after a caller edited an earlier answer').toEqual(
          snapshot
        )
      }
    )

    clause(
      'readiness.never_throws',
      'resolves readiness with a known state and a reason, whatever its dependencies do',
      async () => {
        const worlds = Object.entries(makeSubject().readinessWorlds())
        expect(worlds.length).toBeGreaterThan(0)
        for (const [world, { driver, row }] of worlds) {
          // Through a promise executor, so a synchronous throw is a rejection
          // here rather than an exception that escapes the clause unlabelled.
          const readiness = await settled(
            new Promise<AgentReadiness | null>((resolve) =>
              resolve(driver.readiness(CONTRACT_USER, row))
            ).catch((err: unknown) => {
              throw new Error(
                `readiness rejected in "${world}": ${err instanceof Error ? err.message : String(err)}`
              )
            }),
            `readiness in "${world}"`
          )
          // Null is an answer: the driver could not tell (a check that timed
          // out), which refuses nothing. It is not a throw in disguise.
          if (readiness === null) continue
          expect(Object.keys(READINESS_STATES), `the state readiness answered in "${world}"`).toContain(
            readiness.state
          )
          if (readiness.state === 'ok') {
            expect(readiness.reason, world).toBeNull()
          } else {
            expect(readiness.reason, world).toEqual(expect.any(String))
            expect(readiness.reason?.length, world).toBeGreaterThan(0)
          }
        }
      }
    )

    clause('respond.unknown', 'answers an ask nothing is waiting on with delivered: false, and writes no grant', async () => {
      const { driver, row, grantsWritten } = makeSubject().underTest()
      const nobody = {
        requestId: 'per_contract_nobody',
        chatId: CONTRACT_CHAT,
        agentId: row.id,
        kind: 'permission' as const
      }
      expect(driver.respond(nobody, { kind: 'permission', reply: 'once' })).toEqual({ delivered: false })
      expect(grantsWritten(), 'grants written for an ask nothing was waiting on').toBe(0)
      if (!hasParks) return

      // An ask that was waiting and has been answered is nothing waiting any
      // more: a second answer — a double click, a stale block — lands nowhere.
      const answered = { ...nobody, requestId: 'per_contract_answered' }
      pendingRequests.register({
        requestId: answered.requestId,
        chatId: answered.chatId,
        agentId: answered.agentId,
        kind: answered.kind
      })
      expect(driver.respond(answered, { kind: 'permission', reply: 'once' })).toEqual({ delivered: true })
      expect(driver.respond(answered, { kind: 'permission', reply: 'once' })).toEqual({ delivered: false })
      expect(grantsWritten(), 'grants written for a once answer').toBe(0)
    })

    ;(hasParks ? describe : describe.skip)('a parked ask', () => {
      /** Drive a parking turn up to the point its ask is registered. */
      async function park(): Promise<{ turn: ParkedTurn; d: Driven; requestId: string }> {
        const turn = makeSubject().parks?.()
        if (!turn) throw new ContractSetupError('the subject stopped offering parks()')
        const d = drive(turn)
        await until(() => registered.length > 0, 'the ask to be registered', { setup: true })
        return { turn, d, requestId: registered[0].requestId }
      }

      function expectReleased(requestId: string, chatIdOf: string | null): void {
        // Every `parks()` turn asks exactly once, so any second registration —
        // under the same id or a freshly minted one — is a duplicated ask.
        expect(registered.map((r) => r.requestId), 'registrations this turn made').toEqual([requestId])
        expect(pendingRequests.owner(requestId)).toBeNull()
        if (chatIdOf) expect(pendingRequests.listForChat(chatIdOf)).toEqual([])
      }

      clause('park.answer', 'is registered once and released when answered', async () => {
        const p = await park()
        const owner = pendingRequests.owner(p.requestId)
        expect(owner).not.toBeNull()
        expect(pendingRequests.resolve(p.requestId, p.turn.answer)).not.toBeNull()
        await p.turn.afterSettle?.()
        const result = await settled(p.d.promise, 'an answered turn')
        expect(result).toBeDefined()
        expectReleased(p.requestId, owner?.chatId ?? null)
        expectNotTerminalFirst(p.d.events)
      })

      clause('park.needs_input', 'a parked ask emits needs_input before the run goes quiet', async () => {
        const p = await park()
        const { kind } = registered[0]
        await until(() => ofType(p.d.events, 'needs_input').length > 0, 'needs_input for the parked ask')
        // Checked before anything is answered: a block the renderer is told is
        // answerable only once it has been answered is one nobody could answer.
        const asked = ofType(p.d.events, 'needs_input')
        expect(asked.map((e) => e.requestId), 'needs_input events before the answer').toEqual([p.requestId])
        expect(asked[0].resume).toBe('reply')
        expect(asked[0].request.kind).toBe(kind)

        expect(pendingRequests.resolve(p.requestId, p.turn.answer)).not.toBeNull()
        await p.turn.afterSettle?.()
        await settled(p.d.promise, 'an answered turn')
        // And not again on the way out — an answer is not a second ask.
        expect(ofType(p.d.events, 'needs_input').map((e) => e.requestId), 'needs_input events').toEqual([
          p.requestId
        ])
      })

      clause('park.input_resolved', 'answering emits input_resolved', async () => {
        const p = await park()
        expect(pendingRequests.resolve(p.requestId, p.turn.answer)).not.toBeNull()
        await p.turn.afterSettle?.()
        await settled(p.d.promise, 'an answered turn')
        // Once, although a driver may hear of the same answer twice — its own
        // and the engine's echo of it.
        expectResolvedOnce(p.d.events, p.requestId, p.turn.answer)
        const asked = p.d.events.findIndex((e) => e.type === 'needs_input' && e.requestId === p.requestId)
        const resolved = p.d.events.findIndex((e) => e.type === 'input_resolved' && e.requestId === p.requestId)
        expect(asked, 'needs_input for the answered ask').toBeGreaterThanOrEqual(0)
        expect(resolved, 'input_resolved after its needs_input').toBeGreaterThan(asked)
      })

      clause('park.reject', 'is registered once and released when rejected', async () => {
        const p = await park()
        const owner = pendingRequests.owner(p.requestId)
        expect(pendingRequests.resolve(p.requestId, { kind: 'rejected' })).not.toBeNull()
        await p.turn.afterSettle?.()
        await settled(p.d.promise, 'a rejected turn')
        expectReleased(p.requestId, owner?.chatId ?? null)
        expectResolvedOnce(p.d.events, p.requestId, { kind: 'rejected' })
      })

      clause('park.abort', 'is registered once, released, and quiet when the turn is aborted', async () => {
        const p = await park()
        const owner = pendingRequests.owner(p.requestId)
        p.d.controller.abort()
        await settled(p.d.promise, 'an aborted parked turn')
        // The quiet rule holds here too, and this is where it is easiest to
        // break: releasing the ask on the way out settles a callback that may
        // still want to write "no answer" into the transcript.
        const count = p.d.events.length
        await sleep(QUIET_MS)
        expect(p.d.events.length, 'events posted after the aborted turn settled').toBe(count)
        expectReleased(p.requestId, owner?.chatId ?? null)
        // Released, but not resolved: nobody answered, and the turn's own end
        // is what the renderer hears about.
        expect(ofType(p.d.events, 'input_resolved'), 'input_resolved for an ask the abort swept away').toEqual([])
      })

      clause('park.timeout', 'is registered once and released when the park times out', async () => {
        // Through the registry's own timer, shortened: the timeout override is
        // the test-only knob `register` exposes, so this runs the real expiry
        // path rather than a `resolve(..., rejected)` that looks like one.
        forceTimeoutMs = 20
        const p = await park()
        const owner = pendingRequests.owner(p.requestId)
        await until(() => pendingRequests.owner(p.requestId) === null, 'the park to time out')
        await p.turn.afterSettle?.()
        await settled(p.d.promise, 'a timed-out parked turn')
        expectReleased(p.requestId, owner?.chatId ?? null)
        // An expiry is settled while the turn is still open, so it is reported
        // — as the rejection the registry settled it with.
        expectResolvedOnce(p.d.events, p.requestId, { kind: 'rejected' })
      })
    })
  })
}
