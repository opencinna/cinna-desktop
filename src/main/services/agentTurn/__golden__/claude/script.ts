/**
 * Plays a Claude golden fixture through the `claude` driver over
 * `ClaudeAgentTurnRunner` — the interpreter behind `golden.claude.test.ts`.
 * (Through the driver since phase 2; the runner and every expectation are the
 * ones phase 0 pinned.)
 *
 * A fixture is **data**: one step script per `query()` call the runner makes,
 * plus the few deps that change what the runner does (`approval`, a remembered
 * session, a standing grant, the login probe). The interpreter here plays the
 * SDK's half of the conversation from that script, so the fixture file never
 * holds code and the runner is driven with no child process.
 *
 * ## What the stub does that the SDK does, and why each is here
 *
 * Every rule below is one the runner is built around and none is visible in
 * the SDK's types; each is a finding in `docs/agents/local_agents/
 * claude_contract.md`, and a stub without it would pin a runner reacting to a
 * stream the binary never produces.
 *
 * - **The prompt iterable is consumed as the SDK consumes it**, and whether it
 *   has ended ("stdin closed") is observable to the script. The CLI exits only
 *   after stdin closes; `untilStdinClosed` is that wait.
 * - **A cancellation is a throw** — `Error('Claude Code process aborted by
 *   user')`, `.name === 'Error'` (§2, Cancellation). Once the abort controller
 *   the runner handed over has fired, the next step, any step still awaiting,
 *   and the end of the script all throw it; nothing after the abort is yielded.
 * - **A permission ask over a closed stdin never reaches `canUseTool`** (§2,
 *   background subagents). The CLI's control request fails inside the CLI and
 *   the model is told *"Tool permission request failed: AbortError: Stream
 *   closed"*. An `ask` step taken after the iterable ended records exactly that
 *   instead of calling the callback — which is what makes
 *   `stream_closed_stdin` fail the moment the runner closes stdin early.
 *
 * ## What is captured beside the stream
 *
 * `expectGolden` compares `{events, result}` and nothing else, and the half of
 * the runner's behaviour that faces the SDK is not in either: what
 * `canUseTool` **returned** (the decision the model acts on), the options and
 * prompt each `query()` was called with (a retry's `resume`, the approval
 * mapping), whether stdin was open at a point the script probed, and what
 * reached `saveSession`. That is the {@link BoundaryCapture}, compared against
 * `<scenario>.boundary.expected.json` by {@link expectBoundaryGolden} under the
 * same rules as the harness: written only when missing and `GOLDEN_WRITE=1`,
 * never overwritten, `_notes` not compared.
 */

import {
  ClaudeAgentTurnRunner,
  type ClaudeTurnDeps
} from '../../claudeAgentTurnRunner'
import { pendingRequests, type RequestResolution } from '../../pendingRequests'
import { expectGoldenSidecar, type NormaliseOptions } from '../harness'
import { folderReader, goldenRow, wrongEngine } from '../driverWorld'
import { createClaudeDriver } from '../../../../agents/drivers/claudeDriver'
import type { FolderDriver } from '../../../../agents/drivers/folderDriver'
import type { AgentRow } from '../../../../db/agents'
import type { LocalPermissionRequest } from '../../../../../shared/localAgentRequests'
import type { RunEvent } from '../../../../../shared/runEvents'
import type { RunAgentTurnResult } from '../../../a2aStreamingService'
import type { ClaudeApproval, ClaudeAuthState } from '../../../../../shared/engine'

/** One thing the SDK side does, in order. Exactly one key per step. */
export type ScriptStep =
  /** Hand the runner one SDK message. */
  | { yield: unknown }
  /**
   * The CLI asks `canUseTool`. Without `answer` or `abortWhenParked` nobody
   * answers from here — a grant settles it, or the contract suite does.
   */
  | {
      ask: { toolName: string; input: Record<string, unknown> }
      /** Posted through the real `pendingRequests` once the ask is parked. */
      answer?: RequestResolution
      /** The user presses stop while the ask is parked. */
      abortWhenParked?: true
    }
  /** The user presses stop. The SDK's cancellation throw follows at the next step. */
  | { abort: true }
  /** The iterator throws, as the SDK reports every failure. */
  | { throw: { message: string; name?: string } }
  /** Record whether stdin is still open here, under this label. */
  | { stdin: string }
  /** Wait for the runner to end the prompt iterable, as the child waits to exit. */
  | { untilStdinClosed: true }
  /** Block until the turn is aborted, then throw the cancellation. */
  | { untilAborted: true }
  /** Call a named hook — `started` for the contract's hanging turn. */
  | { mark: string }
  /** Wait on a named gate — `settled` for the contract's parked turn. */
  | { gate: string }

export interface FixtureDeps {
  approval?: ClaudeApproval
  /** The model alias the runtime resolved; null hands the choice to the CLI. */
  model?: string | null
  /** The session remembered for this chat before the turn. */
  readSession?: string | null
  /** Whether a standing grant covers every ask. */
  isGranted?: boolean
  claudeAuth?: ClaudeAuthState
  claudePath?: string | null
}

export interface ClaudeFixture {
  recorded_from: string
  source?: string | string[]
  description: string
  deps?: FixtureDeps
  input?: { wireContent?: string }
  /** One script per `query()` call, in call order. A call past the end is a problem. */
  queries: ScriptStep[][]
}

export interface AskRecord {
  toolName: string
  /** False when stdin had closed and the CLI failed the ask before it reached the desktop. */
  reachedDesktop: boolean
  /** What `canUseTool` resolved to — or, when it never ran, what the model was told. */
  returned?: unknown
  /** Whether the SDK was still awaiting the callback when it resolved. */
  arrived?: 'while the SDK waited' | 'after the SDK had gone'
}

export interface QueryRecord {
  options: Record<string, unknown>
  /** Every message the prompt iterable yielded. */
  prompt: unknown[]
  /** Whether the runner had ended the iterable by the time the turn settled. */
  stdinClosedAfterTurn?: boolean
}

export interface BoundaryCapture {
  queries: QueryRecord[]
  decisions: AskRecord[]
  stdin: { at: string; open: boolean }[]
  savedSessions: unknown[]
  /**
   * `onEvent` calls that arrived after `runTurn` had resolved. The live port
   * has posted `done` by then, so anything here is a delta into a turn that
   * already ended — and one the returned `parts` cannot contain.
   */
  eventsAfterSettle: unknown[]
}

export interface ScriptHooks {
  chatId: string
  abortTurn?: () => void
  marks?: Record<string, () => void>
  gates?: Record<string, Promise<void>>
}

export const SDK_CANCELLATION_MESSAGE = 'Claude Code process aborted by user'
export const STREAM_CLOSED_DENIAL = 'Tool permission request failed: AbortError: Stream closed'

/** How long a script waits on the runner before calling it a problem rather than hanging. */
const WAIT_MS = 2_000

const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0))
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

/** The SDK's cancellation, as observed: a plain `Error`, not an `AbortError`. */
function cancellation(): Error {
  return new Error(SDK_CANCELLATION_MESSAGE)
}

/** Settle with `promise`, or throw the cancellation the moment `signal` aborts. */
function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(cancellation())
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => reject(cancellation())
    signal.addEventListener('abort', onAbort, { once: true })
    promise.then(
      (v) => {
        signal.removeEventListener('abort', onAbort)
        resolve(v)
      },
      (e) => {
        signal.removeEventListener('abort', onAbort)
        reject(e)
      }
    )
  })
}

/** The options worth pinning. `env` is left out: it is built from the host's own environment. */
function pickOptions(o: Record<string, unknown>): Record<string, unknown> {
  return {
    keys: Object.keys(o).sort(),
    cwd: o.cwd,
    pathToClaudeCodeExecutable: o.pathToClaudeCodeExecutable,
    systemPrompt: o.systemPrompt,
    model: o.model,
    permissionMode: o.permissionMode,
    resume: o.resume,
    settingSources: o.settingSources,
    strictMcpConfig: o.strictMcpConfig,
    mcpServers: o.mcpServers,
    includePartialMessages: o.includePartialMessages,
    agents: o.agents,
    canUseTool: typeof o.canUseTool
  }
}

type CanUseTool = (
  toolName: string,
  input: Record<string, unknown>,
  extra: { signal: AbortSignal; suggestions: unknown[] }
) => Promise<unknown>

interface QueryArgs {
  prompt: AsyncIterable<unknown>
  options?: Record<string, unknown>
}

export interface Scripted {
  query: NonNullable<ClaudeTurnDeps['query']>
  boundary: Omit<BoundaryCapture, 'savedSessions' | 'eventsAfterSettle'>
  /** Anything the script could not do. A golden run asserts this is empty. */
  problems: string[]
  /** Stamp each query with whether its iterable had ended. Call once the turn settled. */
  seal(): Promise<void>
}

/** A `query` that plays `scripts`, one per call. */
export function scriptedQuery(scripts: ScriptStep[][], hooks: ScriptHooks): Scripted {
  const boundary: Scripted['boundary'] = { queries: [], decisions: [], stdin: [] }
  const problems: string[] = []
  const closedFlags: (() => boolean)[] = []
  let calls = 0

  /** The one request this chat is parked on, once the runner has registered it. */
  async function untilParked(): Promise<string | null> {
    const deadline = Date.now() + WAIT_MS
    while (Date.now() < deadline) {
      const [first] = pendingRequests.listForChat(hooks.chatId)
      if (first) return first.requestId
      await sleep(2)
    }
    problems.push('an ask step expected a parked request and none was registered')
    return null
  }

  const query = ((args: QueryArgs) => {
    const index = calls++
    const options = args.options ?? {}
    const record: QueryRecord = { options: pickOptions(options), prompt: [] }
    boundary.queries.push(record)

    let closed = false
    closedFlags.push(() => closed)
    void (async () => {
      for await (const m of args.prompt) record.prompt.push(m)
      closed = true
    })()

    const controller = options.abortController as AbortController | undefined
    const signal = controller?.signal ?? new AbortController().signal
    const canUseTool = options.canUseTool as CanUseTool | undefined
    const steps = scripts[index]

    return (async function* () {
      if (!steps) {
        problems.push(`query() was called ${index + 1} times; the fixture scripts ${scripts.length}`)
        throw new Error('unscripted query() call')
      }
      for (const step of steps) {
        if (signal.aborted) throw cancellation()

        if ('yield' in step) {
          yield step.yield
        } else if ('ask' in step) {
          // A macrotask first, so an iterable the runner has just ended is
          // seen as ended — the CLI's stdin is closed by then too.
          await abortable(tick(), signal)
          const { toolName, input } = step.ask
          if (closed) {
            boundary.decisions.push({
              toolName,
              reachedDesktop: false,
              returned: { behavior: 'deny', message: STREAM_CLOSED_DENIAL }
            })
            continue
          }
          if (!canUseTool) {
            problems.push('an ask step ran but the runner passed no canUseTool')
            throw new Error('no canUseTool')
          }
          const rec: AskRecord = { toolName, reachedDesktop: true }
          boundary.decisions.push(rec)
          let sdkWaiting = true
          const decision = canUseTool(toolName, input, { signal, suggestions: [] })
          void decision.then((v) => {
            rec.returned = v
            rec.arrived = sdkWaiting ? 'while the SDK waited' : 'after the SDK had gone'
          })
          if (step.answer || step.abortWhenParked) {
            const requestId = await abortable(untilParked(), signal)
            if (requestId && step.answer && !pendingRequests.resolve(requestId, step.answer)) {
              problems.push(`the parked request refused the fixture's answer`)
            }
            if (requestId && step.abortWhenParked) {
              if (hooks.abortTurn) hooks.abortTurn()
              else problems.push('abortWhenParked with no abortTurn hook')
            }
          }
          try {
            await abortable(decision, signal)
          } finally {
            sdkWaiting = false
          }
        } else if ('abort' in step) {
          if (hooks.abortTurn) hooks.abortTurn()
          else problems.push('an abort step with no abortTurn hook')
        } else if ('throw' in step) {
          const err = new Error(step.throw.message)
          if (step.throw.name) err.name = step.throw.name
          throw err
        } else if ('stdin' in step) {
          await abortable(tick(), signal)
          boundary.stdin.push({ at: step.stdin, open: !closed })
        } else if ('untilStdinClosed' in step) {
          const deadline = Date.now() + WAIT_MS
          while (!closed && Date.now() < deadline) await abortable(sleep(1), signal)
          if (!closed) problems.push('stdin was never closed after the last result')
        } else if ('untilAborted' in step) {
          await abortable(new Promise<never>(() => {}), signal)
        } else if ('mark' in step) {
          const hook = hooks.marks?.[step.mark]
          if (hook) hook()
          else problems.push(`no hook for mark "${step.mark}"`)
        } else if ('gate' in step) {
          const gate = hooks.gates?.[step.gate]
          if (gate) await abortable(gate, signal)
          else problems.push(`no gate named "${step.gate}"`)
        }
      }
      if (signal.aborted) throw cancellation()
    })()
  }) as unknown as NonNullable<ClaudeTurnDeps['query']>

  return {
    query,
    boundary,
    problems,
    async seal() {
      await tick()
      boundary.queries.forEach((q, i) => (q.stdinClosedAfterTurn = closedFlags[i]()))
    }
  }
}

export const GOLDEN_CHAT_ID = 'chat-1'
export const GOLDEN_AGENT_ID = 'folder:aaa'
/** A path that does not exist, so `readFolderAgents` finds nothing and passes no `agents`. */
export const GOLDEN_AGENT_DIR = '/agents/invoices'
export const GOLDEN_WIRE_CONTENT = 'what is the secret word?'

/** The runner's world, as `claudeAgentTurnRunner.test.ts`'s `makeDeps` builds it. */
export function fixtureDeps(
  d: FixtureDeps,
  query: ClaudeTurnDeps['query'],
  over: Partial<ClaudeTurnDeps> = {}
): ClaudeTurnDeps {
  const auth = d.claudeAuth ?? 'logged_in'
  return {
    getAgent: () => ({
      name: 'Invoices',
      path: GOLDEN_AGENT_DIR,
      kind: 'kit',
      enabled: true,
      readiness: 'ok',
      readinessReason: null
    }),
    systemPrompt: () => 'You are the invoices agent.',
    model: () => (d.model === undefined ? 'sonnet' : d.model),
    approval: () => d.approval ?? 'auto',
    claudePath: async () => (d.claudePath === undefined ? '/usr/local/bin/claude' : d.claudePath),
    claudeAuth: async () =>
      auth === 'logged_in'
        ? { state: 'logged_in', authMethod: 'claude.ai', subscriptionType: 'max', email: 'someone@example.com' }
        : { state: auth, authMethod: auth === 'logged_out' ? 'none' : null, subscriptionType: null, email: null },
    shellEnv: async () => ({ PATH: '/usr/bin', HOME: '/Users/x', USER: 'x' }),
    appVersion: () => '1.2.3',
    readSession: () => d.readSession ?? null,
    saveSession: () => {},
    withLock: (_agentId, _owner, fn) => fn(),
    userId: () => 'user-1',
    isGranted: () => d.isGranted ?? false,
    query,
    ...over
  }
}

/**
 * The `claude` driver over a runner built from `deps` — what every golden turn
 * goes through since phase 2, as production's does. The folder it reconciles
 * against is the runner's own `getAgent` view with a runtime naming `claude`;
 * the `opencode` sibling rejects any turn it is handed. `grants` collects every
 * *Always allow* the driver is asked to write.
 */
export function goldenClaudeDriver(
  deps: ClaudeTurnDeps,
  grants: LocalPermissionRequest[] = []
): FolderDriver {
  return createClaudeDriver({
    runner: new ClaudeAgentTurnRunner(deps),
    readFolder: folderReader(deps.getAgent, 'claude'),
    rememberGrant: (_agentId, request) => {
      grants.push(request)
      return true
    },
    resolveRequest: (requestId, resolution) =>
      pendingRequests.resolve(requestId, resolution) !== null,
    sibling: wrongEngine('claude'),
    claudePath: deps.claudePath,
    claudeAuth: deps.claudeAuth
  })
}

/** The folder row the golden Claude turns run as. */
export function goldenClaudeRow(): AgentRow {
  return goldenRow({
    id: GOLDEN_AGENT_ID,
    name: 'Invoices',
    driver: 'claude',
    source: 'folder',
    protocol: 'local-folder',
    localPath: GOLDEN_AGENT_DIR
  })
}

export interface Played {
  events: RunEvent[]
  result: RunAgentTurnResult
  boundary: BoundaryCapture
  problems: string[]
}

/** Drive one fixture through a fresh runner and collect everything it did. */
export async function playFixture(fixture: ClaudeFixture): Promise<Played> {
  const controller = new AbortController()
  const scripted = scriptedQuery(fixture.queries, {
    chatId: GOLDEN_CHAT_ID,
    abortTurn: () => controller.abort()
  })
  const savedSessions: unknown[] = []
  const deps = fixtureDeps(fixture.deps ?? {}, scripted.query, {
    saveSession: (s) => void savedSessions.push(s)
  })
  const events: RunEvent[] = []
  const result = await goldenClaudeDriver(deps).run('user-1', goldenClaudeRow(), {
    chatId: GOLDEN_CHAT_ID,
    wireContent: fixture.input?.wireContent ?? GOLDEN_WIRE_CONTENT,
    signal: controller.signal,
    onEvent: (e) => void events.push(e)
  })
  const settledAt = events.length
  await scripted.seal()
  return {
    events,
    result,
    boundary: { ...scripted.boundary, savedSessions, eventsAfterSettle: events.slice(settledAt) },
    problems: scripted.problems
  }
}

/**
 * Compare a boundary capture with `<scenario>.boundary.expected.json`, under
 * the harness's own rules: a missing file is written only with `GOLDEN_WRITE=1`
 * and the test still fails; an existing one is never overwritten.
 */
export function expectBoundaryGolden(
  scenario: string,
  capture: BoundaryCapture,
  options: NormaliseOptions = {}
): void {
  expectGoldenSidecar('claude', scenario, 'boundary', capture, options)
}
