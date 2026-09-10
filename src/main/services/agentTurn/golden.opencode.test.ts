/**
 * Golden streams and the driver contract for the `opencode` driver over the
 * OpenCode runner.
 *
 * ## Through the driver (phase 2)
 *
 * Every scenario and every contract turn goes through `createOpencodeDriver`
 * over the same runner, as production's does — see "Through the driver" in
 * `__golden__/opencode/goldenEngine.ts`. The expectations are the ones phase 0
 * pinned, byte for byte: around an OpenCode turn the driver adds only the
 * reconcile against the folder, and a golden cannot see that.
 *
 * Phase 0 of the agent runtime plan
 * (`drafts/agent_runtime/phase_0_characterization.md`). What
 * this file pins is **what `LocalAgentTurnRunner` does today**, not what it
 * should do: every scenario under `__golden__/opencode/` is replayed through the
 * real bus, stream, accumulator, registry and lock, and the whole output is
 * compared against files a person reviewed. Where today's behaviour looked
 * wrong it is still pinned, with the reason in the expectation's `_notes`.
 *
 * ## Three things are compared per scenario, in two files
 *
 * - `<scenario>.expected.json` — every `onEvent` call in order and the returned
 *   `RunAgentTurnResult`, through the shared `expectGolden`. Phase 1 rewrites
 *   these into the new vocabulary.
 * - `<scenario>.effects.expected.json` — the HTTP calls the runner made, what
 *   it registered with `pendingRequests`, what it handed to `saveSession`, and
 *   what it left behind. For this runner **the replies are the behaviour**: an
 *   allow is a `POST …/reply`, a stop is `/interrupt` plus a reject, and none of
 *   it reaches `onEvent`. See `__golden__/opencode/goldenEngine.ts` for why this
 *   is a sibling file rather than a field on the golden capture.
 *
 * ## Where the plan's event list was wrong for this runner
 *
 * The plan names `message.part.updated` and `session.idle`. Neither is in these
 * fixtures, deliberately. The runner consumes the v2 `session.next.*` family
 * (`engineEvents.ts`), and **`session.idle` is never emitted by 1.18.27** — a
 * turn ends on `session.next.step.ended` with a terminal `finish`. A fixture
 * ending on `session.idle` would pass here and describe a turn production never
 * sees, which is how the inline fakes were once confidently wrong.
 *
 * ## No generated ids to normalise
 *
 * The runner mints no id and stamps no time into what it emits or returns:
 * `ses_*`, `per_*`, `que_*` and `msg_*` all come from the fixture. So
 * `normalise` gets no id patterns, and a placeholder appearing in an
 * expectation would itself be a change worth reading.
 */
import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const logged: string[] = []
vi.mock('../../logger/logger', () => ({
  createLogger: () => ({
    debug: (m: string) => logged.push(m),
    info: (m: string) => logged.push(m),
    warn: (m: string) => logged.push(m),
    error: (m: string) => logged.push(m)
  })
}))

import { pendingRequests } from './pendingRequests'
import { turnLock } from '../localAgents/turnLock'
import { expectGolden, readFixture, type NormaliseOptions } from './__golden__/harness'
import {
  describeDriverContract,
  type ContractTurn,
  type DriverContractSubject,
  type DriverUnderTest
} from './__golden__/driverContract'
import { createOpencodeDriver } from '../../agents/drivers/opencodeDriver'
import type { FolderDriverDeps } from '../../agents/drivers/folderDriver'
import {
  admitted,
  buildWorld,
  expectEffects,
  runFixture,
  waitFor,
  type EngineFrame,
  type OpenCodeFixture,
  type World
} from './__golden__/opencode/goldenEngine'

const SCENARIOS = [
  'plain_text',
  'tool_roundtrip',
  'permission_ask_then_allow',
  'permission_ask_covered_by_grant',
  'question_then_answer',
  'park_timeout',
  'engine_restart_midturn',
  'session_error',
  'prompt_rejected',
  'resume_remembered_session',
  'remembered_session_gone',
  'cold_engine_becomes_ready',
  'cold_engine_agent_not_loaded',
  'stream_drop_healed',
  'abort_with_parked_question'
] as const

/** Nothing generated to replace — see the header. */
const NORMALISE: NormaliseOptions = {}

const FIXTURE_DIR = join(dirname(fileURLToPath(import.meta.url)), '__golden__', 'opencode')

// Module-level state both describes share: a lock or a parked ask leaking out
// of one test must not decide the next one.
beforeEach(() => {
  logged.length = 0
  pendingRequests.clear()
  turnLock.releaseAll()
})

afterEach(() => {
  pendingRequests.clear()
  turnLock.releaseAll()
})

describe('golden stream: opencode', () => {
  for (const scenario of SCENARIOS) {
    it(scenario, async () => {
      const fixture = readFixture<OpenCodeFixture>('opencode', scenario)
      const { events, result, effects } = await runFixture(fixture)

      // Both are checked before either failure is thrown, so a first
      // `GOLDEN_WRITE=1` run writes both files instead of stopping at one.
      const failures: unknown[] = []
      for (const check of [
        () => expectGolden('opencode', scenario, { events, result }, NORMALISE),
        () => expectEffects(scenario, effects)
      ]) {
        try {
          check()
        } catch (err) {
          failures.push(err)
        }
      }
      if (failures.length > 0) throw failures[0]
    })
  }

  it('runs every fixture on disk, and every fixture says where it came from', () => {
    // A fixture with no `it` is a scenario everybody believes is pinned. This
    // is the check that stops one being added to the folder and not the list.
    const onDisk = readdirSync(FIXTURE_DIR)
      .filter((f) => f.endsWith('.fixture.json'))
      .map((f) => f.slice(0, -'.fixture.json'.length))
      .sort()
    expect(onDisk).toEqual([...SCENARIOS].sort())

    for (const scenario of onDisk) {
      const fixture = JSON.parse(
        readFileSync(join(FIXTURE_DIR, `${scenario}.fixture.json`), 'utf8')
      ) as OpenCodeFixture
      expect(fixture.recorded_from, scenario).toEqual(expect.any(String))
      if (fixture.recorded_from === 'hand-written') {
        expect(fixture.source, `${scenario} is hand-written and names no source`).toBeDefined()
      }
    }
  })
})

// ---------------------------------------------------------------------------
// The contract. Built in code rather than from fixtures: a contract subject
// says *how to reach a situation*, and the suite owns every assertion about it.
// ---------------------------------------------------------------------------

const SES = 'ses_new'

const frame = (type: string, data: Record<string, unknown>): EngineFrame => ({ type, data })

const textDelta = (sessionID: string, delta: string): EngineFrame =>
  frame('session.next.text.delta', { sessionID, assistantMessageID: 'msg_1', textID: 't1', delta })

/** How a turn really ends on 1.18.27 — never `session.idle`. */
const stepEnded = (sessionID: string): EngineFrame =>
  frame('session.next.step.ended', {
    sessionID,
    assistantMessageID: 'msg_1',
    finish: 'stop',
    cost: 0,
    tokens: { input: 1, output: 1, reasoning: 0, cache: { read: 0, write: 0 } }
  })

/**
 * A turn on `world`, with the engine's side of it scripted.
 *
 * `run` returns the driver's `run` promise untouched, as the contract requires.
 * The script runs beside it; if it cannot reach its point (the driver failed
 * earlier than the script expected) it gives up quietly and the suite's own
 * assertion reports what actually happened.
 */
function contractTurn(
  world: World,
  script?: (world: World, promptsBefore: number) => Promise<void>
): ContractTurn {
  return {
    run(io) {
      const before = world.promptCount()
      const promise = world.driver.run('settings-user', world.row, world.runInput(io))
      if (script) {
        void script(world, before).catch((err) => logged.push(`contract script: ${String(err)}`))
      }
      return promise
    }
  }
}

function makeSubject(): DriverContractSubject {
  return {
    completes: () =>
      contractTurn(buildWorld(), async (w, before) => {
        await admitted(w, before)
        w.push(textDelta(SES, 'Done.'))
        w.push(stepEnded(SES))
      }),

    failures: () => ({
      engine_not_running: contractTurn(
        buildWorld({ engineStatus: 'failed', engineError: 'opencode serve exited with code 1' })
      ),
      agent_folder_missing: contractTurn(buildWorld({ agent: null })),
      session_error: contractTurn(buildWorld(), async (w, before) => {
        await admitted(w, before)
        w.push(textDelta(SES, 'part'))
        w.push(
          frame('session.error', {
            sessionID: SES,
            error: { name: 'APIError', data: { message: '429' } }
          })
        )
      }),
      prompt_rejected: contractTurn(
        buildWorld({
          routes: { 'POST /api/session/ses_new/prompt': { status: 500, body: 'nope' } }
        })
      ),
      engine_stopped_midturn: contractTurn(buildWorld(), async (w, before) => {
        await admitted(w, before)
        w.bus.shutdown()
      })
    }),

    hangs: () => {
      const w = buildWorld()
      let before = 0
      let seen = 0
      return {
        run(io) {
          before = w.promptCount()
          return w.driver.run(
            'settings-user',
            w.row,
            w.runInput({
              signal: io.signal,
              onEvent: (event) => {
                seen += 1
                io.onEvent(event)
              }
            })
          )
        },
        // Past the prompt, and a delta has come back through the live
        // subscription — so the abort lands while the runner is reading the
        // stream, not during readiness or session setup.
        async started() {
          await admitted(w, before)
          w.push(textDelta(SES, 'Working'))
          await waitFor(() => seen > 0, 'the first delta to arrive')
        }
      }
    },

    parks: () => {
      const w = buildWorld()
      const requestId = 'per_contract'
      const replyPath = `/api/session/${SES}/permission/${requestId}/reply`
      const turn = contractTurn(w, async (world, before) => {
        await admitted(world, before)
        world.push(
          frame('permission.v2.asked', {
            sessionID: SES,
            id: requestId,
            action: 'bash',
            resources: ['ls'],
            source: { type: 'tool', messageID: 'msg_1', callID: 'c1' }
          })
        )
      })
      return {
        run: turn.run,
        answer: { kind: 'permission', reply: 'once' },
        // The engine ends the turn only once our reply reached it — so wait for
        // the POST, echo what it said the way the engine does, then end.
        async afterSettle() {
          await waitFor(() => w.calls.some((c) => c.path === replyPath), 'the reply to be posted')
          const posted = w.calls.find((c) => c.path === replyPath)?.body as { reply?: string }
          w.push(
            frame('permission.v2.replied', { sessionID: SES, requestID: requestId, reply: posted?.reply })
          )
          w.push(stepEnded(SES))
        }
      }
    },

    underTest: () => {
      const w = buildWorld()
      return { driver: w.driver, row: w.row, grantsWritten: () => w.grants.length }
    },

    readinessWorlds: () => {
      // The folder read is this driver's only readiness dependency. It
      // promises not to throw; these break that promise and the others it has.
      const world = (readFolder: FolderDriverDeps['readFolder']): DriverUnderTest => {
        const w = buildWorld()
        return {
          driver: createOpencodeDriver({
            runner: w.runner,
            readFolder,
            rememberGrant: () => false,
            resolveRequest: () => false
          }),
          row: w.row,
          grantsWritten: () => 0
        }
      }
      return {
        'the folder read throws': world(() => {
          throw new Error('EACCES: permission denied')
        }),
        'the folder read throws a TypeError': world(() => {
          throw new TypeError("Cannot read properties of undefined (reading 'runtime')")
        }),
        'the folder is gone': world(() => null),
        'the folder reports a readiness this build does not know': world(() => ({
          name: 'Helper',
          enabled: true,
          readiness: 'from_a_newer_build',
          readinessReason: null,
          runtime: { engine: 'opencode' }
        }))
      }
    },

    session: () => {
      const sessionId = 'ses_contract'
      let phase: 'first' | 'second' = 'first'
      const readBySecond: (string | null)[] = []
      // One world for both turns: one engine, one bus, one session store —
      // the shape production has, where every folder agent shares all three.
      const w = buildWorld(
        { sessionId },
        { onRead: (value) => void (phase === 'second' && readBySecond.push(value)) }
      )
      const endsNormally = async (world: World, before: number): Promise<void> => {
        await admitted(world, before)
        world.push(stepEnded(sessionId))
      }
      const first = contractTurn(w, endsNormally)
      const second = contractTurn(w, endsNormally)
      return {
        first: {
          run(io) {
            phase = 'first'
            return first.run(io)
          }
        },
        second: {
          run(io) {
            phase = 'second'
            return second.run(io)
          }
        },
        saved: () => w.saved.map((s) => s.sessionId),
        readBySecond: () => (readBySecond.length > 0 ? readBySecond[0] : null)
      }
    }
  }
}

describeDriverContract('opencode', makeSubject, {
  knownViolations: {
    // Evidence: `abort_with_parked_question.expected.json`. `stream()` returns
    // the parts with no `error` and no `taskState` on an aborted outcome, and
    // the readiness-abort path returns an empty success, on purpose: a stop
    // is not treated as an error anywhere in this runner.
    'abort.reports': 'an aborted turn returns a plain success result, with no error and no canceled taskState'
  }
})
