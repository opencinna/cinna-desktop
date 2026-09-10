import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ClaudeAgentTurnRunner, type ClaudeTurnDeps } from './claudeAgentTurnRunner'
import { pendingRequests } from './pendingRequests'
import { expectGolden, listScenarios, readFixture, type NormaliseOptions } from './__golden__/harness'
import {
  describeRunnerContract,
  type ContractTurn,
  type RunnerContractSubject,
  type TurnIO
} from './__golden__/runnerContract'
import {
  expectBoundaryGolden,
  fixtureDeps,
  playFixture,
  scriptedQuery,
  type ClaudeFixture,
  type ScriptHooks,
  type ScriptStep
} from './__golden__/claude/script'

vi.mock('../../logger/logger', () => ({
  createLogger: () => ({ debug: () => {}, info: () => {}, warn: () => {}, error: () => {} })
}))

/**
 * Golden streams and the runner contract for `ClaudeAgentTurnRunner` — phase 0
 * of the agent runtime plan (`drafts/agent_runtime/
 * phase_0_characterization.md`).
 *
 * **These pin what the runner does today, not what it should do.** A surprise
 * in an expectation file is recorded in its `_notes` and left as it is; the
 * fix is a separate change that edits the file on purpose.
 *
 * Each scenario is a fixture under `__golden__/claude/` played by
 * `__golden__/claude/script.ts`, which also explains what the stub SDK does and
 * why. Two expectation files per scenario:
 *
 * - `<scenario>.expected.json` — every `onEvent` call and the returned result,
 *   through the shared `expectGolden`.
 * - `<scenario>.boundary.expected.json` — what crossed the other way: the
 *   options and prompt each `query()` received, **what `canUseTool` returned
 *   to the SDK**, whether stdin was open where the script looked, and what
 *   reached `saveSession`. The shared capture has no room for these, and for
 *   an ask the returned decision *is* the behaviour — the transcript only
 *   describes it.
 */

const SCENARIOS = [
  'plain_text',
  'tool_roundtrip',
  'ask_callback_allow',
  'ask_callback_always_remembered',
  'ask_callback_denied',
  'ask_park_expired',
  'ask_covered_by_grant',
  'ask_aborted_while_parked',
  'subagent_transcript',
  'stream_closed_stdin',
  'canceled_midway',
  'resume_forgotten_session',
  'not_logged_in_thrown',
  'logged_out_refused',
  'error_result_yielded',
  'approval_auto_cli_decides',
  'approval_auto_fallback'
] as const

it('runs every claude fixture on disk', () => {
  expect([...SCENARIOS].sort()).toEqual(listScenarios('claude'))
})

/** The only id this runner mints: `mintPermissionRequestId`'s `per_claude_<time>_<n>`. */
const NORMALISE: NormaliseOptions = {
  ids: [{ label: 'permission-request', pattern: /per_claude_[0-9a-z]+_[0-9a-z]+/ }]
}

describe('golden stream: claude', () => {
  beforeEach(() => pendingRequests.clear())
  afterEach(() => pendingRequests.clear())

  for (const scenario of SCENARIOS) {
    it(scenario, async () => {
      const played = await playFixture(readFixture<ClaudeFixture>('claude', scenario))
      expect(played.problems).toEqual([])
      // Both comparisons run before either failure is thrown, so a first
      // `GOLDEN_WRITE=1` run writes both files rather than stopping at one.
      let streamFailure: unknown
      try {
        expectGolden('claude', scenario, { events: played.events, result: played.result }, NORMALISE)
      } catch (err) {
        streamFailure = err
      }
      expectBoundaryGolden(scenario, played.boundary, NORMALISE)
      if (streamFailure) throw streamFailure
      // Every exit lets the prompt iterable finish, or the child never exits.
      for (const q of played.boundary.queries) expect(q.stdinClosedAfterTurn).toBe(true)
    })
  }
})

/**
 * The contract subject. Fresh fakes on every call — the suite calls
 * `makeSubject()` once per clause — and every turn is played by the same
 * interpreter as the golden scenarios, so the contract and the goldens drive
 * one stub SDK rather than two that could disagree.
 */
const CONTRACT_CHAT = 'chat-contract'
const init = (sessionId = 'sess-contract'): unknown => ({
  type: 'system',
  subtype: 'init',
  session_id: sessionId,
  apiKeySource: 'none',
  model: 'claude-opus-5',
  claude_code_version: '2.1.266',
  permissionMode: 'default'
})
const result = (sessionId = 'sess-contract'): unknown => ({
  type: 'result',
  subtype: 'success',
  is_error: false,
  result: 'ok',
  session_id: sessionId
})

function contractTurn(
  scripts: ScriptStep[][],
  over: Partial<ClaudeTurnDeps> = {},
  hooks: Omit<ScriptHooks, 'chatId'> = {}
): ContractTurn {
  return {
    run(io: TurnIO) {
      const scripted = scriptedQuery(scripts, { chatId: CONTRACT_CHAT, ...hooks })
      return new ClaudeAgentTurnRunner(fixtureDeps({ approval: 'ask' }, scripted.query, over)).runTurn({
        chatId: CONTRACT_CHAT,
        agentId: 'folder:contract',
        agentName: 'Invoices',
        wireContent: 'hello',
        signal: io.signal,
        onEvent: io.onEvent
      })
    }
  }
}

function makeSubject(): RunnerContractSubject {
  return {
    completes: () => contractTurn(readFixture<ClaudeFixture>('claude', 'plain_text').queries),

    failures: () => ({
      no_claude_on_path: contractTurn([[{ yield: init() }, { yield: result() }]], {
        claudePath: async () => null
      }),
      logged_out: contractTurn([[{ yield: init() }, { yield: result() }]], {
        claudeAuth: async () => ({ state: 'logged_out', authMethod: 'none', subscriptionType: null, email: null })
      }),
      query_throws_midstream: contractTurn([
        [
          { yield: init() },
          { yield: { type: 'stream_event', event: { type: 'message_start', message: { id: 'msg_1' } } } },
          { yield: { type: 'stream_event', event: { type: 'content_block_start', index: 0, content_block: { type: 'text' } } } },
          { yield: { type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'half' } } } },
          { throw: { message: 'the connection dropped' } }
        ]
      ]),
      agent_missing: contractTurn([], { getAgent: () => null }),
      lock_refused: contractTurn([], {
        withLock: () => Promise.reject(new Error('This agent is busy right now.'))
      })
    }),

    hangs: () => {
      let markStarted!: () => void
      const started = new Promise<void>((r) => (markStarted = r))
      // `mark` runs only when the runner pulls the step after `init`, i.e.
      // once it has consumed `init` — mid-turn, past every readiness rung.
      const turn = contractTurn([[{ yield: init() }, { mark: 'started' }, { untilAborted: true }]], {}, {
        marks: { started: () => markStarted() }
      })
      return { ...turn, started: () => started }
    },

    parks: () => {
      let openGate!: () => void
      const settled = new Promise<void>((r) => (openGate = r))
      const input = { command: 'rm -rf /tmp/x' }
      const turn = contractTurn(
        [
          [
            { yield: init() },
            { yield: { type: 'stream_event', session_id: 'sess-contract', event: { type: 'message_start', message: { id: 'msg_1' } } } },
            { yield: { type: 'assistant', message: { id: 'msg_1', content: [{ type: 'tool_use', id: 'toolu_bash', name: 'Bash', input }] } } },
            { ask: { toolName: 'Bash', input } },
            { gate: 'settled' },
            { yield: result() }
          ]
        ],
        {},
        { gates: { settled } }
      )
      return { ...turn, answer: { kind: 'permission', reply: 'once' }, afterSettle: () => openGate() }
    },

    session: () => {
      const store = new Map<string, string>()
      const saved: string[] = []
      let readBySecond: string | null | undefined
      const key = (chatId: string, agentId: string): string => `${chatId}|${agentId}`
      const shared: Partial<ClaudeTurnDeps> = {
        saveSession: (s) => {
          saved.push(s.sessionId)
          store.set(key(s.chatId, s.agentId), s.sessionId)
        }
      }
      const script = (): ScriptStep[][] => [[{ yield: init() }, { yield: result() }]]
      return {
        first: contractTurn(script(), {
          ...shared,
          readSession: (chatId, agentId) => store.get(key(chatId, agentId)) ?? null
        }),
        second: contractTurn(script(), {
          ...shared,
          readSession: (chatId, agentId) => (readBySecond = store.get(key(chatId, agentId)) ?? null)
        }),
        saved: () => saved,
        readBySecond: () => readBySecond ?? null
      }
    }
  }
}

describeRunnerContract('claude', makeSubject, {
  knownViolations: {
    // Evidence: `canceled_midway.expected.json` — the `signal.aborted` exit
    // calls `finish(…, undefined)`, so a stop is reported as a quiet success.
    'abort.reports': 'a stopped turn resolves with neither error nor taskState "canceled", the same shape as a completed one'
  }
})
