/**
 * The ACP driver, driven end to end against a **real child process** — the
 * scripted fake agent in `testSupport/`, over real pipes and real
 * newline-delimited JSON-RPC.
 *
 * Nothing here is mocked below the driver's own injected world. That is the
 * point: every interesting property of this file is a fact about a process and
 * a protocol — that a `session/load` replay does not land in this turn's
 * transcript, that a permission ask blocks the agent until a human answers,
 * that an unacknowledged cancel does not hold the turn lock for twenty minutes
 * — and none of them survives being faked with a pair of in-memory streams.
 *
 * The driver contract suite (`__golden__/driverContract.ts`) runs at the bottom,
 * over the same world, so this driver is judged by the same clauses as the two
 * it replaces.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import type { LocalAgentKind } from '../../../../shared/localAgents'
import type { LocalPermissionRequest } from '../../../../shared/localAgentRequests'
import type { RunEvent } from '../../../../shared/runEvents'
import type { AgentDriver, FollowUpRequest, RunInput, SteerFn } from '../driver'
import type { TurnSnapshot } from '../../../services/a2aStreamingService'
import followUpFixture from './__fixtures__/claude/followup_turn.json'
import { pendingRequests } from '../pendingRequests'
import {
  describeDriverContract,
  type DriverContractSubject
} from '../__golden__/driverContract'
import { goldenRow } from '../__golden__/driverWorld'
import { ACP_FOLLOW_UP_EXITED, createAcpDriver, exitListenerCount, type AcpDriver, type AcpDriverDeps, type AcpFolderView, type AcpRuntimeView } from './acpDriver'
import { createAcpProcessPool } from './acpProcessPool'
import { turnLock } from '../../../services/localAgents/turnLock'
import { startAcpConnection } from './acpConnection'
import type { AcpLauncher, AcpLaunchPlan, AcpPlanResult } from './acpLaunchers'
import { createFakeAcp, settle, waitFor, type FakeAcp, type FakeAcpScript, type FakeAcpStep } from './testSupport/fakeAcp'
import { ACP_PROTOCOL_VERSION, type AcpConnection, type AcpLauncherId, type AcpProcessPool } from './types'
import type { SessionTrafficScope, SessionTrafficSink } from './acpSessionObserver'
import type { SessionTelemetry, SessionTelemetryChange, SessionTelemetryReporter } from '../../../../shared/sessionTelemetry'
import { applyTelemetryChange } from '../../telemetry/sessionTelemetryReducer'
import { assistantMessage, initMessage, resultMessage, sdkParams } from './testSupport/sdkMessageFixtures'

/** The one `needs_input` a turn posted, waited for. */
function askedFor(w: World): Promise<Extract<RunEvent, { type: 'needs_input' }>> {
  return waitFor(
    () =>
      w.events.find(
        (event): event is Extract<RunEvent, { type: 'needs_input' }> =>
          event.type === 'needs_input'
      ),
    'the needs_input event'
  )
}

function deferred<T>(): { promise: Promise<T>; resolve(value: T): void; reject(error: Error): void } {
  let resolve!: (value: T) => void
  let reject!: (error: Error) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

const AGENT_ID = 'folder:pineapple'
const CHAT_ID = 'chat-1'
const USER_ID = '__default__'

const FOLDER: AcpFolderView = {
  name: 'Pineapple',
  slug: 'pineapple',
  description: 'The fake agent.',
  path: '/tmp/agents/pineapple',
  kind: 'kit' as LocalAgentKind,
  runtimeMode: 'isolated',
  enabled: true,
  readiness: 'ok',
  readinessReason: null,
  runtime: { engine: 'opencode' }
}

const ROW = goldenRow({
  id: AGENT_ID,
  name: 'Pineapple',
  driver: 'acp',
  source: 'folder',
  driverConfig: { launcher: 'opencode' },
  localPath: FOLDER.path
})

interface World {
  driver: AgentDriver
  pool: AcpProcessPool
  fake: FakeAcp
  /** Session ids the driver handed to `saveSession`, in order. */
  saved: string[]
  /** What the driver read back for a chat. */
  sessions: Map<string, string>
  /** *Always allow* rules the driver asked to be written. */
  grants: LocalPermissionRequest[]
  /** Every event the turn posted. */
  events: RunEvent[]
  run(overrides?: {
    handbackEligible?: boolean
    signal?: AbortSignal
    chatId?: string
    onEvent?: (event: RunEvent) => void
    registerSteer?: (steer: SteerFn | null) => void
    registerSnapshot?: RunInput['registerSnapshot']
    runScope?: RunInput['runScope']
  }): ReturnType<AgentDriver['run']>
  cleanup(): void
}

interface WorldOptions {
  script?: FakeAcpScript
  folder?: AcpFolderView | null
  launcher?: AcpLauncherId
  /** Refuse before anything is spawned. */
  refusal?: string
  /** What the launcher asks the driver to set on the session. */
  setup?: AcpLaunchPlan['setup']
  /** A remembered session for `CHAT_ID`. */
  remembered?: string
  /** Deny every grant check, or answer one. */
  granted?: boolean
  /** Fail the grant write, as an unreadable store would. */
  grantWriteFails?: boolean
  /** Make `readFolder` throw, for the readiness clause. */
  folderThrows?: boolean
  /** Per-launcher readiness, for the readiness clause. */
  launcherReadiness?: AcpLauncher['readiness']
  deps?: Partial<AcpDriverDeps>
  spec?: { command?: string; args?: string[] }
  /** The launcher ends every turn with a costed `usage_update`. Default: only `claude` does, as the real ones. */
  costedEnd?: boolean
  /** The idle reap of `observedWorld`'s pool. */
  reapMs?: number
  /** The launcher's own login report, for session telemetry (Codex). */
  telemetryAuth?: AcpLauncher['telemetryAuth']
}

function makeWorld(options: WorldOptions = {}): World {
  const fake = createFakeAcp(options.script ?? {})
  const spec = { ...fake.spec, ...options.spec }
  const saved: string[] = []
  const sessions = new Map<string, string>()
  if (options.remembered) sessions.set(CHAT_ID, options.remembered)
  const grants: LocalPermissionRequest[] = []
  const events: RunEvent[] = []

  const launcher: AcpLauncher = {
    id: options.launcher ?? 'opencode',
    endsTurnsWithCostedUsage: options.costedEnd ?? options.launcher === 'claude',
    plan: async (): Promise<AcpPlanResult> =>
      options.refusal
        ? { error: options.refusal }
        : {
            spec,
            init: {
              protocolVersion: ACP_PROTOCOL_VERSION,
              clientCapabilities: { elicitation: { form: {} } }
            },
            session: { mcpServers: [] },
            setup: options.setup ?? {}
          },
    ...(options.launcherReadiness ? { readiness: options.launcherReadiness } : {}),
    ...(options.telemetryAuth ? { telemetryAuth: options.telemetryAuth } : {})
  }

  const deps: AcpDriverDeps = {
    pool: createAcpProcessPool({ start: startAcpConnection }),
    launcher: (id) => (id === launcher.id ? launcher : undefined),
    readRuntime: () => {
      if (options.folderThrows) throw new Error('the folder could not be read')
      const folder = options.folder !== undefined ? options.folder : { ...FOLDER, runtime: { engine: launcher.id } }
      if (!folder) return null
      return { type: 'folder', folder, validate() {},
        readSession: (chatId) => sessions.get(chatId) ?? null,
        saveSession: (chatId, sessionId) => { saved.push(sessionId); sessions.set(chatId, sessionId) },
        isGranted: () => options.granted === true,
        rememberGrant: (request) => { if (options.grantWriteFails) return false; grants.push(request); return true }
      }
    },
    registerRequest: (input) => pendingRequests.register(input),
    resolveRequest: (requestId, resolution) =>
      pendingRequests.resolve(requestId, resolution) !== null,
    withLock: (_agentId, _owner, fn) => fn(),
    cancelGraceMs: 300,
    ...options.deps
  }

  const driver = createAcpDriver(deps)
  return {
    driver,
    pool: deps.pool,
    fake,
    saved,
    sessions,
    grants,
    events,
    run: (overrides = {}) =>
      driver.run(USER_ID, ROW, {
        chatId: overrides.chatId ?? CHAT_ID,
        handbackEligible: overrides.handbackEligible,
        wireContent: 'hello',
        signal: overrides.signal ?? new AbortController().signal,
        onEvent: overrides.onEvent ?? ((event) => void events.push(event)),
        ...(overrides.registerSteer ? { registerSteer: overrides.registerSteer } : {}),
        ...(overrides.registerSnapshot ? { registerSnapshot: overrides.registerSnapshot } : {}),
        ...(overrides.runScope ? { runScope: overrides.runScope } : {})
      }),
    cleanup: () => {
      void deps.pool.shutdown()
      fake.cleanup()
    }
  }
}

/** A prompt that streams one line and ends. */
const SAYS_HELLO: FakeAcpScript = {
  prompt: {
    emit: [
      {
        kind: 'update',
        update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Hello.' } }
      }
    ]
  }
}

const worlds: World[] = []

function world(options: WorldOptions = {}): World {
  const created = makeWorld(options)
  worlds.push(created)
  return created
}

afterEach(() => {
  pendingRequests.clear()
  for (const w of worlds.splice(0)) w.cleanup()
})

describe('conductor session integration', () => {
  it('injects a stable server on new and load, closes each lease and replays only a fresh session', async () => {
    const descriptor = { type: 'http' as const, name: 'cinna', url: 'http://127.0.0.1:12345/mcp/test', headers: [{name:'Authorization',value:'Bearer test'}] }
    const close = vi.fn()
    const replayTranscript = vi.fn(async () => '[user] Earlier question\n[assistant] Earlier answer')
    const w = world({ script: SAYS_HELLO, deps: {
      prepareConductor: async (_user, _agent, _input, plan) => { plan.session.mcpServers = [descriptor]; return {close,hasCalls:()=>false} },
      replayTranscript
    } })
    const scope = { profileUserId: USER_ID, settingsUserId: USER_ID }
    await w.run({runScope:scope})
    await w.run({runScope:scope})
    expect(w.fake.received('session/new')[0].params?.mcpServers).toEqual([descriptor])
    expect(w.fake.received('session/load')[0].params?.mcpServers).toEqual([descriptor])
    expect(w.fake.received('session/prompt')[0].params?.prompt).toEqual([
      {type:'text',text:'[user] Earlier question\n[assistant] Earlier answer'}, {type:'text',text:'hello'}
    ])
    expect(w.fake.received('session/prompt')[1].params?.prompt).toEqual([{type:'text',text:'hello'}])
    expect(replayTranscript).toHaveBeenCalledTimes(1)
    expect(close).toHaveBeenCalledTimes(2)
  })

  it('marks a conductor session current only once it has taken its prompt', async () => {
    const sessionReady = vi.fn()
    const sessionLost = vi.fn()
    const buildPrompt = vi.fn(async () => { throw new Error('attachment unreadable') })
    const failing = world({ script: SAYS_HELLO, deps: { buildPrompt,
      prepareConductor: async () => ({ close() {}, hasCalls: () => false, sessionReady, sessionLost }) } })
    const failed = await failing.run({ runScope: { profileUserId: USER_ID, settingsUserId: USER_ID } })
    expect(failed.error).toBeDefined()
    // Saved here, the next turn would load this empty session and never replay.
    expect(sessionReady).not.toHaveBeenCalled()
    // A created session also drops whatever digest an earlier one had saved.
    expect(sessionLost).toHaveBeenCalledTimes(1)

    const working = world({ script: SAYS_HELLO, deps: { prepareConductor: async () => ({ close() {}, hasCalls: () => false, sessionReady }) } })
    await working.run({ runScope: { profileUserId: USER_ID, settingsUserId: USER_ID } })
    expect(sessionReady).toHaveBeenCalledTimes(1)
  })

  it('ends an engine turn for a trusted task control without reporting user cancellation', async () => {
    let stop!: Parameters<NonNullable<AcpDriverDeps['prepareConductor']>>[4]
    const w = world({ script: { prompt: { emit: [{kind:'update',update:{sessionUpdate:'agent_message_chunk',content:{type:'text',text:'Working'}}},{kind:'awaitCancel'}] } }, deps: {
      prepareConductor: async (_user, _agent, _input, _plan, settle) => { stop = settle; return {close(){},hasCalls:()=>false} }
    } })
    const running = w.run()
    await waitFor(() => w.fake.received('session/prompt').length > 0, 'prompt')
    stop({control:{kind:'finish',summary:'Verified'}})
    const result = await running
    expect(result.error).toBeUndefined()
    expect(result.stopReason).toBe('end_turn')
    expect(result.taskState).toBe('completed')
    expect(result.control).toEqual({kind:'finish',summary:'Verified'})
    expect(result.parts.filter((part) => part.kind === 'text').map((part) => part.text).join('')).toContain('Verified')
    expect(w.events.filter((event) => event.type === 'delta' && event.text === 'Verified')).toHaveLength(1)
  })
})

describe('a turn', () => {
  it('prompts the agent and returns what it streamed', async () => {
    const w = world({ script: SAYS_HELLO })
    const result = await w.run()
    expect(result.error).toBeUndefined()
    expect(result.text).toContain('Hello.')
    expect(result.contextId).toBe('ses_fake')
    expect(w.fake.received('session/prompt')[0].params?.prompt).toEqual([
      { type: 'text', text: 'hello' }
    ])
  })

  it('leaves a subagent’s words out of the turn’s text when the agent said nothing itself', async () => {
    // Mutation: fall back to every part's text → the child's report is the turn's preview.
    const lane = { claudeCode: { parentToolUseId: 'call_agent' } }
    const w = world({ script: { prompt: { emit: [
      { kind: 'update', update: { sessionUpdate: 'tool_call', toolCallId: 'call_agent', title: 'Agent', kind: 'other', status: 'in_progress', _meta: { claudeCode: { toolName: 'Agent' } } } },
      { kind: 'update', update: { sessionUpdate: 'agent_message_chunk', messageId: 'child', content: { type: 'text', text: 'CHILD REPORT' }, _meta: lane } }
    ] } } })
    const result = await w.run()
    expect(result.parts.some((part) => part.parentToolId === 'call_agent' && part.text === 'CHILD REPORT')).toBe(true)
    expect(result.text).not.toContain('CHILD REPORT')
  })

  it('runs in the agent’s folder, with the environment the launcher named and nothing else', async () => {
    const w = world({ script: SAYS_HELLO })
    await w.run()
    const start = w.fake.log().find((entry) => entry.dir === 'start')
    const env = start?.env ?? {}
    // The fake's spec names only the two variables it needs, so anything from
    // *this* process would show up here. (`__CF_USER_TEXT_ENCODING` is libc's,
    // added below anything a parent can control.)
    expect(Object.keys(env).filter((name) => !name.startsWith('__')).sort()).toEqual([
      'FAKE_ACP_LOG',
      'FAKE_ACP_SCRIPT'
    ])
    expect(env.PATH).toBeUndefined()
    expect(env.HOME).toBeUndefined()
  })

  it('says what the launcher asked it to say to the session, before the first prompt', async () => {
    const w = world({
      script: SAYS_HELLO,
      setup: {
        modeId: 'default',
        configOptions: [
          { configId: 'mode', value: 'pineapple-abc' },
          { configId: 'model', value: 'anthropic/claude-sonnet-5' }
        ]
      }
    })
    await w.run()
    const order = w.fake
      .log()
      .filter((entry) => entry.dir === 'in' && entry.kind === 'request')
      .map((entry) => entry.method)
    expect(order).toEqual([
      'initialize',
      'session/new',
      'session/set_mode',
      'session/set_config_option',
      'session/set_config_option',
      'session/prompt'
    ])
  })

  it('reports a stop reason the user needs to know about', async () => {
    const w = world({ script: { prompt: { response: { stopReason: 'max_tokens' } } } })
    const result = await w.run()
    expect(result.error?.message).toMatch(/output limit/)
  })

  it('keeps what it streamed when the agent fails half way', async () => {
    const w = world({
      script: {
        prompt: {
          emit: [
            {
              kind: 'update',
              update: {
                sessionUpdate: 'agent_message_chunk',
                content: { type: 'text', text: 'Working on it' }
              }
            }
          ],
          error: { code: -32603, message: "Internal error: model 'does-not-exist' not found" }
        }
      }
    })
    const result = await w.run()
    expect(result.error?.message).toMatch(/model 'does-not-exist' not found/)
    // An error must not blank a partial answer.
    expect(result.text).toContain('Working on it')
  })

  it('classifies an adapter rate-limit RequestError as a budget pause without losing partial work or diagnostics', async () => {
    const w = world({ script: { prompt: {
      emit: [{ kind: 'update', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Verified the first file.' } } }],
      error: { code: -32603, message: 'This login has reached its limit. Try again at 14:00.', data: { errorKind: 'rate_limit' } }
    } } })
    const result = await w.run()
    expect(result).toMatchObject({ stopReason: 'budget', text: 'Verified the first file.',
      error: { code: 'rate_limit', message: 'This login has reached its limit. Try again at 14:00.', raw: 'This login has reached its limit. Try again at 14:00.' } })
    expect(result.parts).toContainEqual(expect.objectContaining({ kind: 'text', text: 'Verified the first file.' }))
  })

  it.each([undefined, { errorKind: 'authentication_failed' }, { error: 'rate_limit' }])(
    'does not classify an untyped or unrelated error as a shared rate limit (%j)', async (data) => {
      const w = world({ script: { prompt: { error: { code: -32603, message: 'A tool reported rate_limit.', data } } } })
      const result = await w.run()
      expect(result.stopReason).not.toBe('budget')
      expect(result.error?.message).toBe('A tool reported rate_limit.')
    }
  )

  it('does not infer a shared login limit from an HTTP 429 message alone', async () => {
    const w = world({ script: { prompt: { error: { code: -32603, message: 'HTTP 429: rate limit reached by the requested tool.' } } } })
    const result = await w.run()
    expect(result.stopReason).not.toBe('budget')
    expect(result.error?.message).toBe('HTTP 429: rate limit reached by the requested tool.')
  })

  it('keeps user cancellation authoritative when the adapter subsequently reports a rate limit', async () => {
    const w = world({ script: { prompt: { emit: [{ kind: 'awaitCancel' }],
      error: { code: -32603, message: 'Shared login exhausted', data: { errorKind: 'rate_limit' } } } } })
    const controller = new AbortController()
    const running = w.run({ signal: controller.signal })
    await waitFor(() => w.fake.received('session/prompt').length > 0, 'prompt')
    controller.abort()
    const result = await running
    expect(result.stopReason).toBe('canceled')
    expect(result.error).toBeUndefined()
  })
})

describe('manifest-authorized coordinator handback', () => {
  const answer = '/handback Verified app-data/report.md; no open work.'
  const response = (sessionUpdate = 'agent_message_chunk', stopReason = 'end_turn'): FakeAcpScript => ({ prompt: {
    emit: [{ kind: 'update', update: { sessionUpdate, content: { type: 'text', text: answer } } }],
    response: { stopReason }
  } })
  it('returns a typed note only from an eligible completed kit assistant answer', async () => {
    const w = world({ folder: { ...FOLDER, coordinatorHandback: true }, script: response() })
    const result = await w.run({ handbackEligible: true })
    expect(result.handback).toEqual({ note: 'Verified app-data/report.md; no open work.' })
    expect(result.text).toBe(answer)
  })
  it.each([
    [false, true, 'kit', 'end_turn'],
    [true, false, 'kit', 'end_turn'],
    [true, true, 'bare', 'end_turn'],
    [true, true, 'kit', 'cancelled'],
    [true, true, 'kit', 'max_tokens'],
    [true, true, 'kit', 'future_stop_reason']
  ] as const)('refuses eligibility=%s manifest=%s kind=%s ending=%s', async (eligible, declared, kind, stopReason) => {
    const w = world({ folder: { ...FOLDER, kind, coordinatorHandback: declared }, script: response('agent_message_chunk', stopReason) })
    expect((await w.run({ handbackEligible: eligible })).handback).toBeUndefined()
  })
  it('does not parse reasoning used as fallback display text', async () => {
    const w = world({ folder: { ...FOLDER, coordinatorHandback: true }, script: response('agent_thought_chunk') })
    const result = await w.run({ handbackEligible: true })
    expect(result.text).toContain('/handback')
    expect(result.handback).toBeUndefined()
  })
  it('keeps a streamed note as transcript data when the protocol turn fails', async () => {
    const script = response()
    script.prompt!.error = { code: -32603, message: 'Work failed' }
    const w = world({ folder: { ...FOLDER, coordinatorHandback: true }, script })
    const result = await w.run({ handbackEligible: true })
    expect(result.text).toContain('/handback')
    expect(result.error).toBeDefined()
    expect(result.handback).toBeUndefined()
  })
  it('does not authorize a marker contained only in a tool result', async () => {
    const w = world({ folder: { ...FOLDER, coordinatorHandback: true }, script: { prompt: {
      emit: [{ kind: 'update', update: {
        sessionUpdate: 'tool_call', toolCallId: 'read_result', title: 'Read report',
        kind: 'read', status: 'completed',
        content: [{ type: 'content', content: { type: 'text', text: answer } }]
      } }]
    } } })
    const result = await w.run({ handbackEligible: true })
    expect(result.error).toBeUndefined()
    expect(result.handback).toBeUndefined()
    expect(JSON.stringify(result.parts)).toContain('/handback')
  })
  it('does not authorize a marker replayed by session/load', async () => {
    const w = world({ folder: { ...FOLDER, coordinatorHandback: true }, remembered: 'ses_old', script: {
      loadSession: { emit: [{ kind: 'update', sessionId: 'ses_old', update: {
        sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: answer }
      } }] },
      prompt: { emit: [{ kind: 'update', sessionId: 'ses_old', update: {
        sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Current work is ready.' }
      } }] }
    } })
    const result = await w.run({ handbackEligible: true })
    expect(w.fake.received('session/load')).toHaveLength(1)
    expect(result.text).toBe('Current work is ready.')
    expect(result.handback).toBeUndefined()
  })
})

describe('a mid-turn message (the steering extension)', () => {
  const STEERABLE: FakeAcpScript = { initialize: { response: { _meta: { steering: { supported: true } } } } }
  const chunk = (text: string): FakeAcpStep => ({
    kind: 'update',
    update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } }
  })

  /** What the driver offered through `registerSteer`, and how often it withdrew it. */
  function steerCapture(): { offered: SteerFn[]; withdrawn: () => number; registerSteer: (steer: SteerFn | null) => void } {
    const offered: SteerFn[] = []
    let withdrawn = 0
    return {
      offered,
      withdrawn: () => withdrawn,
      registerSteer: (steer) => { if (steer) offered.push(steer); else withdrawn += 1 }
    }
  }

  const steerable = (w: World, capture: ReturnType<typeof steerCapture>): Promise<boolean> =>
    waitFor(() => capture.offered.length > 0 && w.events.some((event) => event.type === 'delta'), 'the turn to take messages')

  it('is taken into a prompt in flight, posted as a user message, and lands between the parts around it', async () => {
    const w = world({
      script: { ...STEERABLE, prompt: { emit: [chunk('Before. '), { kind: 'awaitSteer' }, { kind: 'delay', ms: 150 }, chunk('After.')] } }
    })
    const capture = steerCapture()
    const running = w.run({ registerSteer: capture.registerSteer })
    await steerable(w, capture)
    expect(await capture.offered[0]('also this')).toBe('injected')
    const result = await running

    expect(w.fake.received('_session/steering').map((entry) => entry.params)).toEqual([{
      sessionId: 'ses_fake',
      prompt: [{ type: 'text', text: 'also this' }],
      _meta: { steering: { idleBehavior: 'promptRequired' } }
    }])
    const order = w.events.flatMap((event) =>
      event.type === 'delta' ? [event.text] : event.type === 'user_message' ? [`user: ${event.text}`] : [])
    expect(order).toEqual(['Before. ', 'user: also this', 'After.'])
    // Two parts, not one: the text after the message must not merge into the text before it.
    expect(result.parts).toEqual([{ kind: 'text', text: 'Before. ' }, { kind: 'text', text: 'After.' }])
    expect(result.steers).toEqual([{ afterPart: 1, text: 'also this' }])
    expect(capture.withdrawn()).toBe(1)
  })

  it('is never offered by an agent that does not advertise steering', async () => {
    const w = world({ script: SAYS_HELLO })
    const capture = steerCapture()
    const result = await w.run({ registerSteer: capture.registerSteer })
    expect(result.error).toBeUndefined()
    expect(capture.offered).toEqual([])
    expect(w.fake.received('_session/steering')).toEqual([])
  })

  it('is unavailable once the prompt has settled, and nothing reaches the agent', async () => {
    const w = world({ script: { ...STEERABLE, ...SAYS_HELLO } })
    const capture = steerCapture()
    await w.run({ registerSteer: capture.registerSteer })
    expect(capture.offered).toHaveLength(1)
    expect(capture.withdrawn()).toBe(1)
    // The process is still up and would answer `injected`: only the driver's
    // own closing of the window keeps this message out of a finished turn.
    expect(await capture.offered[0]('too late')).toBe('unavailable')
    await settle()
    expect(w.fake.received('_session/steering')).toEqual([])
  })

  it('is withdrawn the moment the turn is stopped', async () => {
    const controller = new AbortController()
    const w = world({
      script: { ...STEERABLE, prompt: { emit: [chunk('Working.'), { kind: 'awaitCancel' }], response: { stopReason: 'cancelled' } } }
    })
    const capture = steerCapture()
    const running = w.run({ registerSteer: capture.registerSteer, signal: controller.signal })
    await steerable(w, capture)
    controller.abort()
    expect(capture.withdrawn()).toBe(1)
    expect(await capture.offered[0]('and also')).toBe('unavailable')
    await running
    expect(w.fake.received('_session/steering')).toEqual([])
  })

  it('cancels a turn the agent started on its own for the message, and reports it unavailable', async () => {
    const w = world({
      script: {
        ...STEERABLE,
        steer: { response: { outcome: 'startedNewTurn' } },
        prompt: { emit: [chunk('Working.'), { kind: 'awaitSteer' }, { kind: 'delay', ms: 100 }] }
      }
    })
    const capture = steerCapture()
    const running = w.run({ registerSteer: capture.registerSteer })
    await steerable(w, capture)
    expect(await capture.offered[0]('next')).toBe('unavailable')
    await waitFor(() => w.fake.received('session/cancel').length > 0, 'the orphan turn to be cancelled')
    const result = await running
    expect(w.events.some((event) => event.type === 'user_message')).toBe(false)
    expect(result.steers).toBeUndefined()
    // Retired, so the next turn cannot prompt a session the orphan may still be running in.
    await waitFor(() => w.pool.status(AGENT_ID).state !== 'running', 'the process to be retired')
  })

  it('reports a message the agent took after the turn stopped waiting as late, and keeps it out of the result', async () => {
    const w = world({
      script: { ...STEERABLE, steer: { delayMs: 900 }, prompt: { emit: [chunk('Working.'), { kind: 'delay', ms: 150 }] } }
    })
    const capture = steerCapture()
    const running = w.run({ registerSteer: capture.registerSteer })
    await steerable(w, capture)
    const late = capture.offered[0]('too slow')
    const result = await running
    expect(result.steers).toBeUndefined()
    expect(await late).toBe('late')
    expect(w.events.some((event) => event.type === 'user_message')).toBe(false)
  })

  /** Codex's answer to a mid-turn message, arriving only after the turn stopped waiting for it. */
  const LATE_NEW_TURN: FakeAcpScript = {
    ...STEERABLE,
    steer: { delayMs: 900, response: { outcome: 'startedNewTurn' } },
    prompt: { emit: [chunk('Working.'), { kind: 'delay', ms: 150 }] }
  }

  it('cancels an unowned turn that arrives after the turn stopped waiting, and leaves a process another turn holds', async () => {
    const w = world({ script: LATE_NEW_TURN })
    const retire = vi.spyOn(w.pool, 'retire')
    const capture = steerCapture()
    const running = w.run({ registerSteer: capture.registerSteer })
    await steerable(w, capture)
    const late = capture.offered[0]('next')
    await running
    // The next turn on this agent: a retire would wait for it, then kill its process.
    const release = w.pool.hold(AGENT_ID)
    expect(await late).toBe('unavailable')
    await waitFor(() => w.fake.received('session/cancel').length > 0, 'the orphan turn to be cancelled')
    expect(retire).not.toHaveBeenCalled()
    release()
    expect(w.pool.status(AGENT_ID).state).toBe('running')
  })

  it('retires the process when nothing holds it once an unowned turn arrives after the turn stopped waiting', async () => {
    const w = world({ script: LATE_NEW_TURN })
    const retire = vi.spyOn(w.pool, 'retire')
    const capture = steerCapture()
    const running = w.run({ registerSteer: capture.registerSteer })
    await steerable(w, capture)
    const late = capture.offered[0]('next')
    await running
    expect(await late).toBe('unavailable')
    expect(retire).toHaveBeenCalledWith(AGENT_ID)
    await waitFor(() => w.pool.status(AGENT_ID).state !== 'running', 'the process to be retired')
  })

  const toolCall = (status?: 'pending' | 'in_progress' | 'completed' | 'failed'): FakeAcpStep => ({
    kind: 'update',
    update: { sessionUpdate: 'tool_call', toolCallId: 'call_bash', title: 'Bash', kind: 'execute', ...(status ? { status } : {}) }
  })
  const toolUpdate = (status?: 'in_progress' | 'completed' | 'failed'): FakeAcpStep => ({
    kind: 'update',
    update: { sessionUpdate: 'tool_call_update', toolCallId: 'call_bash', ...(status ? { status } : {}) }
  })

  it('is withdrawn while a tool call runs, so a message cannot abort the command, and offered again once it completes', async () => {
    // The Claude adapter steers at `now`, and the CLI aborts the running tool for it.
    const w = world({
      script: {
        ...STEERABLE,
        prompt: {
          emit: [chunk('Running it. '), toolCall('in_progress'), toolUpdate(), { kind: 'delay', ms: 400 }, toolUpdate('completed'),
            { kind: 'awaitSteer' }, { kind: 'delay', ms: 150 }, chunk('Done.')]
        }
      }
    })
    const capture = steerCapture()
    const running = w.run({ registerSteer: capture.registerSteer })
    await steerable(w, capture)
    await waitFor(() => capture.withdrawn() === 1, 'steering to be withdrawn for the tool call')
    // Withdrawn, and the function the caller still holds refuses too: nothing reaches the agent.
    expect(await capture.offered[0]('2+2?')).toBe('unavailable')
    expect(w.fake.received('_session/steering')).toEqual([])
    // An update with no status is the call still running, not a second offer.
    expect(capture.offered).toHaveLength(1)

    await waitFor(() => capture.offered.length === 2, 'steering to be offered again once the tool completed')
    expect(await capture.offered[1]('2+2?')).toBe('injected')
    const result = await running
    expect(w.fake.received('_session/steering')).toHaveLength(1)
    expect(result.steers).toEqual([{ afterPart: expect.any(Number), text: '2+2?' }])
    expect(capture.withdrawn()).toBe(2)
  })

  it('counts a failed tool call as ended, and offers steering again', async () => {
    const w = world({
      script: {
        ...STEERABLE,
        prompt: { emit: [chunk('Trying. '), toolCall('pending'), toolUpdate('failed'), { kind: 'awaitSteer' }, { kind: 'delay', ms: 100 }] }
      }
    })
    const capture = steerCapture()
    const running = w.run({ registerSteer: capture.registerSteer })
    await waitFor(() => capture.offered.length === 2, 'steering to be offered again after the failed call')
    expect(capture.withdrawn()).toBe(1)
    expect(await capture.offered[1]('next')).toBe('injected')
    await running
  })

  it('is not withdrawn by an update that arrives after its tool call completed', async () => {
    // The Claude adapter sends the PostToolUse `toolResponse` as a status-less update past completion.
    const w = world({
      script: {
        ...STEERABLE,
        prompt: { emit: [chunk('Running it. '), toolCall('in_progress'), toolUpdate('completed'), toolUpdate(), { kind: 'awaitSteer' }, { kind: 'delay', ms: 100 }] }
      }
    })
    const capture = steerCapture()
    const running = w.run({ registerSteer: capture.registerSteer })
    await waitFor(() => capture.offered.length === 2, 'steering to be offered again once the tool completed')
    expect(await capture.offered[1]('2+2?')).toBe('injected')
    expect(capture.withdrawn()).toBe(1)
    await running
  })

  it('is not offered again by a tool call that ends after the prompt settled', async () => {
    // The steer keeps the turn waiting past its prompt, and the call's end arrives in that wait.
    const w = world({
      deps: { cancelGraceMs: 2000 },
      script: {
        ...STEERABLE,
        steer: { emit: [{ kind: 'delay', ms: 300 }, toolUpdate('completed')] },
        prompt: { emit: [chunk('Working.'), { kind: 'delay', ms: 100 }, toolCall('in_progress')] }
      }
    })
    const capture = steerCapture()
    const running = w.run({ registerSteer: capture.registerSteer })
    await steerable(w, capture)
    const steered = capture.offered[0]('meanwhile')
    await running
    expect(await steered).toBe('injected')
    expect(capture.offered).toHaveLength(1)
  })

  it('is not offered between the prompt going out and the agent’s first turn content, and is once that arrives', async () => {
    // An agent takes a steer only into a turn it has registered: codex-acp would answer an earlier one after the whole turn.
    const w = world({
      script: { ...STEERABLE, prompt: { emit: [{ kind: 'delay', ms: 300 }, chunk('Started. '), { kind: 'awaitSteer' }, { kind: 'delay', ms: 100 }] } }
    })
    const capture = steerCapture()
    const running = w.run({ registerSteer: capture.registerSteer })
    await waitFor(() => w.fake.received('session/prompt').length === 1, 'the prompt to reach the agent')
    expect(capture.offered).toEqual([])
    await steerable(w, capture)
    expect(capture.offered).toHaveLength(1)
    expect(await capture.offered[0]('meanwhile')).toBe('injected')
    await running
    expect(capture.withdrawn()).toBe(1)
  })

  it('is not opened by updates that are not turn content', async () => {
    const w = world({
      script: {
        ...STEERABLE,
        prompt: {
          emit: [
            { kind: 'update', update: { sessionUpdate: 'current_mode_update', currentModeId: 'default' } },
            { kind: 'update', update: { sessionUpdate: 'available_commands_update', availableCommands: [] } },
            // The Claude adapter republishes an earlier turn's tasks before it registers this turn.
            { kind: 'update', update: { sessionUpdate: 'plan', entries: [{ content: 'An earlier task', priority: 'medium', status: 'pending' }] } },
            // A point all three updates were read by: the ask comes behind them on the same pipe.
            { kind: 'permission' },
            chunk('Started. '), { kind: 'awaitSteer' }, { kind: 'delay', ms: 100 }
          ]
        }
      }
    })
    const capture = steerCapture()
    const running = w.run({ registerSteer: capture.registerSteer })
    const asked = await askedFor(w)
    expect(capture.offered).toEqual([])
    w.driver.respond(
      { requestId: asked.requestId, chatId: CHAT_ID, agentId: AGENT_ID, kind: 'permission' },
      { kind: 'permission', reply: 'once' }
    )
    await steerable(w, capture)
    expect(await capture.offered[0]('meanwhile')).toBe('injected')
    await running
  })

  it('is not withdrawn by a status-less update for a tool call it never saw start', async () => {
    const w = world({
      script: { ...STEERABLE, prompt: { emit: [chunk('Before. '), toolUpdate(), chunk('After. '), { kind: 'awaitSteer' }, { kind: 'delay', ms: 100 }] } }
    })
    const capture = steerCapture()
    const running = w.run({ registerSteer: capture.registerSteer })
    await waitFor(() => w.events.some((event) => event.type === 'delta' && event.text === 'After. '), 'the text after the update')
    expect(capture.withdrawn()).toBe(0)
    expect(await capture.offered[0]('2+2?')).toBe('injected')
    await running
    expect(capture.offered).toHaveLength(1)
  })

  it('is not withdrawn for the turn by a tool call that arrived before its prompt went out', async () => {
    // Emitted before `session/new` answers, so it waits in the pre-bind pen and
    // the bind flushes it into this turn: as the tail of a stopped turn would
    // reach a session bound again, a call that never ends.
    const w = world({
      script: {
        ...STEERABLE,
        newSession: { emit: [toolCall('in_progress')] },
        prompt: { emit: [chunk('Started. '), { kind: 'awaitSteer' }, { kind: 'delay', ms: 100 }] }
      }
    })
    const capture = steerCapture()
    const running = w.run({ registerSteer: capture.registerSteer })
    await waitFor(() => w.events.some((event) => event.type === 'delta' && event.text === 'Started. '), 'the turn’s first text')
    expect(capture.offered).toHaveLength(1)
    expect(capture.withdrawn()).toBe(0)
    expect(await capture.offered[0]('meanwhile')).toBe('injected')
    await running
  })
})

describe('a remembered session', () => {
  it('loads it, and does not put its replay into this turn’s transcript', async () => {
    // `session/load` replays the whole conversation as `session/update`s before
    // it answers — verified on OpenCode 1.18.27. Ingesting that would append
    // the entire history to this turn's message.
    const w = world({
      remembered: 'ses_old',
      script: {
        loadSession: {
          emit: [
            {
              kind: 'update',
              sessionId: 'ses_old',
              update: {
                sessionUpdate: 'user_message_chunk',
                content: { type: 'text', text: 'the previous question' }
              }
            },
            {
              kind: 'update',
              sessionId: 'ses_old',
              update: {
                sessionUpdate: 'agent_message_chunk',
                content: { type: 'text', text: 'the previous answer' }
              }
            }
          ]
        },
        prompt: {
          emit: [
            {
              kind: 'update',
              sessionId: 'ses_old',
              update: {
                sessionUpdate: 'agent_message_chunk',
                content: { type: 'text', text: 'the new answer' }
              }
            }
          ]
        }
      }
    })
    const result = await w.run()
    expect(w.fake.received('session/load')[0].params?.sessionId).toBe('ses_old')
    expect(w.fake.received('session/new')).toHaveLength(0)
    expect(result.text).toContain('the new answer')
    expect(result.text).not.toContain('the previous answer')
    expect(result.text).not.toContain('the previous question')
  })

  it('does not let traffic buffered before the bind into this turn either', async () => {
    // The pre-bind pen holds what arrived for a session nobody was listening
    // to — the tail of a turn the user stopped, say — and `bindSession` flushes
    // it *synchronously*. So the replay gate has to be closed before the bind,
    // not after it, or a stop followed by a resend in the same chat would fold
    // the stopped turn's last chunks into the new one. Emitted here at
    // `initialize`, which is the one moment nothing can be bound yet.
    const w = world({
      remembered: 'ses_fake',
      script: {
        initialize: {
          emit: [
            {
              kind: 'update',
              sessionId: 'ses_fake',
              update: {
                sessionUpdate: 'agent_message_chunk',
                content: { type: 'text', text: 'TAIL OF A STOPPED TURN' }
              }
            }
          ]
        },
        prompt: {
          emit: [
            {
              kind: 'update',
              sessionId: 'ses_fake',
              update: {
                sessionUpdate: 'agent_message_chunk',
                content: { type: 'text', text: 'the new answer' }
              }
            }
          ]
        }
      }
    })
    const result = await w.run()
    expect(result.text).toContain('the new answer')
    expect(result.text).not.toContain('TAIL OF A STOPPED TURN')
  })

  it('starts a fresh one when the agent has forgotten it, without explaining', async () => {
    const w = world({
      remembered: 'ses_gone',
      script: {
        loadSession: { error: { code: -32602, message: 'no conversation found for ses_gone' } },
        ...SAYS_HELLO
      }
    })
    const result = await w.run()
    expect(result.error).toBeUndefined()
    expect(result.contextId).toBe('ses_fake')
    expect(w.fake.received('session/new')).toHaveLength(1)
    // The user asked a question, not to be told about our bookkeeping.
    expect(result.notices).toEqual([])
  })
})

/**
 * A world whose sessions are watched between turns: the sink records what it
 * was handed, and every connection the pool hands out reports which sessions
 * are observed right now.
 */
function observedWorld(options: WorldOptions = {}): World & {
  scopes: SessionTrafficScope[]
  updates: { sessionId: string; kind: string; text?: string }[]
  asks: string[]
  observed: Set<string>
  connections: AcpConnection[]
} {
  const connections: AcpConnection[] = []
  const scopes: SessionTrafficScope[] = []
  const updates: { sessionId: string; kind: string; text?: string }[] = []
  const asks: string[] = []
  const observed = new Set<string>()
  const pool = createAcpProcessPool({ start: startAcpConnection, ...(options.reapMs ? { idleReapMs: options.reapMs } : {}) })
  const patched = new WeakSet<AcpConnection>()
  const watched: AcpProcessPool = {
    ...pool,
    acquire: async (...args) => {
      const connection = await pool.acquire(...args)
      if (!patched.has(connection)) {
        patched.add(connection)
        connections.push(connection)
        const observe = connection.observeSession
        connection.observeSession = (sessionId, observer) => {
          observed.add(sessionId)
          const unobserve = observe(sessionId, observer)
          return () => { observed.delete(sessionId); unobserve() }
        }
      }
      return connection
    }
  }
  const sessionTraffic = (scope: SessionTrafficScope): SessionTrafficSink => {
    scopes.push(scope)
    return {
      update: (n) => {
        const update = n.update as { sessionUpdate: string; content?: { text?: string } }
        updates.push({ sessionId: n.sessionId, kind: update.sessionUpdate, text: update.content?.text })
      },
      permission: async () => { asks.push('permission'); return { outcome: { outcome: 'cancelled' } } },
      elicitation: async () => { asks.push('elicitation'); return { action: 'cancel' } }
    }
  }
  const w = world({ ...options, deps: { pool: watched, sessionTraffic, ...options.deps } })
  return Object.assign(w, { scopes, updates, asks, observed, connections })
}

describe('a session between turns', () => {
  it('is listened to once the turn ends, under the chat and agent that own it', async () => {
    const w = observedWorld({ script: SAYS_HELLO })
    await w.run()

    expect([...w.observed]).toEqual(['ses_fake'])
    expect(w.scopes).toEqual([
      { agentId: AGENT_ID, chatId: CHAT_ID, sessionId: 'ses_fake', launcherId: 'opencode' }
    ])
  })

  it('hands what the agent says between turns to the sink, and a turn elsewhere is not disturbed', async () => {
    // Chat 1's session is idle; chat 2's turn, on the same process, is the
    // moment the fake talks to it — the shape of a background job finishing
    // after chat 1's prompt returned.
    const w = observedWorld({
      script: {
        ...SAYS_HELLO,
        loadSession: {
          emit: [
            {
              kind: 'update',
              sessionId: 'ses_fake',
              update: { sessionUpdate: 'agent_message_chunk', messageId: 'm1', content: { type: 'text', text: 'Merged.' } }
            },
            { kind: 'permission', sessionId: 'ses_fake' }
          ]
        }
      }
    })
    await w.run()
    w.sessions.set('chat-2', 'ses_two')
    const started = Date.now()
    const second = await w.run({ chatId: 'chat-2' })

    expect(second.error).toBeUndefined()
    expect(second.text).not.toContain('Merged.')
    expect(w.updates).toEqual([{ sessionId: 'ses_fake', kind: 'agent_message_chunk', text: 'Merged.' }])
    // Answered by the sink, not after the ten-second pre-bind window.
    expect(w.asks).toEqual(['permission'])
    expect(w.fake.answers('session/request_permission')[0].result).toEqual({ outcome: { outcome: 'cancelled' } })
    expect(Date.now() - started).toBeLessThan(5_000)
    expect([...w.observed].sort()).toEqual(['ses_fake', 'ses_two'])
  })

  it('does not take the load replay away from the next turn on the same session', async () => {
    // The hazard: the observer armed after turn 1 must not swallow what
    // `session/load` replays for turn 2 — that traffic is turn 2's, and turn 2
    // drops it itself.
    const w = observedWorld({
      script: {
        ...SAYS_HELLO,
        loadSession: {
          emit: [
            {
              kind: 'update',
              sessionId: 'ses_fake',
              update: { sessionUpdate: 'user_message_chunk', content: { type: 'text', text: 'the previous question' } }
            }
          ]
        }
      }
    })
    await w.run()
    const second = await w.run()

    expect(w.fake.received('session/load')).toHaveLength(1)
    expect(second.text).not.toContain('the previous question')
    expect(w.updates).toEqual([])
    // And listened to again once turn 2 is over.
    expect([...w.observed]).toEqual(['ses_fake'])
    expect(w.scopes).toHaveLength(2)
  })

  it('refuses a permission asked between turns at once when nothing is wired to the listener', async () => {
    const w = world({
      script: {
        ...SAYS_HELLO,
        loadSession: { emit: [{ kind: 'permission', sessionId: 'ses_fake' }] }
      }
    })
    await w.run()
    w.sessions.set('chat-2', 'ses_two')
    const started = Date.now()
    const second = await w.run({ chatId: 'chat-2' })

    expect(second.error).toBeUndefined()
    expect(w.fake.answers('session/request_permission')[0].result).toEqual({ outcome: { outcome: 'cancelled' } })
    // Not the pre-bind pen's ten seconds.
    expect(Date.now() - started).toBeLessThan(5_000)
  })

  it('stops listening to a session a turn replaced', async () => {
    const w = observedWorld({ script: { ...SAYS_HELLO, newSession: { sessionId: 'ses_fresh' } }, remembered: 'ses_old' })
    await w.run()
    expect([...w.observed]).toEqual(['ses_old'])

    // The engine has forgotten it by the next turn, which starts a fresh one.
    w.connections[0].loadSession = async () => { throw new Error('no conversation found for ses_old') }
    const second = await w.run()

    expect(second.contextId).toBe('ses_fresh')
    expect([...w.observed]).toEqual(['ses_fresh'])
  })

  it('keeps listening to a session a turn replaced while its process lives, until the chat is forgotten', async () => {
    // An engine that cannot load sessions starts a fresh one each turn; the
    // one it replaced is still in the process and may still be running work.
    const w = observedWorld({
      script: { ...SAYS_HELLO, initialize: { response: { agentCapabilities: {} } }, newSession: { sessionId: 'ses_first' } }
    })
    await w.run()
    expect([...w.observed]).toEqual(['ses_first'])

    w.connections[0].newSession = async () => ({ sessionId: 'ses_second' })
    const second = await w.run()

    expect(w.fake.received('session/load')).toHaveLength(0)
    expect(second.contextId).toBe('ses_second')
    expect([...w.observed].sort()).toEqual(['ses_first', 'ses_second'])
    expect(w.scopes.map((scope) => [scope.sessionId, scope.chatId])).toContainEqual(['ses_first', CHAT_ID])

    ;(w.driver as AcpDriver).forgetChatSessions(CHAT_ID)
    expect([...w.observed]).toEqual([])
  })

  it('stops listening to a chat’s sessions when the chat is forgotten, and only that agent’s when one is named', async () => {
    const w = observedWorld({ script: SAYS_HELLO })
    await w.run()
    w.sessions.set('chat-2', 'ses_two')
    await w.run({ chatId: 'chat-2' })
    expect([...w.observed].sort()).toEqual(['ses_fake', 'ses_two'])
    const driver = w.driver as AcpDriver

    driver.forgetChatSessions(CHAT_ID, 'another-agent')
    expect([...w.observed].sort()).toEqual(['ses_fake', 'ses_two'])

    driver.forgetChatSessions(CHAT_ID, AGENT_ID)
    expect([...w.observed]).toEqual(['ses_two'])

    driver.forgetChatSessions('chat-2')
    expect([...w.observed]).toEqual([])
    // Nothing left to forget is not an error.
    expect(() => driver.forgetChatSessions('chat-2')).not.toThrow()
  })

  it('stops listening when the process goes away', async () => {
    const w = observedWorld({ script: SAYS_HELLO })
    await w.run()
    expect(w.observed.size).toBe(1)

    w.pool.retire(AGENT_ID)
    await waitFor(() => w.observed.size === 0, 'the observer to be dropped')
  })
})


const RUN_SCOPE = { profileUserId: 'profile-1', settingsUserId: 'settings-1' }

/** The recorded unprompted Claude turn, as steps the fake sends for `ses_fake`. */
const FOLLOW_UP_STEPS: FakeAcpStep[] = (followUpFixture.notifications as { update: Record<string, unknown> }[])
  .map((frame) => ({ kind: 'update', sessionId: 'ses_fake', update: frame.update }))

const say = (text: string, messageId?: string): FakeAcpStep => ({
  kind: 'update',
  sessionId: 'ses_fake',
  update: { sessionUpdate: 'agent_message_chunk', ...(messageId ? { messageId } : {}), content: { type: 'text', text } }
})
const COSTED_USAGE: FakeAcpStep = {
  kind: 'update',
  sessionId: 'ses_fake',
  update: { sessionUpdate: 'usage_update', used: 10, size: 100, cost: { amount: 0.01, currency: 'USD' } }
}
const PLAIN_USAGE: FakeAcpStep = { kind: 'update', sessionId: 'ses_fake', update: { sessionUpdate: 'usage_update', used: 10, size: 100 } }

/** A prompt that says hello and ends; then, on its own, the agent sends `after`. */
const thenOnItsOwn = (after: FakeAcpStep[]): FakeAcpScript => ({ prompt: { ...SAYS_HELLO.prompt, after } })

/** What a follow-up turn streamed through its io. */
interface FollowUpIo {
  events: RunEvent[]
  controller: AbortController
  snapshot: () => TurnSnapshot | undefined
  io: Parameters<FollowUpRequest['run']>[0]
}

function followUpIo(): FollowUpIo {
  const events: RunEvent[] = []
  const controller = new AbortController()
  let read: (() => TurnSnapshot) | undefined
  return {
    events,
    controller,
    snapshot: () => read?.(),
    io: { signal: controller.signal, onEvent: (event) => void events.push(event), registerSnapshot: (r) => { read = r } }
  }
}

function followUpWorld(options: WorldOptions = {}): ReturnType<typeof observedWorld> & { requests: FollowUpRequest[] } {
  const requests: FollowUpRequest[] = []
  const w = observedWorld({
    ...options,
    deps: { openFollowUp: (request) => void requests.push(request), followUpQuietMs: 60_000, ...options.deps }
  })
  return Object.assign(w, { requests })
}

const textOf = (result: { parts: { kind: string; text: string }[] }): string =>
  result.parts.filter((part) => part.kind === 'text').map((part) => part.text).join('')

describe('MCP and ACP follow-up ownership', () => {
  it.each(['mcp-first', 'acp-first'] as const)('binds exactly one follow-up when %s wakes the session', async (order) => {
    let wake!: () => boolean
    const prepare = vi.fn(async (_user, _agent, _input, _plan, _stop, requestWake) => {
      wake = requestWake
      return { close() {}, hasCalls: () => false }
    }) as NonNullable<AcpDriverDeps['prepareConductor']>
    const w = followUpWorld({ script: order === 'acp-first' ? thenOnItsOwn([say('Background', 'background')]) : SAYS_HELLO,
      deps: { prepareConductor: prepare, followUpQuietMs: 50 } })
    await w.run({ runScope: RUN_SCOPE })
    if (order === 'acp-first') await waitFor(() => w.requests[0], 'ACP follow-up')
    expect(wake()).toBe(true)
    const request = await waitFor(() => w.requests[0], 'MCP follow-up')
    await request.run(followUpIo().io)
    expect(prepare).toHaveBeenCalledTimes(2)
    expect(w.requests).toHaveLength(1)
    expect(w.fake.received('session/prompt')).toHaveLength(1)
  })
})

describe('a turn the agent starts on its own', () => {
  it('is asked for in the chat’s scope and driven to the usage update that carries a cost', async () => {
    const w = followUpWorld({ script: thenOnItsOwn(FOLLOW_UP_STEPS), launcher: 'claude' })
    const first = await w.run({ runScope: RUN_SCOPE })
    expect(first.text).toBe('Hello.')

    const request = await waitFor(() => w.requests[0], 'the follow-up request')
    expect(request).toMatchObject({ chatId: CHAT_ID, agentId: AGENT_ID, driverId: 'acp', scope: RUN_SCOPE })
    expect(w.scopes[0]).toMatchObject(RUN_SCOPE)

    const f = followUpIo()
    const started = Date.now()
    const result = await request.run(f.io)

    // The marker, not the sixty-second quiet spell.
    expect(Date.now() - started).toBeLessThan(5_000)
    expect(result.error).toBeUndefined()
    expect(result.taskState).toBeUndefined()
    expect(textOf(result)).toBe('Output: `probe-done`')
    expect(result.parts.some((part) => part.kind === 'tool' || part.toolName !== undefined)).toBe(true)
    expect(f.events.some((event) => event.type === 'delta')).toBe(true)
    // The task updates before the trigger went to the activity hook, not the turn.
    expect(w.updates.map((u) => u.kind)).toEqual(['async_task_state_update', 'async_task_state_update', 'usage_update'])
    // Listening again afterwards, and nothing else was asked for.
    await settle(100)
    expect(w.requests).toHaveLength(1)
    expect([...w.observed]).toEqual(['ses_fake'])
  })

  it('reports its cost to the session once, from the costed usage update alone', async () => {
    const changes: SessionTelemetryChange[] = []
    const w = followUpWorld({ script: thenOnItsOwn(FOLLOW_UP_STEPS), launcher: 'claude',
      deps: { telemetry: { report: (_chatId, change) => void changes.push(change) } } })
    await w.run({ runScope: RUN_SCOPE })
    changes.length = 0
    const request = await waitFor(() => w.requests[0], 'the follow-up request')
    const result = await request.run(followUpIo().io)
    expect(result.telemetry).toMatchObject({ tokenScope: 'none', costUsd: 0.0407752, contextUsedAfter: 16_470 })
    const turns = changes.filter((change) => change.type === 'turn')
    expect(turns).toHaveLength(1)
    expect(turns[0]).toMatchObject({ sessionId: 'ses_fake', message: { costUsd: 0.0407752 } })
  })

  it('takes its tokens from the raw result when the stream carries one', async () => {
    const changes: SessionTelemetryChange[] = []
    const result = resultMessage({ costs: { 'claude-sonnet-5-20260101': 0.02 }, usage: { input: 7, output: 90, cacheRead: 12_000, cacheWrite: 300 } })
    const w = followUpWorld({
      script: thenOnItsOwn([say('Working', 'm1'), { kind: 'delay', ms: 300 },
        { kind: 'notify', method: '_claude/sdkMessage', params: sdkParams(result, 'ses_fake') }, COSTED_USAGE]),
      launcher: 'claude',
      deps: { telemetry: { report: (_chatId, change) => void changes.push(change) } }
    })
    await w.run({ runScope: RUN_SCOPE })
    const request = await waitFor(() => w.requests[0], 'the follow-up request')
    const turn = await request.run(followUpIo().io)
    expect(turn.telemetry).toMatchObject({ tokens: { input: 7, output: 90, cacheRead: 12_000, cacheWrite: 300 }, tokenScope: 'turn', requests: 2 })
  })

  it('keeps the raw frames that arrived before it was bound: its request, the cache clock and an early result', async () => {
    const changes: SessionTelemetryChange[] = []
    const result = resultMessage({ costs: { 'claude-sonnet-5-20260101': 0.02 }, usage: { input: 7, output: 90, cacheRead: 12_000, cacheWrite: 300 }, numTurns: 1 })
    const raw = (message: object): FakeAcpStep => ({ kind: 'notify', method: '_claude/sdkMessage', params: sdkParams(message, 'ses_fake') })
    const w = followUpWorld({
      // A raw frame before the trigger opens nothing and is dropped; the ones after it are the follow-up's.
      script: thenOnItsOwn([raw(assistantMessage({ id: 'msg_before', input: 1 })), say('Working', 'm1'),
        raw(assistantMessage({ id: 'msg_1', input: 3, cacheRead: 15_000, write1h: 2_000 })), raw(result), COSTED_USAGE]),
      launcher: 'claude',
      deps: { telemetry: { report: (_chatId, change) => void changes.push(change) } }
    })
    await w.run({ runScope: RUN_SCOPE })
    const request = await waitFor(() => w.requests[0], 'the follow-up request')
    // Everything reaches the gate before the follow-up is bound.
    await settle(200)
    changes.length = 0
    const turn = await request.run(followUpIo().io)
    expect(turn.telemetry).toMatchObject({ tokens: { input: 7, output: 90, cacheRead: 12_000, cacheWrite: 300 }, tokenScope: 'turn', requests: 1 })
    const requests = changes.filter((change) => change.type === 'request')
    expect(requests).toHaveLength(1)
    expect(requests[0]).toMatchObject({ input: 17_003, cacheWrite1h: 2_000 })
  })

  it('is not ended by a usage update without a cost', async () => {
    const w = followUpWorld({
      script: thenOnItsOwn([say('one ', 'm1'), PLAIN_USAGE, { kind: 'delay', ms: 150 }, say('two', 'm1'), COSTED_USAGE])
    })
    await w.run({ runScope: RUN_SCOPE })
    const request = await waitFor(() => w.requests[0], 'the follow-up request')
    const result = await request.run(followUpIo().io)
    expect(textOf(result)).toBe('one two')
  })

  it('ends after a quiet spell when the engine sends no end marker', async () => {
    const w = followUpWorld({ script: thenOnItsOwn([say('Merged.', 'm1')]), deps: { followUpQuietMs: 250 } })
    await w.run({ runScope: RUN_SCOPE })
    const request = await waitFor(() => w.requests[0], 'the follow-up request')
    const started = Date.now()
    const result = await request.run(followUpIo().io)
    expect(Date.now() - started).toBeGreaterThanOrEqual(240)
    expect(result.error).toBeUndefined()
    expect(textOf(result)).toBe('Merged.')
    expect(w.fake.received('session/cancel')).toHaveLength(0)
  })

  it('does not count a tool call still running as quiet, and gives up at the ceiling', async () => {
    const w = followUpWorld({
      script: thenOnItsOwn([
        { kind: 'update', sessionId: 'ses_fake', update: { sessionUpdate: 'tool_call', toolCallId: 'call_bg', title: 'Bash', status: 'in_progress' } }
      ]),
      deps: { followUpQuietMs: 100, turnCeilingMs: 600 }
    })
    await w.run({ runScope: RUN_SCOPE })
    const request = await waitFor(() => w.requests[0], 'the follow-up request')
    const started = Date.now()
    const result = await request.run(followUpIo().io)

    expect(Date.now() - started).toBeGreaterThanOrEqual(590)
    expect(result.error?.message).toBe('The agent stopped responding and the turn was ended.')
    expect(w.fake.received('session/cancel')).toHaveLength(1)
  })

  it('sends session/cancel on Stop and ends canceled once the agent ends its turn', async () => {
    const w = followUpWorld({
      script: thenOnItsOwn([say('working', 'm1'), { kind: 'awaitCancel', sessionId: 'ses_fake' }, COSTED_USAGE])
    })
    await w.run({ runScope: RUN_SCOPE })
    const request = await waitFor(() => w.requests[0], 'the follow-up request')
    const f = followUpIo()
    const running = request.run(f.io)
    await waitFor(() => f.events.some((event) => event.type === 'delta'), 'the first delta')

    f.controller.abort()
    const result = await running
    expect(w.fake.received('session/cancel')).toHaveLength(1)
    expect(result.taskState).toBe('canceled')
    expect(result.stopReason).toBe('canceled')
    expect(result.error).toBeUndefined()
    expect(textOf(result)).toBe('working')
    // Acknowledged by the end marker: the process was not retired.
    expect(w.pool.status(AGENT_ID).state).toBe('running')
  })

  it('parks a permission asked between turns, posts it for the Inbox, and takes the answer through respond', async () => {
    const w = followUpWorld({ script: thenOnItsOwn([{ kind: 'permission', sessionId: 'ses_fake' }, say('Merged.', 'm1'), COSTED_USAGE]) })
    await w.run({ runScope: RUN_SCOPE })
    const request = await waitFor(() => w.requests[0], 'the follow-up request')
    const f = followUpIo()
    const running = request.run(f.io)

    const asked = await waitFor(
      () => f.events.find((event): event is Extract<RunEvent, { type: 'needs_input' }> => event.type === 'needs_input'),
      'the needs_input event'
    )
    // Not refused after ten seconds, nor at once.
    await settle(100)
    expect(w.fake.answers('session/request_permission')).toHaveLength(0)
    expect(asked.resume).toBe('reply')

    const outcome = w.driver.respond(
      { requestId: asked.requestId, chatId: CHAT_ID, agentId: AGENT_ID, kind: 'permission' },
      { kind: 'permission', reply: 'once' }
    )
    expect(outcome).toEqual({ delivered: true })
    const result = await running
    expect(w.fake.answers('session/request_permission')[0].result).toEqual({ outcome: { outcome: 'selected', optionId: 'once' } })
    expect(f.events.some((event) => event.type === 'input_resolved')).toBe(true)
    expect(result.text).toContain('Merged.')
  })

  it('drops a late update for the saved turn’s tool call and a text chunk with no message id, and opens nothing', async () => {
    const w = followUpWorld({
      script: {
        prompt: {
          emit: [
            { kind: 'update', update: { sessionUpdate: 'tool_call', toolCallId: 'call_exec', title: 'exec', status: 'in_progress' } },
            { kind: 'update', update: { sessionUpdate: 'agent_message_chunk', messageId: 'm0', content: { type: 'text', text: 'Started.' } } }
          ],
          after: [
            { kind: 'update', sessionId: 'ses_fake', update: { sessionUpdate: 'tool_call_update', toolCallId: 'call_exec', status: 'completed' } },
            say('**Task stopped by user:** sleep 120.')
          ]
        }
      }
    })
    await w.run({ runScope: RUN_SCOPE })
    await settle(300)
    expect(w.requests).toEqual([])
    expect(w.updates).toEqual([])
  })

  it('opens two follow-ups for two unprompted turns in a row', async () => {
    const w = followUpWorld({ script: thenOnItsOwn([say('first', 'm1'), COSTED_USAGE, say('second', 'm2'), COSTED_USAGE]) })
    await w.run({ runScope: RUN_SCOPE })
    // Let both turns arrive before the first is opened: the second is what the
    // first leaves behind.
    await settle(200)
    const one = await waitFor(() => w.requests[0], 'the first request')
    const firstResult = await one.run(followUpIo().io)
    const two = await waitFor(() => w.requests[1], 'the second request')
    const secondResult = await two.run(followUpIo().io)

    expect(textOf(firstResult)).toBe('first')
    expect(textOf(secondResult)).toBe('second')
    expect(w.requests).toHaveLength(2)
  })

  it('hands what was held to a turn the user starts on the same session, and opens nothing for it', async () => {
    const w = followUpWorld({ script: thenOnItsOwn([say('Merged.', 'm1'), { kind: 'permission', sessionId: 'ses_fake' }]) })
    await w.run({ runScope: RUN_SCOPE })
    const request = await waitFor(() => w.requests[0], 'the follow-up request')
    // Not opened (the chat is busy, say); the ask reaches the gate meanwhile.
    await settle(200)
    expect(w.fake.answers('session/request_permission')).toHaveLength(0)

    const second = await w.run({ runScope: RUN_SCOPE })
    expect(request.wanted()).toBe(false)
    expect(second.text).toContain('Merged.')
    expect(second.text).toContain('Hello.')
    // The held ask was the second turn's: parked there, and released when it ended.
    const answer = await waitFor(() => w.fake.answers('session/request_permission')[0], 'the ask to be answered')
    expect(answer.result).toEqual({ outcome: { outcome: 'selected', optionId: 'reject' } })
  })

  it('refuses a held ask and stops listening when the follow-up is abandoned', async () => {
    const w = followUpWorld({ script: thenOnItsOwn([{ kind: 'permission', sessionId: 'ses_fake' }]) })
    await w.run({ runScope: RUN_SCOPE })
    const request = await waitFor(() => w.requests[0], 'the follow-up request')

    request.abandon('the chat no longer answers to this agent')
    await waitFor(() => w.fake.answers('session/request_permission')[0], 'the refusal')
    expect(w.fake.answers('session/request_permission')[0].result).toEqual({ outcome: { outcome: 'cancelled' } })
    expect([...w.observed]).toEqual([])
    expect(request.wanted()).toBe(false)
  })

  it('opens nothing for a turn with no chat scope of its own, and the listener still hears it', async () => {
    const w = followUpWorld({ script: thenOnItsOwn([say('Merged.', 'm1')]) })
    await w.run()
    await waitFor(() => w.updates.length > 0, 'the update to reach the listener')
    expect(w.requests).toEqual([])
    expect(w.updates).toEqual([{ sessionId: 'ses_fake', kind: 'agent_message_chunk', text: 'Merged.' }])
  })

  it('offers what it streamed so far, for the save at quit', async () => {
    const w = followUpWorld({ script: thenOnItsOwn([say('half a reply', 'm1'), { kind: 'awaitCancel', sessionId: 'ses_fake' }]) })
    await w.run({ runScope: RUN_SCOPE })
    const request = await waitFor(() => w.requests[0], 'the follow-up request')
    const f = followUpIo()
    const running = request.run(f.io)
    await waitFor(() => f.snapshot()?.parts.length, 'a snapshot with parts')
    expect(f.snapshot()!.parts.map((part) => part.text).join('')).toBe('half a reply')
    f.controller.abort()
    await running
  })

  it('ends with an error when the process goes away under it', async () => {
    const w = followUpWorld({ script: thenOnItsOwn([say('working', 'm1'), { kind: 'delay', ms: 200 }, { kind: 'exit', code: 1 }]) })
    await w.run({ runScope: RUN_SCOPE })
    const request = await waitFor(() => w.requests[0], 'the follow-up request')
    const f = followUpIo()
    const result = await request.run(f.io)
    expect(result.error?.message).toBe(ACP_FOLLOW_UP_EXITED)
    expect(textOf(result)).toBe('working')
  })
})

describe('a turn the agent starts on its own, at the edges', () => {
  it('keeps the process from the reaper while it waits to be opened, and lets go once it is dropped', async () => {
    const w = followUpWorld({ script: thenOnItsOwn([say('Merged.', 'm1')]), reapMs: 150 })
    await w.run({ runScope: RUN_SCOPE })
    const request = await waitFor(() => w.requests[0], 'the follow-up request')
    expect(w.pool.held(AGENT_ID)).toBe(true)
    // Well past the reap: the chat is busy, say, and the follow-up waits.
    await settle(500)
    expect(w.pool.status(AGENT_ID).state).toBe('running')

    request.abandon('the chat is in the trash')
    expect(w.pool.held(AGENT_ID)).toBe(false)
    await waitFor(() => w.pool.status(AGENT_ID).state === 'stopped', 'the idle reap')
  })

  it('lets go of the waiting hold once the follow-up runs, and the run’s own hold once it ends', async () => {
    const w = followUpWorld({ script: thenOnItsOwn([say('Merged.', 'm1'), COSTED_USAGE]), launcher: 'claude' })
    await w.run({ runScope: RUN_SCOPE })
    const request = await waitFor(() => w.requests[0], 'the follow-up request')
    await request.run(followUpIo().io)
    expect(w.pool.held(AGENT_ID)).toBe(false)
  })

  it('lets go of the waiting hold when a user turn takes the traffic', async () => {
    const w = followUpWorld({ script: thenOnItsOwn([say('Merged.', 'm1')]) })
    await w.run({ runScope: RUN_SCOPE })
    await waitFor(() => w.requests[0], 'the follow-up request')
    await w.run({ runScope: RUN_SCOPE })
    expect(w.pool.held(AGENT_ID)).toBe(false)
  })

  it('lets go of the waiting hold when the process exits', async () => {
    const w = followUpWorld({ script: thenOnItsOwn([say('Merged.', 'm1'), { kind: 'delay', ms: 200 }, { kind: 'exit', code: 1 }]) })
    await w.run({ runScope: RUN_SCOPE })
    const request = await waitFor(() => w.requests[0], 'the follow-up request')
    expect(w.pool.held(AGENT_ID)).toBe(true)
    await waitFor(() => w.pool.status(AGENT_ID).state === 'exited', 'the exit')
    await waitFor(() => !w.pool.held(AGENT_ID), 'the hold to be released')
    expect(request.wanted()).toBe(false)
  })

  it('is not ended by a pause on an engine that marks its turns’ end', async () => {
    const w = followUpWorld({
      script: thenOnItsOwn([say('one ', 'm1'), { kind: 'delay', ms: 500 }, say('two', 'm1'), COSTED_USAGE]),
      launcher: 'claude',
      deps: { followUpQuietMs: 100 }
    })
    await w.run({ runScope: RUN_SCOPE })
    const request = await waitFor(() => w.requests[0], 'the follow-up request')
    const result = await request.run(followUpIo().io)
    expect(textOf(result)).toBe('one two')
    await settle(100)
    expect(w.requests).toHaveLength(1)
  })

  it('on an engine that marks its turns’ end, waits for the marker rather than a quiet spell, up to the ceiling', async () => {
    const w = followUpWorld({
      script: thenOnItsOwn([say('thinking', 'm1')]),
      costedEnd: true,
      deps: { followUpQuietMs: 100, turnCeilingMs: 600 }
    })
    await w.run({ runScope: RUN_SCOPE })
    const request = await waitFor(() => w.requests[0], 'the follow-up request')
    const started = Date.now()
    const result = await request.run(followUpIo().io)
    expect(Date.now() - started).toBeGreaterThanOrEqual(590)
    expect(result.error?.message).toBe('The agent stopped responding and the turn was ended.')
  })

  it('ends canceled on a Stop the agent never acknowledges, and leaves the process running', async () => {
    const w = followUpWorld({ script: thenOnItsOwn([say('working', 'm1'), { kind: 'awaitCancel', sessionId: 'ses_fake' }]) })
    await w.run({ runScope: RUN_SCOPE })
    const request = await waitFor(() => w.requests[0], 'the follow-up request')
    const f = followUpIo()
    const running = request.run(f.io)
    await waitFor(() => f.events.some((event) => event.type === 'delta'), 'the first delta')

    f.controller.abort()
    const result = await running
    expect(result.taskState).toBe('canceled')
    expect(result.error).toBeUndefined()
    expect(textOf(result)).toBe('working')
    await settle(200)
    expect(w.pool.status(AGENT_ID).state).toBe('running')
    expect(w.connections[0].alive).toBe(true)
  })

  it('gives held updates back when the user turn that took them failed first, and opens a follow-up for them', async () => {
    // An engine that cannot load sessions: the second turn asks for a fresh
    // one, and that fails before the held traffic is replayed.
    const w = followUpWorld({
      script: {
        ...thenOnItsOwn([say('Merged.', 'm1'), { kind: 'permission', sessionId: 'ses_fake' }, COSTED_USAGE]),
        initialize: { response: { agentCapabilities: {} } }
      }
    })
    await w.run({ runScope: RUN_SCOPE })
    const first = await waitFor(() => w.requests[0], 'the follow-up request')
    // The ask reaches the gate too.
    await settle(300)

    w.connections[0].newSession = async () => { throw new Error('quota exceeded') }
    const failed = await w.run({ runScope: RUN_SCOPE })
    expect(failed.error).toBeDefined()
    expect(first.wanted()).toBe(false)
    // The ask was refused; the update opened a new follow-up.
    const answer = await waitFor(() => w.fake.answers('session/request_permission')[0], 'the refusal')
    expect(answer.result).toEqual({ outcome: { outcome: 'cancelled' } })
    const second = await waitFor(() => w.requests[1], 'the second follow-up request')
    const result = await second.run(followUpIo().io)
    expect(textOf(result)).toBe('Merged.')
  })

  it('keeps listening to the session when a follow-up is dropped because the chat stayed busy', async () => {
    const w = followUpWorld({
      script: thenOnItsOwn([{ kind: 'permission', sessionId: 'ses_fake' }, { kind: 'delay', ms: 300 }, say('again', 'm2'), COSTED_USAGE])
    })
    await w.run({ runScope: RUN_SCOPE })
    const first = await waitFor(() => w.requests[0], 'the follow-up request')

    first.abandon('the chat stayed busy', { keepListening: true })
    const answer = await waitFor(() => w.fake.answers('session/request_permission')[0], 'the refusal')
    expect(answer.result).toEqual({ outcome: { outcome: 'cancelled' } })
    expect(first.wanted()).toBe(false)
    expect([...w.observed]).toEqual(['ses_fake'])
    expect(w.pool.held(AGENT_ID)).toBe(false)

    const second = await waitFor(() => w.requests[1], 'the next follow-up request')
    expect(textOf(await second.run(followUpIo().io))).toBe('again')
  })

  it('ends at once, with nothing, when a user turn took its traffic before it ran', async () => {
    const w = followUpWorld({ script: thenOnItsOwn([say('Merged.', 'm1')]) })
    await w.run({ runScope: RUN_SCOPE })
    const request = await waitFor(() => w.requests[0], 'the follow-up request')
    await w.run({ runScope: RUN_SCOPE })

    const started = Date.now()
    const result = await request.run(followUpIo().io)
    expect(Date.now() - started).toBeLessThan(1_000)
    expect(result.parts).toEqual([])
    expect(w.pool.held(AGENT_ID)).toBe(false)
  })

  it('leaves no listener on the process for a follow-up that ended', async () => {
    const w = followUpWorld({ script: thenOnItsOwn([say('first', 'm1'), COSTED_USAGE, say('second', 'm2'), COSTED_USAGE]), launcher: 'claude' })
    await w.run({ runScope: RUN_SCOPE })
    await settle(200)
    const connection = w.connections[0]
    const then = vi.spyOn(connection.exited, 'then')

    const one = await waitFor(() => w.requests[0], 'the first request')
    const f = followUpIo()
    const running = one.run(f.io)
    await waitFor(() => exitListenerCount(connection) === 1, 'the running follow-up’s listener')
    await running
    expect(exitListenerCount(connection)).toBe(0)
    const two = await waitFor(() => w.requests[1], 'the second request')
    await two.run(followUpIo().io)
    expect(exitListenerCount(connection)).toBe(0)
    // One `then` on the process's exit for the connection, not one per turn.
    expect(then.mock.calls.length).toBeLessThanOrEqual(1)
  })
})

describe('a permission ask', () => {
  const ASKS: FakeAcpScript = {
    prompt: {
      emit: [
        {
          kind: 'update',
          update: {
            sessionUpdate: 'tool_call',
            toolCallId: 'call_1',
            title: 'write',
            kind: 'edit',
            status: 'pending'
          }
        },
        {
          kind: 'permission',
          toolCall: {
            toolCallId: 'call_1',
            title: '/tmp/agents/pineapple/notes.txt',
            kind: 'edit',
            status: 'pending',
            rawInput: { filepath: '/tmp/agents/pineapple/notes.txt', diff: '+hi' }
          }
        }
      ]
    }
  }

  it('parks, announces itself, and answers the agent with the option the user chose', async () => {
    const w = world({ script: ASKS })
    const running = w.run()
    const asked = await askedFor(w)
    expect(asked).toMatchObject({
      resume: 'reply',
      request: { kind: 'permission', action: 'edit', callId: 'call_1' }
    })
    expect(pendingRequests.owner(asked.requestId)?.chatId).toBe(CHAT_ID)

    expect(
      w.driver.respond(
        { requestId: asked.requestId, chatId: CHAT_ID, agentId: AGENT_ID, kind: 'permission' },
        { kind: 'permission', reply: 'once' }
      )
    ).toEqual({ delivered: true })
    await running
    expect(w.fake.answers('session/request_permission')[0].result).toEqual({
      outcome: { outcome: 'selected', optionId: 'once' }
    })
  })

  it('answers `allow_once` for an *Always allow*, and writes the rule beside the folder', async () => {
    // OpenCode's own `always` writes a per-project row that survives the
    // process and silences later sessions; Claude's writes into `~/.claude`.
    const w = world({ script: ASKS })
    const running = w.run()
    const asked = await askedFor(w)
    const request = pendingRequests.owner(asked.requestId)
    expect(request).not.toBeNull()
    expect(
      w.driver.respond(
        {
          requestId: asked.requestId,
          chatId: CHAT_ID,
          agentId: AGENT_ID,
          kind: 'permission',
          request: { action: 'edit', resources: ['/tmp/agents/pineapple/notes.txt'], savable: [] }
        },
        { kind: 'permission', reply: 'always' }
      )
    ).toEqual({ delivered: true, remembered: true })
    await running
    expect(w.grants).toEqual([
      { action: 'edit', resources: ['/tmp/agents/pineapple/notes.txt'], savable: [] }
    ])
    expect(w.fake.answers('session/request_permission')[0].result).toEqual({
      outcome: { outcome: 'selected', optionId: 'once' }
    })
  })

  it('settles a covered ask silently, with no block and no wait', async () => {
    const w = world({ script: ASKS, granted: true })
    const result = await w.run()
    expect(result.error).toBeUndefined()
    expect(w.events.filter((event) => event.type === 'needs_input')).toEqual([])
    expect(w.fake.answers('session/request_permission')[0].result).toEqual({
      outcome: { outcome: 'selected', optionId: 'once' }
    })
  })

  it('answers `cancelled` when the agent offers nothing but an always', async () => {
    const w = world({
      script: {
        prompt: {
          emit: [
            {
              kind: 'permission',
              options: [{ optionId: 'always', kind: 'allow_always', name: 'Always allow' }],
              toolCall: { toolCallId: 'call_1', kind: 'edit', status: 'pending' }
            }
          ]
        }
      },
      granted: true
    })
    await w.run()
    expect(w.fake.answers('session/request_permission')[0].result).toEqual({
      outcome: { outcome: 'cancelled' }
    })
  })

  it('denies when the user says no, in words written for the model', async () => {
    const w = world({ script: ASKS })
    const running = w.run()
    const asked = await askedFor(w)
    expect(
      w.driver.respond(
        { requestId: asked.requestId, chatId: CHAT_ID, agentId: AGENT_ID, kind: 'permission' },
        { kind: 'permission', reply: 'reject' }
      )
    ).toEqual({ delivered: true })
    const result = await running
    expect(w.fake.answers('session/request_permission')[0].result).toEqual({
      outcome: { outcome: 'selected', optionId: 'reject' }
    })
    // The transcript says a person decided, not that the request lapsed.
    expect(result.parts.map((part) => part.text)).toContain('Denied.')
  })

  it('answers an ask that arrives after the agent has already replied', async () => {
    // The regression the whole phase turns on. Under the in-process SDK a
    // string prompt closed the CLI's stdin at the first result, and a
    // background subagent's ask then arrived over a closed pipe — reported to
    // the model as "Tool permission request failed: AbortError: Stream closed",
    // seventeen times in the transcript that produced the memory note. There is
    // no stdin to close here: the ask is a request on a live connection,
    // whenever it comes.
    const w = world({
      script: {
        prompt: {
          emit: [
            {
              kind: 'update',
              update: {
                sessionUpdate: 'agent_message_chunk',
                content: { type: 'text', text: 'I will report back.' }
              }
            },
            {
              kind: 'permission',
              toolCall: {
                toolCallId: 'call_bg',
                kind: 'execute',
                status: 'pending',
                rawInput: { command: 'ledger --sync' }
              }
            },
            {
              kind: 'update',
              update: {
                sessionUpdate: 'agent_message_chunk',
                content: { type: 'text', text: ' Done: 42 bills.' }
              }
            }
          ]
        }
      }
    })
    const running = w.run()
    const asked = await askedFor(w)
    w.driver.respond(
      { requestId: asked.requestId, chatId: CHAT_ID, agentId: AGENT_ID, kind: 'permission' },
      { kind: 'permission', reply: 'once' }
    )
    const result = await running
    expect(result.error).toBeUndefined()
    expect(w.fake.answers('session/request_permission')[0].result).toEqual({
      outcome: { outcome: 'selected', optionId: 'once' }
    })
    expect(result.text).toContain('Done: 42 bills.')
  })

  it('denies, in words written for the model, when the park expires', async () => {
    const w = world({ script: ASKS })
    const running = w.run()
    const asked = await askedFor(w)
    expect(pendingRequests.resolve(asked.requestId, { kind: 'rejected' })).not.toBeNull()
    const result = await running
    expect(w.fake.answers('session/request_permission')[0].result).toEqual({
      outcome: { outcome: 'selected', optionId: 'reject' }
    })
    // An expiry, not a stop, and the two read differently.
    expect(result.parts.map((part) => part.text)).toContain('No answer — the request expired.')
  })
})

describe('a Cinna tool ask on a conducting session', () => {
  /** A lease whose server listed `probe` and nothing else. */
  const offering = (...offered: string[]): Partial<AcpDriverDeps> =>
    ({ prepareConductor: async () => ({ close() {}, hasCalls: () => false, offers: (name: string) => offered.includes(name) }) })
  const conducting = offering('probe')
  /** Codex's shape: the ask carries only a kind and the id of the call that named the tool. */
  const codexAsk = (toolCall: Record<string, unknown>): FakeAcpScript => ({
    prompt: { emit: [
      { kind: 'update', update: { sessionUpdate: 'tool_call', toolCallId: 'call_1', status: 'pending', ...toolCall } },
      { kind: 'permission', toolCall: { toolCallId: 'call_1', kind: 'execute', status: 'pending' } }
    ] }
  })
  const CINNA_CALL = { title: 'mcp.cinna.probe', kind: 'execute', rawInput: { server: 'cinna', tool: 'probe', arguments: {} } }

  it('allows a Codex ask for a Cinna tool silently: no block, no grant', async () => {
    const w = world({ launcher: 'codex', script: codexAsk(CINNA_CALL), deps: conducting })
    const result = await w.run()
    expect(result.error).toBeUndefined()
    expect(w.events.filter((event) => event.type === 'needs_input')).toEqual([])
    expect(w.grants).toEqual([])
    expect(w.fake.answers('session/request_permission')[0].result).toEqual({ outcome: { outcome: 'selected', optionId: 'once' } })
  })

  it('asks the user when only the title names Cinna', async () => {
    // A shell call is titled with its command, and a command can be called anything.
    const w = world({ launcher: 'codex', script: codexAsk({ title: 'mcp.cinna.probe', kind: 'execute', rawInput: { command: ['mcp.cinna.probe'] } }), deps: conducting })
    const running = w.run()
    const asked = await askedFor(w)
    w.driver.respond({ requestId: asked.requestId, chatId: CHAT_ID, agentId: AGENT_ID, kind: 'permission' }, { kind: 'permission', reply: 'reject' })
    await running
    expect(w.fake.answers('session/request_permission')[0].result).toEqual({ outcome: { outcome: 'selected', optionId: 'reject' } })
  })

  /** The shape every engine shares: a tool call opens, then the ask names it. */
  const ask = (toolCall: Record<string, unknown>): FakeAcpScript => ({
    prompt: { emit: [
      { kind: 'update', update: { sessionUpdate: 'tool_call', toolCallId: 'call_1', status: 'pending', ...toolCall } },
      { kind: 'permission', toolCall: { toolCallId: 'call_1', title: String(toolCall.title), status: 'pending' } }
    ] }
  })
  const allowedSilently = async (w: World): Promise<void> => {
    const result = await w.run()
    expect(result.error).toBeUndefined()
    expect(w.events.filter((event) => event.type === 'needs_input')).toEqual([])
    expect(w.grants).toEqual([])
    expect(w.fake.answers('session/request_permission')[0].result).toEqual({ outcome: { outcome: 'selected', optionId: 'once' } })
  }
  const askedTheUser = async (w: World, run: () => Promise<unknown> = () => w.run()): Promise<void> => {
    const running = run()
    const asked = await askedFor(w)
    w.driver.respond({ requestId: asked.requestId, chatId: CHAT_ID, agentId: AGENT_ID, kind: 'permission' }, { kind: 'permission', reply: 'reject' })
    await running
    expect(w.fake.answers('session/request_permission')[0].result).toEqual({ outcome: { outcome: 'selected', optionId: 'reject' } })
  }

  it('allows an OpenCode ask for a tool Cinna’s server offered', async () => {
    await allowedSilently(world({ launcher: 'opencode', script: ask({ title: 'cinna_probe', kind: 'other', rawInput: {} }), deps: conducting }))
  })

  it('asks about an OpenCode tool Cinna’s server never offered, however it is prefixed', async () => {
    // OpenCode spells an MCP tool `<server>_<tool>`: a user's server `cinna_x`
    // with a tool `y` reads as `cinna_x_y`.
    await askedTheUser(world({ launcher: 'opencode', script: ask({ title: 'cinna_x_y', kind: 'other', rawInput: {} }), deps: conducting }))
  })

  it('allows a Claude ask for a tool Cinna’s server offered', async () => {
    await allowedSilently(world({ launcher: 'claude', script: ask({ title: 'probe', kind: 'other', rawInput: {}, _meta: { claudeCode: { toolName: 'mcp__cinna__probe' } } }), deps: conducting }))
  })

  it('asks when the lease cannot say what its server offered', async () => {
    const w = world({ launcher: 'codex', script: codexAsk(CINNA_CALL), deps: { prepareConductor: async () => ({ close() {}, hasCalls: () => false }) } })
    await askedTheUser(w)
  })

  it('asks on a chat-owned runtime that has no lease', async () => {
    const w = world({ launcher: 'codex', script: codexAsk(CINNA_CALL) })
    const owned = { ...ROW, driverConfig: { ...ROW.driverConfig, conductorChatId: CHAT_ID } }
    await askedTheUser(w, () => w.driver.run(USER_ID, owned, { chatId: CHAT_ID, wireContent: 'hello', signal: new AbortController().signal, onEvent: (event) => void w.events.push(event) }))
  })

  it('leaves a session that conducts nothing asking as before', async () => {
    const w = world({ launcher: 'codex', script: codexAsk(CINNA_CALL) })
    const running = w.run()
    const asked = await askedFor(w)
    expect(asked.request).toMatchObject({ kind: 'permission', callId: 'call_1' })
    w.driver.respond({ requestId: asked.requestId, chatId: CHAT_ID, agentId: AGENT_ID, kind: 'permission' }, { kind: 'permission', reply: 'once' })
    await running
    expect(w.fake.answers('session/request_permission')[0].result).toEqual({ outcome: { outcome: 'selected', optionId: 'once' } })
  })
})

describe('the title a chat’s root session gives itself', () => {
  const SCOPE = { profileUserId: USER_ID, settingsUserId: USER_ID }
  const info = (title: string): FakeAcpStep => ({ kind: 'update', update: { sessionUpdate: 'session_info_update', title } })
  /** Codex's order: the prompt echoed as a placeholder, then the generated title. */
  const TITLES: FakeAcpScript = { prompt: { emit: [...(SAYS_HELLO.prompt?.emit ?? []), info('hello'), info('Greeting the agent')] } }
  const titled = (): { sink: ReturnType<typeof vi.fn>; deps: Partial<AcpDriverDeps> } => {
    const sink = vi.fn()
    return { sink, deps: { sessionTitle: sink } }
  }

  it('offers Codex’s generated title for the chat, and not the placeholder', async () => {
    const { sink, deps } = titled()
    const w = world({ launcher: 'codex', script: TITLES, deps })
    await w.run({ runScope: SCOPE })
    expect(sink.mock.calls).toEqual([[{ profileUserId: USER_ID, chatId: CHAT_ID, agentId: AGENT_ID, title: 'Greeting the agent' }]])
  })

  it('leaves Claude’s titles alone', async () => {
    const { sink, deps } = titled()
    const w = world({ launcher: 'claude', script: TITLES, deps })
    await w.run({ runScope: SCOPE })
    expect(sink).not.toHaveBeenCalled()
  })

  it('names nothing for a turn with no chat of its own', async () => {
    const { sink, deps } = titled()
    const w = world({ launcher: 'codex', script: TITLES, deps })
    await w.run()
    expect(sink).not.toHaveBeenCalled()
  })

  it('takes a title that arrives after the turn ended', async () => {
    const { sink, deps } = titled()
    const w = observedWorld({ launcher: 'codex', deps, script: { ...SAYS_HELLO, loadSession: { emit: [
      { kind: 'update', sessionId: 'ses_fake', update: { sessionUpdate: 'session_info_update', title: 'hello' } },
      { kind: 'update', sessionId: 'ses_fake', update: { sessionUpdate: 'session_info_update', title: 'Greeting the agent' } }
    ] } } })
    await w.run({ runScope: SCOPE })
    w.sessions.set('chat-2', 'ses_two')
    await w.run({ chatId: 'chat-2', runScope: SCOPE })
    await waitFor(() => sink.mock.calls.length > 0, 'the title')
    expect(sink.mock.calls).toEqual([[{ profileUserId: USER_ID, chatId: CHAT_ID, agentId: AGENT_ID, title: 'Greeting the agent' }]])
  })
})

describe('a question', () => {
  const ASKS_QUESTION: FakeAcpScript = {
    prompt: {
      emit: [
        {
          kind: 'elicitation',
          params: {
            message: 'Which colour?',
            requestedSchema: {
              type: 'object',
              properties: {
                question_0: {
                  type: 'string',
                  title: 'Colour',
                  oneOf: [
                    { const: 'Red', title: 'Red' },
                    { const: 'Blue', title: 'Blue' }
                  ]
                }
              }
            }
          }
        }
      ]
    }
  }

  it('asks it as a question and answers with the label the user picked', async () => {
    const w = world({ script: ASKS_QUESTION, launcher: 'claude' })
    const running = w.run()
    const asked = await askedFor(w)
    expect(asked.request).toEqual({
      kind: 'question',
      questions: [
        {
          question: 'Which colour?',
          header: 'Colour',
          multiSelect: false,
          options: [{ label: 'Red' }, { label: 'Blue' }]
        }
      ]
    })
    expect(
      pendingRequests.resolve(asked.requestId, { kind: 'question', answers: [['Blue']] })
    ).not.toBeNull()
    const result = await running
    expect(w.fake.answers('elicitation/create')[0].result).toEqual({
      action: 'accept',
      content: { question_0: 'Blue' }
    })
    // The decision line reads like every other one in a transcript, full stop
    // included — the wording the OpenCode runner used before this phase.
    expect(result.parts.map((part) => part.text)).toContain('Answered: Blue.')
  })

  it('records the AskUserQuestion call the adapter says the question came from', async () => {
    const [elicitation] = ASKS_QUESTION.prompt?.emit ?? []
    const script: FakeAcpScript = {
      prompt: {
        emit: [
          {
            kind: 'update',
            update: {
              sessionUpdate: 'tool_call',
              toolCallId: 'toolu_ask',
              title: 'AskUserQuestion',
              status: 'pending',
              _meta: { claudeCode: { toolName: 'AskUserQuestion' } }
            }
          },
          {
            kind: 'elicitation',
            params: {
              ...(elicitation?.kind === 'elicitation' ? elicitation.params : {}),
              toolCallId: 'toolu_ask'
            }
          }
        ]
      }
    }
    const w = world({ script, launcher: 'claude' })
    const running = w.run()
    const asked = await askedFor(w)
    pendingRequests.resolve(asked.requestId, { kind: 'question', answers: [['Blue']] })
    const result = await running
    const question = result.parts.find((part) => part.toolId === asked.requestId)
    expect(question?.toolInput).toEqual(expect.objectContaining({ callId: 'toolu_ask' }))
  })

  it('has saved its new session, and offers what it streamed, while it waits on the answer', async () => {
    // The case this guards: a turn parked on a question, the app quit under it, and the
    // next turn opened a fresh session because the id was only saved at the
    // exit. Mutation: drop the early `rememberSession` → `saved` is empty here;
    // drop the `savedSession` check → it holds the id twice at the end.
    const w = world({ script: ASKS_QUESTION, launcher: 'claude' })
    let snapshot: Parameters<NonNullable<RunInput['registerSnapshot']>>[0] | undefined
    const running = w.run({ registerSnapshot: (read) => { snapshot = read } })
    const asked = await askedFor(w)
    expect(w.saved).toEqual(['ses_fake'])
    expect(snapshot?.().parts.some((part) => part.toolId === asked.requestId)).toBe(true)
    pendingRequests.resolve(asked.requestId, { kind: 'question', answers: [['Blue']] })
    const result = await running
    expect(result.error).toBeUndefined()
    expect(w.saved).toEqual(['ses_fake'])
  })

  it('declines a form it cannot render, rather than cancelling the tool call', async () => {
    const w = world({
      script: { prompt: { emit: [{ kind: 'elicitation' }] } },
      launcher: 'claude'
    })
    await w.run()
    expect(w.fake.answers('elicitation/create')[0].result).toEqual({ action: 'decline' })
    expect(w.events.filter((event) => event.type === 'needs_input')).toEqual([])
  })
})

describe('the mode the agent actually ran in', () => {
  it('says so in the transcript when it is not the one the desktop asked for', async () => {
    // The setting said automatic and the turn asked before every action. The
    // in-process runner learned this from the SDK's init message; over ACP the
    // signal is a mode update naming something else.
    const w = world({
      launcher: 'claude',
      setup: { modeId: 'auto' },
      script: {
        prompt: {
          emit: [
            {
              kind: 'update',
              update: { sessionUpdate: 'current_mode_update', currentModeId: 'default' }
            },
            {
              kind: 'update',
              update: {
                sessionUpdate: 'agent_message_chunk',
                content: { type: 'text', text: 'Done.' }
              }
            }
          ]
        }
      }
    })
    const result = await w.run()
    // A notice, not text: it is the desktop speaking about the turn, and
    // notices are the channel for that.
    expect(result.notices.map((notice) => notice.text).join('\n')).toContain(
      'Automatic approvals are not available here'
    )
  })

  it('says nothing about the mode a session merely started in', async () => {
    // A session reports the mode it *starts* in — `session/new` answers with it,
    // and a loaded one comes back in whatever it was left in. Compared against
    // the mode we are about to ask for, that put the fallback notice on every
    // turn: asked for `auto`, told `default` by a notification that predates the
    // request, while automatic approvals were in fact on.
    const w = world({
      launcher: 'claude',
      setup: { modeId: 'auto' },
      script: {
        newSession: {
          emit: [
            {
              kind: 'update',
              update: { sessionUpdate: 'current_mode_update', currentModeId: 'default' }
            }
          ]
        },
        ...SAYS_HELLO
      }
    })
    const result = await w.run()
    expect(result.notices).toEqual([])
  })

  it('says nothing when the agent ran in the mode it was given', async () => {
    const w = world({
      launcher: 'claude',
      setup: { modeId: 'default' },
      script: {
        prompt: {
          emit: [
            {
              kind: 'update',
              update: { sessionUpdate: 'current_mode_update', currentModeId: 'default' }
            },
            {
              kind: 'update',
              update: {
                sessionUpdate: 'agent_message_chunk',
                content: { type: 'text', text: 'Done.' }
              }
            }
          ]
        }
      }
    })
    const result = await w.run()
    expect(result.notices).toEqual([])
    expect(result.parts.map((part) => part.kind)).toEqual(['text'])
  })
})

describe('which login paid for the turn', () => {
  const authStatus = (authStatus: Record<string, unknown>): FakeAcpScript => ({
    prompt: {
      emit: [
        { kind: 'notify', method: '_auth/status_update', params: { sessionId: 'ses_fake', authStatus } },
        {
          kind: 'update',
          update: {
            sessionUpdate: 'agent_message_chunk',
            content: { type: 'text', text: 'Done.' }
          }
        }
      ]
    }
  })

  it('says nothing when the agent ran on its own subscription login', async () => {
    // The recorded shape: `{kind:'account', label:'Claude Max', account:{…}}`.
    // This app never asserts a subscription — it only reports when the agent
    // says otherwise.
    const w = world({
      launcher: 'claude',
      script: authStatus({ kind: 'account', label: 'Claude Max', account: { plan: 'max' } })
    })
    const result = await w.run()
    expect(result.notices).toEqual([])
  })

  it('says so when the turn was paid for by something else', async () => {
    // A turn billed to an account the user did not choose looks exactly like a
    // turn billed to the right one, which is why this is a notice in the
    // transcript and not a log line.
    const w = world({
      launcher: 'claude',
      script: authStatus({ kind: 'apiKey', label: 'API key' })
    })
    const result = await w.run()
    expect(result.notices.map((notice) => notice.text).join('\n')).toContain(
      'did not run on the agent’s own login'
    )
  })

  it('never repeats the account’s email, whatever the label says', async () => {
    // The same payload carries the address two fields away, and an adapter
    // version that decided the label should name the account would otherwise
    // put it straight into the transcript.
    const w = world({
      launcher: 'claude',
      script: authStatus({ kind: 'apiKey', label: 'key for someone@example.com' })
    })
    const result = await w.run()
    const text = result.notices.map((notice) => notice.text).join('\n')
    expect(text).toContain('key for …')
    expect(text).not.toContain('someone@example.com')
  })

  it('says so once per chat on a connection, not on every turn', async () => {
    const w = world({ launcher: 'claude', script: authStatus({ kind: 'apiKey', label: 'API key' }) })
    const notices = async (chatId?: string): Promise<string> =>
      (await w.run(chatId ? { chatId } : {})).notices.map((notice) => notice.text).join('\n')
    expect(await notices()).toContain('did not run on the agent’s own login')
    expect(await notices()).not.toContain('did not run on the agent’s own login')
    // Another chat on the same connection has not been told.
    expect(await notices('chat-2')).toContain('did not run on the agent’s own login')
  })
})

describe('session telemetry', () => {
  const q = (inputTokens: number, cachedInputTokens: number, cachedWriteTokens: number, outputTokens: number) => ({
    totalTokens: inputTokens + cachedInputTokens + cachedWriteTokens + outputTokens,
    inputTokens, cachedInputTokens, cachedWriteTokens, outputTokens, reasoningOutputTokens: 0
  })
  const CLAUDE_ANSWER = {
    stopReason: 'end_turn',
    usage: { inputTokens: 10, outputTokens: 200, cachedReadTokens: 30_000, cachedWriteTokens: 1_500, totalTokens: 31_710 },
    _meta: { quota: { token_count: q(10, 30_000, 1_500, 200), model_usage: [
      { model: 'claude-sonnet-5[1m]', token_count: q(10, 30_000, 1_500, 200) },
      { model: 'claude-haiku-4-5', token_count: q(5, 8_000, 900, 120) }
    ] } }
  }
  const usage = (update: Record<string, unknown>, sessionId = 'ses_fake'): FakeAcpStep =>
    ({ kind: 'update', sessionId, update: { sessionUpdate: 'usage_update', ...update } })
  const reporter = (): { changes: SessionTelemetryChange[]; telemetry: SessionTelemetryReporter } => {
    const changes: SessionTelemetryChange[] = []
    return { changes, telemetry: { report: (chatId, change) => { expect(chatId).toBe(CHAT_ID); changes.push(change) } } }
  }

  it('returns a Claude turn’s model, tokens, cost and context, and reports the turn once', async () => {
    const { changes, telemetry } = reporter()
    const w = world({ launcher: 'claude', deps: { telemetry }, script: { prompt: {
      emit: [
        usage({ used: 16_000, size: 200_000 }),
        { kind: 'update', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Done.' } } },
        // A subagent's own session (Codex opens one) is routed here, but is not this session's context.
        { kind: 'update', update: { sessionUpdate: 'subagent_spawned', subagentSessionId: 'ses_child', name: 'Echo', task: 'Echo', capabilities: {} } },
        usage({ used: 3, size: 4 }, 'ses_child'),
        usage({ used: 16_400, size: 1_000_000, cost: { amount: 0.04, currency: 'USD' } })
      ],
      response: CLAUDE_ANSWER
    } } })
    const result = await w.run()
    expect(result.telemetry).toMatchObject({
      model: 'claude-sonnet-5[1m]',
      tokens: { input: 15, output: 320, cacheRead: 38_000, cacheWrite: 2_400 },
      tokenScope: 'turn',
      costUsd: 0.04,
      costSource: 'runtime',
      contextUsedAfter: 16_400
    })
    expect(result.telemetry?.durationMs).toBeGreaterThanOrEqual(0)
    const turns = changes.filter((change) => change.type === 'turn')
    expect(turns).toHaveLength(1)
    expect(turns[0]).toMatchObject({ sessionId: 'ses_fake', byModel: { 'claude-haiku-4-5': { output: 120 } } })
    expect(changes.filter((change) => change.type === 'context').map((change) => change.type === 'context' && change.used))
      .toEqual([16_000, 16_400])
  })

  it('reads Claude’s raw SDK frames of its own session into telemetry, never into the transcript', async () => {
    const { changes, telemetry } = reporter()
    const raw = (message: object, sessionId = 'ses_fake'): FakeAcpStep => ({ kind: 'notify', method: '_claude/sdkMessage', params: sdkParams(message, sessionId) })
    const w = world({ launcher: 'claude', deps: { telemetry }, script: { prompt: {
      emit: [
        raw(initMessage),
        raw(assistantMessage({ id: 'msg_1', input: 3, cacheRead: 15_000, write1h: 2_000 })),
        // A subagent's frame, and another session's: neither is this session's request.
        raw(assistantMessage({ id: 'msg_sub', parent: 'toolu_1' })),
        raw(assistantMessage({ id: 'msg_other' }), 'ses_other'),
        { kind: 'update', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Done.' } } },
        raw(resultMessage({ costs: { 'claude-sonnet-5[1m]': 0.035, 'claude-haiku-4-5': 0.005 }, windows: { 'claude-sonnet-5[1m]': 1_000_000 }, numTurns: 1, apiDurationMs: 2_000 })),
        usage({ used: 16_400, size: 1_000_000, cost: { amount: 0.04, currency: 'USD' } })
      ],
      response: CLAUDE_ANSWER
    } } })
    const result = await w.run()
    expect(result.text).toBe('Done.')
    expect(JSON.stringify(result)).not.toContain('SECRET')
    expect(result.telemetry).toMatchObject({ requests: 1, costUsd: 0.04 })
    // A running total, but the session was created on this connection: its ledger started at zero.
    expect(result.telemetry).toMatchObject({ apiDurationMs: 2_000 })
    expect(changes.map((change) => change.type)).toEqual(['session', 'runtime', 'request', 'context', 'turn'])
    expect(changes[0]).toMatchObject({ type: 'session', sessionId: 'ses_fake', fresh: true, fingerprint: expect.stringMatching(/^[0-9a-f]{16}$/) })
    expect(changes[2]).toMatchObject({ type: 'request', input: 17_003, cacheWrite1h: 2_000 })
    expect(changes[4]).toMatchObject({ type: 'turn', contextWindow: 1_000_000, byModelCost: { 'claude-sonnet-5[1m]': 0.035, 'claude-haiku-4-5': 0.005 } })
  })

  it('counts a cancelled turn’s answer too', async () => {
    const controller = new AbortController()
    const w = world({ launcher: 'claude', script: { prompt: {
      emit: [{ kind: 'update', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Wor' } } }, { kind: 'awaitCancel' }],
      response: { ...CLAUDE_ANSWER, stopReason: 'cancelled' }
    } } })
    const running = w.run({ signal: controller.signal })
    await waitFor(() => w.events.some((event) => event.type === 'delta'), 'the first delta')
    controller.abort()
    const result = await running
    expect(result.taskState).toBe('canceled')
    expect(result.telemetry?.tokens.output).toBe(320)
  })

  it('does not count what a session/load replays', async () => {
    const { changes, telemetry } = reporter()
    const w = world({ launcher: 'claude', remembered: 'ses_fake', deps: { telemetry }, script: {
      loadSession: { emit: [usage({ used: 999, size: 200_000, cost: { amount: 5, currency: 'USD' } })] },
      prompt: { emit: [usage({ used: 1_000, size: 200_000, cost: { amount: 5.5, currency: 'USD' } })], response: CLAUDE_ANSWER }
    } })
    const result = await w.run()
    expect(changes.some((change) => change.type === 'context' && change.used === 999)).toBe(false)
    // The replayed reading was never taken, so this turn's is its first: taken as is.
    expect(result.telemetry?.costUsd).toBe(5.5)
  })

  it('reads the login from the notification that names no session, and says when it is not the subscription', async () => {
    const { changes, telemetry } = reporter()
    const w = world({ launcher: 'claude', deps: { telemetry }, script: {
      // Before `session/new` answers, as the adapter sends it.
      newSession: { emit: [{ kind: 'notify', method: '_auth/status_update', params: { authStatus: {
        kind: 'api_key', label: 'Anthropic API key', account: { email: 'someone@example.com', organization: 'Acme' }
      } } }] },
      prompt: { emit: [{ kind: 'update', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Done.' } } }] }
    } })
    const result = await w.run()
    expect(result.notices.map((notice) => notice.text).join('\n')).toContain('did not run on the agent’s own login — it reported “Anthropic API key”')
    expect(changes.filter((change) => change.type === 'auth')).toEqual([
      { type: 'auth', engine: 'claude', auth: { kind: 'api_key', label: 'Anthropic API key' } }
    ])
    expect(JSON.stringify(changes)).not.toContain('example.com')
    expect(JSON.stringify(changes)).not.toContain('Acme')
    expect(JSON.stringify(result)).not.toContain('example.com')
  })

  it('says so about a foreign login once per chat on a connection, not on every turn', async () => {
    const { telemetry } = reporter()
    const w = world({ launcher: 'claude', deps: { telemetry }, script: {
      newSession: { emit: [{ kind: 'notify', method: '_auth/status_update', params: { authStatus: { kind: 'api_key', label: 'Anthropic API key' } } }] },
      prompt: { emit: [{ kind: 'update', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Done.' } } }] }
    } })
    const noticed = (result: Awaited<ReturnType<typeof w.run>>): boolean =>
      result.notices.some((notice) => notice.text.includes('did not run on the agent’s own login'))
    expect(noticed(await w.run())).toBe(true)
    expect(noticed(await w.run())).toBe(false)
  })

  it('reads a Codex turn as its last request, and its login from the launcher', async () => {
    const { changes, telemetry } = reporter()
    const w = world({ launcher: 'codex', deps: { telemetry }, telemetryAuth: async () => ({ kind: 'subscription', label: 'ChatGPT' }), script: {
      newSession: { response: { configOptions: [{ id: 'model', category: 'model', type: 'select', currentValue: 'gpt-5.5-codex', options: [] }] } },
      prompt: { emit: [usage({ used: 12_345, size: 258_400 })], response: {
        stopReason: 'end_turn',
        usage: { totalTokens: 12_345, inputTokens: 1_000, cachedReadTokens: 11_000, outputTokens: 345, thoughtTokens: 100 },
        _meta: { quota: { token_count: { totalTokens: 12_345, inputTokens: 1_000, cachedInputTokens: 11_000, outputTokens: 345, reasoningOutputTokens: 100 },
          model_usage: [{ model: 'gpt-5.5-codex', token_count: { totalTokens: 12_345, inputTokens: 1_000, cachedInputTokens: 11_000, outputTokens: 345, reasoningOutputTokens: 100 } }] } }
      } }
    } })
    const result = await w.run()
    expect(result.telemetry).toMatchObject({ model: 'gpt-5.5-codex', tokenScope: 'last_request', tokens: { input: 1_000, output: 345, cacheRead: 11_000 }, contextUsedAfter: 12_345 })
    expect(result.telemetry?.costUsd).toBeUndefined()
    await waitFor(() => changes.find((change) => change.type === 'auth'), 'the launcher’s login')
    expect(changes.find((change) => change.type === 'auth')).toEqual({ type: 'auth', engine: 'codex', auth: { kind: 'subscription', label: 'ChatGPT' } })
    expect(changes.find((change) => change.type === 'model')).toEqual({ type: 'model', engine: 'codex', selected: 'gpt-5.5-codex' })
  })

  it('does not zero a loaded session twice when its first turn failed after taking a reading', async () => {
    const { telemetry } = reporter()
    // A new process loads the session; the first prompt fails after a costed
    // reading, on a connection that survives. The second turn reuses the
    // adapter's query: its reading is a running total over both.
    const w = world({ launcher: 'claude', remembered: 'ses_fake', deps: { telemetry }, script: { prompt: { sequence: [
      { emit: [usage({ used: 1_000, size: 200_000, cost: { amount: 0.03, currency: 'USD' } })], error: { code: -32603, message: 'Internal error: upstream hiccup' } },
      { emit: [usage({ used: 1_200, size: 200_000, cost: { amount: 0.05, currency: 'USD' } })], response: CLAUDE_ANSWER }
    ] } } })
    const failed = await w.run()
    expect(failed.error).toBeDefined()
    const next = await w.run()
    expect(w.fake.received('session/load')).toHaveLength(2)
    expect(next.telemetry?.costUsd).toBeCloseTo(0.02)
  })

  it('measures the first turn after a restart from 0: the fresh query’s cost, API time and rows are that turn’s own', async () => {
    // The chat's aggregate, folded as the service folds it, surviving the "restart".
    let state: SessionTelemetry | null = null
    const service: SessionTelemetryReporter = {
      report: (chatId, change) => { state = applyTelemetryChange(state, chatId, change, 1) }
    }
    const raw = (message: object): FakeAcpStep => ({ kind: 'notify', method: '_claude/sdkMessage', params: sdkParams(message, 'ses_fake') })
    const first = world({ launcher: 'claude', deps: { telemetry: service }, script: { prompt: {
      emit: [
        raw(resultMessage({ costs: { 'claude-sonnet-5[1m]': 0.04 }, apiDurationMs: 2_000, numTurns: 1 })),
        usage({ used: 16_400, size: 1_000_000, cost: { amount: 0.04, currency: 'USD' } })
      ],
      response: CLAUDE_ANSWER
    } } })
    await first.run()
    expect(state!.totals.costUsd).toBeCloseTo(0.04)
    expect(state!.totals.tokens).toEqual({ input: 15, output: 320, cacheRead: 38_000, cacheWrite: 2_400 })

    // A new process loads the session. Observed 2026-09-30 (claude 2.1.276,
    // claude-agent-acp 0.76.0): the CLI does not restore its running totals and
    // the adapter's model_usage baseline matches the fresh query, so every
    // reading, and the rows, are this turn's only — the rows with a side
    // request the main-loop `usage` misses.
    const RESUMED_ANSWER = {
      stopReason: 'end_turn',
      usage: { inputTokens: 7, outputTokens: 50, cachedReadTokens: 31_000, cachedWriteTokens: 0, totalTokens: 31_057 },
      _meta: { quota: { token_count: q(7, 31_000, 0, 50), model_usage: [
        { model: 'claude-sonnet-5[1m]', token_count: q(7, 31_000, 0, 50) },
        { model: 'claude-haiku-4-5', token_count: q(3, 2_000, 0, 10) }
      ] } }
    }
    const second = world({ launcher: 'claude', remembered: 'ses_fake', deps: { telemetry: service }, script: { prompt: {
      emit: [
        raw(resultMessage({ costs: { 'claude-sonnet-5[1m]': 0.05 }, apiDurationMs: 900, numTurns: 1 })),
        usage({ used: 16_500, size: 1_000_000, cost: { amount: 0.05, currency: 'USD' } })
      ],
      response: RESUMED_ANSWER
    } } })
    const resumed = await second.run()
    expect(second.fake.received('session/load')).toHaveLength(1)
    expect(resumed.telemetry?.costUsd).toBeCloseTo(0.05)
    expect(resumed.telemetry?.apiDurationMs).toBe(900)
    expect(resumed.telemetry?.tokens).toEqual({ input: 10, output: 60, cacheRead: 33_000, cacheWrite: 0 })
    expect(state!.totals.costUsd).toBeCloseTo(0.09)
    expect(state!.totals.byModel['claude-sonnet-5[1m]'].costUsd).toBeCloseTo(0.09)
    expect(state!.totals.tokens).toEqual({ input: 25, output: 380, cacheRead: 71_000, cacheWrite: 2_400 })
    expect(state!.totals.turns).toBe(2)

    // The next turn on that connection is live: measured against its readings
    // (the fake repeats them, so this turn added nothing).
    const next = await second.run()
    expect(next.telemetry?.costUsd ?? 0).toBeCloseTo(0)
    expect(next.telemetry?.apiDurationMs).toBe(0)
  })

  it('measures from 0 again after a load on the same connection under other params (the adapter recreated the session)', async () => {
    const raw = (message: object): FakeAcpStep => ({ kind: 'notify', method: '_claude/sdkMessage', params: sdkParams(message, 'ses_fake') })
    let servers = ['docs']
    const w = world({ launcher: 'claude', script: { prompt: {
      emit: [
        raw(resultMessage({ costs: { 'claude-sonnet-5[1m]': 0.04 }, apiDurationMs: 2_000, numTurns: 1 })),
        usage({ used: 16_400, size: 1_000_000, cost: { amount: 0.04, currency: 'USD' } })
      ],
      response: CLAUDE_ANSWER
    } }, deps: {
      prepareConductor: async (_user, _agent, _input, plan) => {
        plan.session.mcpServers = servers.map((name) => ({ type: 'http' as const, name, url: `http://127.0.0.1:1/${name}`, headers: [] }))
        return { close() {}, hasCalls: () => false }
      }
    } })
    expect((await w.run()).telemetry).toMatchObject({ costUsd: 0.04, apiDurationMs: 2_000 })
    // Loaded under the same params: live, and the repeated readings add nothing.
    expect((await w.run()).telemetry).toMatchObject({ costUsd: 0, apiDurationMs: 0 })
    // A connector added: the load rebuilds the session, a fresh query.
    servers = ['docs', 'git']
    const rebuilt = await w.run()
    expect(w.fake.received('session/load')).toHaveLength(2)
    expect(rebuilt.telemetry).toMatchObject({ costUsd: 0.04, apiDurationMs: 2_000 })
  })

  it('reports nothing for a nested turn, and nothing for an engine it does not read', async () => {
    const { changes, telemetry } = reporter()
    const nested = world({ launcher: 'claude', deps: { telemetry }, script: { prompt: { emit: [usage({ used: 1, size: 2, cost: { amount: 0.5, currency: 'USD' } })], response: CLAUDE_ANSWER } } })
    const result = await nested.driver.run(USER_ID, ROW, { chatId: CHAT_ID, wireContent: 'hello', signal: new AbortController().signal, nested: { toolCallId: 'call_1' } })
    expect(result.telemetry?.costUsd).toBe(0.5)
    const opencode = world({ deps: { telemetry }, script: { prompt: { emit: [usage({ used: 1, size: 2, cost: { amount: 0.5, currency: 'USD' } })], response: CLAUDE_ANSWER } } })
    expect((await opencode.run()).telemetry).toBeUndefined()
    expect(changes).toEqual([])
  })

  it('counts a Codex turn as the growth of the session’s running total, and falls back to the persisted total', async () => {
    const CODEX_ANSWER = { stopReason: 'end_turn', usage: { inputTokens: 5, cachedReadTokens: 100, outputTokens: 2, totalTokens: 107 },
      _meta: { quota: { token_count: q(5, 100, 0, 2), total_token_count: q(40, 900, 0, 12), model_usage: [{ model: 'gpt-5.5', token_count: q(5, 100, 0, 2) }] } } }
    const w = world({ launcher: 'codex', script: { prompt: { response: CODEX_ANSWER } } })
    const first = await w.run()
    expect(first.telemetry).toMatchObject({ tokens: { input: 40, output: 12, cacheRead: 900, cacheWrite: 0 }, tokenScope: 'turn' })
    // The same total again: this turn added nothing.
    const second = await w.run()
    expect(second.telemetry).toMatchObject({ tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, tokenScope: 'turn' })

    // Another process, and a total persisted from before it.
    const persisted = { report: () => {}, lastTokenTotal: (_chatId: string, sessionId: string) => sessionId === 'ses_fake' ? { input: 30, output: 10, cacheRead: 600, cacheWrite: 0 } : undefined }
    const restarted = world({ launcher: 'codex', remembered: 'ses_fake', deps: { telemetry: persisted }, script: { prompt: { response: CODEX_ANSWER } } })
    expect((await restarted.run()).telemetry).toMatchObject({ tokens: { input: 10, output: 2, cacheRead: 300, cacheWrite: 0 }, tokenScope: 'turn' })

    // Another process, and nothing persisted (a chat from before the total was
    // kept): the restored total is the whole history, so the last request stands.
    const upgraded = world({ launcher: 'codex', remembered: 'ses_fake', deps: { telemetry: { report: () => {}, lastTokenTotal: () => undefined } }, script: { prompt: { response: CODEX_ANSWER } } })
    expect((await upgraded.run()).telemetry).toMatchObject({ tokens: { input: 5, output: 2, cacheRead: 100, cacheWrite: 0 }, tokenScope: 'last_request' })
  })
})

describe('measuring a chat’s context between turns', () => {
  const MEASURED = {
    categories: [{ name: 'System prompt', tokens: 3_100 }, { name: 'Messages', tokens: 900 }],
    totalTokens: 4_000, maxTokens: 200_000, rawMaxTokens: 200_000, percentage: 2, model: 'claude-sonnet-5',
    memoryFiles: [{ path: '/home/someone/CLAUDE.md', type: 'User', tokens: 40 }],
    mcpTools: [], agents: [], systemTools: [], systemPromptSections: []
  }
  const measure = (w: World, chatId = CHAT_ID) => (w.driver as AcpDriver).measureContext(chatId)
  const asked = (w: World) => w.fake.received('_cinna/contextUsage')

  it('asks the live session its last turn answered on, and answers the measurement read', async () => {
    const w = world({ launcher: 'claude', script: { prompt: SAYS_HELLO.prompt, contextUsage: { response: MEASURED } } })
    await w.run()
    await expect(measure(w)).resolves.toEqual({ ok: true, engine: 'claude', sessionId: 'ses_fake', categories: MEASURED })
    expect(asked(w).map((entry) => entry.params)).toEqual([{ sessionId: 'ses_fake' }])
  })

  it('refuses without asking: no turn yet, another engine, a chat the agent was taken off, or the process gone', async () => {
    const claude = world({ launcher: 'claude', script: { prompt: SAYS_HELLO.prompt } })
    await expect(measure(claude)).resolves.toEqual({ ok: false, code: 'not_running' })
    const codex = world({ launcher: 'codex', script: { prompt: SAYS_HELLO.prompt } })
    await codex.run()
    await expect(measure(codex)).resolves.toEqual({ ok: false, code: 'unsupported' })
    expect(asked(codex)).toEqual([])

    await claude.run()
    ;(claude.driver as AcpDriver).forgetChatSessions(CHAT_ID)
    await expect(measure(claude)).resolves.toEqual({ ok: false, code: 'not_running' })

    const retired = world({ launcher: 'claude', script: { prompt: SAYS_HELLO.prompt } })
    await retired.run()
    retired.pool.retire(AGENT_ID)
    await waitFor(() => retired.pool.status(AGENT_ID).state !== 'running', 'the process to stop')
    await expect(measure(retired)).resolves.toEqual({ ok: false, code: 'not_running' })
    expect(asked(claude)).toEqual([])
    expect(asked(retired)).toEqual([])
  })

  it('refuses a chat whose session no prompt has answered on this connection', async () => {
    const w = world({ launcher: 'claude', script: { prompt: SAYS_HELLO.prompt } })
    await w.run()
    // The chat now names another session (a later turn created one and failed before its answer).
    w.sessions.set(CHAT_ID, 'ses_elsewhere')
    await expect(measure(w)).resolves.toEqual({ ok: false, code: 'not_ready' })
    expect(asked(w)).toEqual([])
  })

  it('refuses while a turn runs in the chat, and passes on the adapter’s own busy refusal', async () => {
    const controller = new AbortController()
    const w = world({ launcher: 'claude', script: {
      prompt: { emit: [{ kind: 'update', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Wor' } } }, { kind: 'awaitCancel' }], response: { stopReason: 'cancelled' } },
      contextUsage: { error: { code: -32603, message: 'Internal error: busy: a turn is in progress on this session', data: { reason: 'busy' } } }
    } })
    const first = w.run({ signal: controller.signal })
    await waitFor(() => w.events.some((event) => event.type === 'delta'), 'the first delta')
    await expect(measure(w)).resolves.toEqual({ ok: false, code: 'busy' })
    expect(asked(w)).toEqual([])
    controller.abort()
    await first
    // Between turns by this app's count; the adapter still has one running (a background task, say).
    await expect(measure(w)).resolves.toEqual({ ok: false, code: 'busy' })
    expect(asked(w)).toHaveLength(1)
  })

  it('reads the adapter’s refusal of a session whose query ended as not running', async () => {
    const w = world({ launcher: 'claude', script: { prompt: SAYS_HELLO.prompt, contextUsage: { error: { code: -32603, message: 'Internal error: closed: this session\'s query has ended', data: { reason: 'closed' } } } } })
    await w.run()
    await expect(measure(w)).resolves.toEqual({ ok: false, code: 'not_running' })
  })

  it('discards an answer that arrives after a turn started in the chat, as busy', async () => {
    const w = world({ launcher: 'claude', script: { prompt: SAYS_HELLO.prompt, contextUsage: { response: MEASURED, delayMs: 400 } } })
    await w.run()
    const measuring = measure(w)
    await waitFor(() => asked(w).length === 1, 'the measurement to be asked')
    // A whole turn runs and ends while the request is out: the answer describes the context before it.
    await w.run()
    await expect(measuring).resolves.toEqual({ ok: false, code: 'busy' })
  })

  it('gives up on a runtime that takes too long or answers nonsense, as failed', async () => {
    const slow = world({ launcher: 'claude', deps: { contextUsageTimeoutMs: 100 }, script: { prompt: SAYS_HELLO.prompt, contextUsage: { hang: true } } })
    await slow.run()
    await expect(measure(slow)).resolves.toEqual({ ok: false, code: 'failed' })
    const odd = world({ launcher: 'claude', script: { prompt: SAYS_HELLO.prompt, contextUsage: { response: { totalTokens: 'lots' } } } })
    await odd.run()
    await expect(measure(odd)).resolves.toEqual({ ok: false, code: 'failed' })
  })
})

describe('a stop', () => {
  it.each([
    ['runtime restoration', 'resolve'],
    ['runtime restoration', 'reject'],
    ['launch planning', 'resolve'],
    ['launch planning', 'reject']
  ] as const)('settles during pending %s and ignores its late %s', async (stage, outcome) => {
    const restoring = deferred<AcpRuntimeView>()
    const planning = deferred<AcpLaunchPlan>()
    const validate = vi.fn()
    const runtime: AcpRuntimeView = {
      type: 'folder', folder: FOLDER, validate,
      readSession: () => null, saveSession() {}, isGranted: () => false, rememberGrant: () => false
    }
    const plan = vi.fn(() => planning.promise)
    const readRuntime = vi.fn(() => stage === 'runtime restoration' ? restoring.promise : runtime)
    const w = world({ deps: {
      readRuntime,
      launcher: () => ({ id: 'opencode', plan })
    } })
    const acquire = vi.spyOn(w.pool, 'acquire')
    const controller = new AbortController()
    const running = w.run({ signal: controller.signal })
    await waitFor(() => stage === 'runtime restoration' ? readRuntime.mock.calls.length > 0 : plan.mock.calls.length > 0, 'preparation to start')
    controller.abort()

    // The underlying operation is still pending when Stop returns. In
    // particular, shared workspace restoration must continue independently.
    expect(await running).toEqual({ text: '', parts: [], notices: [], taskState: 'canceled', stopReason: 'canceled' })
    if (outcome === 'reject') {
      const pending = stage === 'runtime restoration' ? restoring : planning
      pending.reject(new Error('late preparation failure'))
    } else if (stage === 'runtime restoration') restoring.resolve(runtime)
    else planning.resolve({
      spec: w.fake.spec, init: { protocolVersion: ACP_PROTOCOL_VERSION },
      session: { mcpServers: [] }, setup: {}
    })
    await settle(0)

    if (stage === 'runtime restoration') {
      expect(validate).not.toHaveBeenCalled()
      expect(plan).not.toHaveBeenCalled()
    }
    expect(acquire).not.toHaveBeenCalled()
    expect(w.events).toEqual([])
  }, 1_000)

  it('preserves genuine runtime and planning failures before cancellation', async () => {
    const runtimeFailure = world({ deps: { readRuntime: async () => { throw new Error('workspace unavailable') } } })
    expect((await runtimeFailure.run()).error?.message).toBe('workspace unavailable')
    const planningFailure = world({ deps: { launcher: () => ({
      id: 'opencode', plan: async () => { throw new Error('planning unavailable') }
    }) } })
    expect((await planningFailure.run()).error?.message).toBe('This agent could not be started.')
  })

  it('cancels the session and reports no error', async () => {
    const w = world({ script: { prompt: { emit: [{ kind: 'awaitCancel' }] } } })
    const controller = new AbortController()
    const running = w.run({ signal: controller.signal })
    await waitFor(() => w.fake.received('session/prompt').length > 0, 'the prompt to arrive')
    controller.abort()
    const result = await running
    expect(result.error).toBeUndefined()
    expect(w.fake.received('session/cancel')).toHaveLength(1)
  })

  it('does not wait forever on an agent that ignores the cancel', async () => {
    // Without the grace this turn would hold the agent's lock until the
    // twenty-minute ceiling, for a stop the user watched do nothing.
    const w = world({ script: { prompt: { hang: true } } })
    const controller = new AbortController()
    const running = w.run({ signal: controller.signal })
    await waitFor(() => w.fake.received('session/prompt').length > 0, 'the prompt to arrive')
    controller.abort()
    const result = await running
    expect(result.error).toBeUndefined()
    // The process is retired rather than kept: a turn is still running inside
    // it, and the next prompt would interleave with work the user stopped.
    expect(w.pool.status(AGENT_ID).state).not.toBe('running')
  })

  it('answers a parked ask before it cancels, so the agent can unwind', async () => {
    // An agent blocked on `session/request_permission` cannot act on a cancel
    // it has not read. Without the refusal first, a Stop pressed while a
    // permission block is on screen would time out the grace and kill a
    // perfectly good process.
    const w = world({
      script: {
        prompt: {
          emit: [
            {
              kind: 'permission',
              toolCall: { toolCallId: 'call_1', kind: 'edit', status: 'pending' }
            }
          ]
        }
      }
    })
    const controller = new AbortController()
    const running = w.run({ signal: controller.signal })
    await askedFor(w)
    controller.abort()
    const result = await running
    expect(result.error).toBeUndefined()
    expect(w.fake.answers('session/request_permission')[0].result).toEqual({
      outcome: { outcome: 'selected', optionId: 'reject' }
    })
    // The turn ended by agreement, so the process is still there for the next one.
    expect(w.pool.status(AGENT_ID).state).toBe('running')
    // And the transcript says what happened: a park the *stop* released was
    // not abandoned, and recording "no answer in time" for a decision the user
    // took would be the same defect as recording "Denied" for an expiry.
    expect(result.parts.map((part) => part.text)).toContain(
      'Not answered — the turn was stopped.'
    )
    // And nobody is told an answer was recorded: the abort swept the ask away.
    expect(w.events.filter((event) => event.type === 'input_resolved')).toEqual([])
  })

  it('sends no prompt when the stop lands while the session is still being set up', async () => {
    // A one-to-two-second window — spawn, `session/new`, the setup calls — in
    // which `sessionId` is still null, so the stop has no `session/cancel` to
    // send. Without a second check the prompt goes out anyway: the agent starts
    // on work the user cancelled, and three seconds later the grace kills its
    // process, leaving an empty reply and a cold start for the next turn.
    const w = world({
      script: { setMode: { delayMs: 300 }, ...SAYS_HELLO },
      setup: { modeId: 'default' }
    })
    const controller = new AbortController()
    const running = w.run({ signal: controller.signal })
    await waitFor(() => w.fake.received('session/set_mode').length > 0, 'the setup to start')
    controller.abort()
    const result = await running
    expect(result.error).toBeUndefined()
    expect(w.fake.received('session/prompt')).toEqual([])
  })

  it('does not tell a parked ask that the user stopped a turn the ceiling ended', async () => {
    // The ceiling shares `askAgentToStop` with the user's Stop, and a park it
    // releases genuinely *was* never answered in time — which is what the
    // expiry wording says. Claiming the user stopped a turn they left running
    // for twenty minutes is the same kind of wrong the two wordings exist to
    // keep apart.
    const w = world({
      script: {
        prompt: {
          emit: [
            {
              kind: 'permission',
              toolCall: { toolCallId: 'call_1', kind: 'edit', status: 'pending' }
            }
          ]
        }
      },
      deps: { turnCeilingMs: 650 }
    })
    const running = w.run()
    await askedFor(w) // The ceiling must expire a parked ask, not cancel initialization.
    await running
    // Asserted on the stream rather than on `result.parts`: a decision written
    // while the turn is being torn down races the snapshot, which the OpenCode
    // runner's own golden recorded before this phase
    // (`abort_with_parked_question`, "the block stays in parts with no decision
    // record"). The wording is what is under test here, not when it lands.
    await settle(80)
    const written = w.events
      .filter((event): event is Extract<RunEvent, { type: 'delta' }> => event.type === 'delta')
      .map((event) => event.text)
    expect(written).toContain('No answer — the request expired.')
    expect(written).not.toContain('Not answered — the turn was stopped.')
  })

  it('gives up on a ceiling the agent never acknowledges, and says so', async () => {
    // The ceiling and the user's Stop share one grace: armed only by the abort,
    // a ceiling that the agent ignored would hold the agent's lock for the life
    // of the app — the exact failure the ceiling exists to prevent.
    const w = world({ script: { prompt: { hang: true } }, deps: { turnCeilingMs: 650 } })
    const running = w.run()
    await waitFor(() => w.fake.received('session/prompt').length === 1, 'the unresponsive prompt')
    const result = await running
    expect(result.error?.message).toMatch(/stopped responding/)
    expect(w.pool.status(AGENT_ID).state).not.toBe('running')
  })

  it('spawns nothing when the stop landed before the turn started', async () => {
    const w = world({ script: SAYS_HELLO })
    const controller = new AbortController()
    controller.abort()
    const result = await w.run({ signal: controller.signal })
    expect(result.error).toBeUndefined()
    expect(w.fake.log()).toEqual([])
  })
})

describe('a refusal', () => {
  it('reads back the launcher’s own sentence, and starts no process', async () => {
    const w = world({ refusal: 'This agent’s credential is not available to it.' })
    const result = await w.run()
    expect(result.error?.message).toBe('This agent’s credential is not available to it.')
    expect(w.fake.log()).toEqual([])
  })

  it('names the engine when the process will not start', async () => {
    const w = world({ script: { exitOnStart: { code: 3 } }, launcher: 'claude' })
    const result = await w.run()
    expect(result.error?.message).toMatch(/^Claude Code could not be started/)
  })

  it('refuses rather than running under a policy nobody chose when the setup is rejected', async () => {
    // Claude's `session/set_mode` is the only thing that overrides a
    // `defaultMode` from the user's own settings — which can be
    // `bypassPermissions`.
    const w = world({
      script: { setMode: { error: { code: -32602, message: 'Invalid Mode' } } },
      setup: { modeId: 'default' },
      launcher: 'claude'
    })
    const result = await w.run()
    expect(result.error?.message).toMatch(/could not be set up/)
    expect(w.fake.received('session/prompt')).toHaveLength(0)
  })

  it('refuses an agent whose folder is gone', async () => {
    const result = await world({ folder: null }).run()
    expect(result.error?.message).toMatch(/folder could not be found/)
  })

  it('refuses an agent that is switched off, by name', async () => {
    const result = await world({ folder: { ...FOLDER, enabled: false } }).run()
    expect(result.error?.message).toContain('Pineapple')
  })

  it('refuses an unreadable folder in the scanner’s own words', async () => {
    const result = await world({
      folder: { ...FOLDER, readiness: 'invalid', readinessReason: 'Its manifest is not valid.' }
    }).run()
    expect(result.error?.message).toBe('Its manifest is not valid.')
  })

  it('runs an engine a folder cannot use on OpenCode instead of refusing it', async () => {
    // `runtime.engine` is a preference, never refused: `gemini` has no launcher
    // and `custom` needs an external agent's row, so both run on OpenCode.
    for (const engine of ['gemini', 'custom', 'some-future-engine']) {
      const result = await world({
        script: SAYS_HELLO,
        launcher: 'opencode',
        folder: { ...FOLDER, runtime: { engine } }
      }).run()
      expect(result.error, engine).toBeUndefined()
    }
  })
})

describe('the launcher a turn runs on', () => {
  it('is the one the folder names now, not the one the row remembers', async () => {
    // The row is a cache; the folder is the truth. A manifest switched to
    // Claude a moment ago must not send the turn to OpenCode.
    const w = world({
      script: SAYS_HELLO,
      launcher: 'claude',
      folder: { ...FOLDER, runtime: { engine: 'claude' } }
    })
    const result = await w.run()
    expect(result.error).toBeUndefined()
  })

  it('is the default engine for a folder whose runtime names none', async () => {
    // "The runtime was read and names nothing" is an answer — the default —
    // and it is the same answer the scanner writes into the row, so a turn and
    // the list beside it cannot disagree about which engine an agent runs.
    const w = world({
      script: SAYS_HELLO,
      launcher: 'opencode',
      folder: { ...FOLDER, readiness: 'ok', runtime: null }
    })
    const result = await w.run()
    expect(result.error).toBeUndefined()
  })
})

describe('readiness', () => {
  it('is the folder’s alone when the launcher has no rungs of its own', async () => {
    const w = world({ script: SAYS_HELLO })
    await expect(w.driver.readiness(USER_ID, ROW)).resolves.toEqual({ state: 'ok', reason: null })
  })

  it('asks the launcher once the folder itself is ok', async () => {
    const w = world({
      launcherReadiness: async () => ({
        state: 'not_installed',
        reason: 'No Claude Code was found.'
      })
    })
    await expect(w.driver.readiness(USER_ID, ROW)).resolves.toEqual({
      state: 'not_installed',
      reason: 'No Claude Code was found.'
    })
  })

  describe('a folder missing credentials', () => {
    const MISSING = { ...FOLDER, readiness: 'credentials_needed' as const, readinessReason: 'Add the credentials.' }

    it('still asks the launcher, whose refusal outranks the warning', async () => {
      const w = world({
        folder: MISSING,
        launcherReadiness: async () => ({ state: 'not_logged_in', reason: 'Sign in to Codex.' })
      })
      await expect(w.driver.readiness(USER_ID, ROW)).resolves.toEqual({ state: 'not_logged_in', reason: 'Sign in to Codex.' })
    })

    it('keeps the warning when the launcher is ok', async () => {
      const w = world({ folder: MISSING, launcherReadiness: async () => ({ state: 'ok', reason: null }) })
      await expect(w.driver.readiness(USER_ID, ROW)).resolves.toEqual({
        state: 'credentials_needed',
        reason: 'Add the credentials.'
      })
    })
  })

  it('never starts a process to answer it', async () => {
    const w = world({ script: SAYS_HELLO })
    await w.driver.readiness(USER_ID, ROW)
    expect(w.fake.log()).toEqual([])
  })

  it('answers rather than throwing when the folder read fails', async () => {
    const w = world({ folderThrows: true })
    await expect(w.driver.readiness(USER_ID, ROW)).resolves.toEqual({
      state: 'invalid',
      reason: expect.any(String)
    })
  })
})

describe('capabilities', () => {
  it('says an OpenCode agent has no question path, because its tool is not registered over ACP', () => {
    const w = world()
    expect(w.driver.capabilities(ROW).input).toEqual({
      permission: true,
      question: false,
      auth: false,
      elicitation: false
    })
  })

  it('says a Claude agent does, because the launcher declares form elicitation', () => {
    const w = world()
    const claudeRow = { ...ROW, driverConfig: { launcher: 'claude' } }
    expect(w.driver.capabilities(claudeRow).input.question).toBe(true)
    // The user's own CLI login pays for the turn; the desktop holds no key.
    expect(w.driver.capabilities(claudeRow).auth).toBe('cli')
  })
})

/* ------------------------------------------------------------- the contract */

describeDriverContract(
  'acp',
  (): DriverContractSubject => {
    const subject = (options: WorldOptions = {}) => {
      const w = world(options)
      return {
        w,
        turn: {
          run: (io: { onEvent: (event: RunEvent) => void; signal: AbortSignal }) =>
            w.run({ onEvent: io.onEvent, signal: io.signal })
        }
      }
    }

    return {
      completes: () => subject({ script: SAYS_HELLO }).turn,
      failures: () => ({
        folder_gone: subject({ folder: null }).turn,
        switched_off: subject({ folder: { ...FOLDER, enabled: false } }).turn,
        launcher_refused: subject({ refusal: 'No credential for this agent.' }).turn,
        process_died: subject({ script: { exitOnStart: { code: 3 } } }).turn,
        prompt_failed: subject({
          script: { prompt: { error: { code: -32603, message: 'model not found' } } }
        }).turn,
        setup_rejected: subject({
          script: { setMode: { error: { code: -32602, message: 'Invalid Mode' } } },
          setup: { modeId: 'default' }
        }).turn
      }),
      hangs: () => {
        const { w, turn } = subject({ script: { prompt: { hang: true } } })
        return {
          ...turn,
          started: async () => {
            await waitFor(() => w.fake.received('session/prompt').length > 0, 'the prompt')
          }
        }
      },
      parks: () => {
        const { w, turn } = subject({
          script: {
            prompt: {
              emit: [
                {
                  kind: 'permission',
                  toolCall: {
                    toolCallId: 'call_1',
                    kind: 'edit',
                    status: 'pending',
                    rawInput: { filepath: '/tmp/agents/pineapple/notes.txt' }
                  }
                }
              ]
            }
          }
        })
        return {
          ...turn,
          answer: { kind: 'permission', reply: 'once' } as const,
          answerRequest: async (requestId, resolution) => {
            const owner = pendingRequests.owner(requestId)
            return owner ? w.driver.respond({ requestId, ...owner }, resolution) : { delivered: false }
          }
        }
      },
      session: () => {
        const w = world({ script: SAYS_HELLO })
        let readBySecond: string | null = null
        return {
          first: {
            run: (io) => w.run({ onEvent: io.onEvent, signal: io.signal, chatId: 'chat-session' })
          },
          second: {
            run: (io) => {
              readBySecond = w.sessions.get('chat-session') ?? null
              return w.run({ onEvent: io.onEvent, signal: io.signal, chatId: 'chat-session' })
            }
          },
          saved: () => w.saved,
          readBySecond: () => readBySecond
        }
      },
      underTest: () => {
        const w = world()
        return { driver: w.driver, row: ROW, grantsWritten: () => w.grants.length }
      },
      readinessWorlds: () => ({
        folder_throws: (() => {
          const w = world({ folderThrows: true })
          return { driver: w.driver, row: ROW, grantsWritten: () => w.grants.length }
        })(),
        launcher_rejects: (() => {
          const w = world({
            launcherReadiness: async () => {
              throw new TypeError('the probe blew up')
            }
          })
          return { driver: w.driver, row: ROW, grantsWritten: () => w.grants.length }
        })()
      })
    }
  }
)

it('prepares credential-dependent launch data under the lock and refuses a cleanup failure before spawning', async () => {
  let locked = false
  const w = world({ deps: {
    withLock: async (_id, _owner, run) => { locked = true; try { return await run() } finally { locked = false } },
    prepareCredentials: async () => { expect(locked).toBe(true); throw new Error('Old credential cleanup failed') }
  } })
  const result = await w.run()
  expect(result.error?.message).toContain('Old credential cleanup failed')
  expect(w.fake.log().some(entry => entry.dir === 'start')).toBe(false)
})

it('prepares credentials for the agent alone: delivery does not depend on the current profile', async () => {
  const seen: unknown[][] = []
  const w = world({ deps: {
    prepareCredentials: async (...args) => { seen.push(args); return args[1] }
  } })
  await w.run()
  expect(seen).toHaveLength(1)
  expect(seen[0]).toHaveLength(2)
  expect((seen[0][0] as { id: string }).id).toBe(ROW.id)
})

describe('concurrent turns on one agent', () => {
  /** The production dependency: a shared hold per turn. */
  const sharedLock: AcpDriverDeps['withLock'] = (agentId, owner, fn) => turnLock.withSharedLock(agentId, owner, fn)
  const chunk = (text: string): FakeAcpStep => ({
    kind: 'update',
    update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } }
  })

  afterEach(() => turnLock.releaseAll())

  it('runs two chats’ turns side by side in one process', async () => {
    let inside = 0
    let peak = 0
    const w = world({
      script: { newSession: { uniqueIds: true }, prompt: { emit: [{ kind: 'delay', ms: 250 }, chunk('Hello.')] } },
      deps: { withLock: (agentId, owner, fn) => sharedLock(agentId, owner, async () => {
        inside++; peak = Math.max(peak, inside)
        try { return await fn() } finally { inside-- }
      }) }
    })
    const [one, two] = await Promise.all([w.run({ chatId: 'chat-a' }), w.run({ chatId: 'chat-b' })])
    expect(one.error).toBeUndefined()
    expect(two.error).toBeUndefined()
    expect(one.text).toBe('Hello.')
    expect(two.text).toBe('Hello.')
    expect(peak).toBe(2)
    expect(w.fake.received('session/prompt')).toHaveLength(2)
    expect(w.fake.log().filter((entry) => entry.dir === 'start')).toHaveLength(1)
    expect(turnLock.isLocked(AGENT_ID)).toBe(false)
  })

  it('keeps a sibling turn’s process when another turn is stopped while its session starts', async () => {
    const w = world({
      script: { newSession: { uniqueIds: true }, setMode: { delayMs: 300 }, prompt: { emit: [{ kind: 'delay', ms: 700 }, chunk('Hello.')] } },
      setup: { modeId: 'default' },
      deps: { withLock: sharedLock }
    })
    const first = w.run({ chatId: 'chat-a' })
    await waitFor(() => w.fake.received('session/prompt').length === 1, 'the first turn to prompt')
    const controller = new AbortController()
    const second = w.run({ chatId: 'chat-b', signal: controller.signal })
    await waitFor(() => w.fake.received('session/set_mode').length === 2, 'the second turn’s setup')
    controller.abort()
    expect((await second).error).toBeUndefined()
    // Nor does the stop retire that process: a third chat runs beside the first
    // instead of waiting for it to drain.
    let firstDone = false
    void first.then(() => { firstDone = true })
    const third = w.run({ chatId: 'chat-c' })
    await waitFor(() => w.fake.received('session/prompt').length === 2, 'the third turn to prompt')
    expect(firstDone).toBe(false)
    const result = await first
    expect(result.error).toBeUndefined()
    expect(result.text).toBe('Hello.')
    expect((await third).error).toBeUndefined()
  })

  it('refuses a turn while an exclusive folder write holds the agent', async () => {
    const w = world({ script: SAYS_HELLO, deps: { withLock: sharedLock } })
    const editor = turnLock.acquire(AGENT_ID, 'editor')
    try {
      expect((await w.run()).error?.message).toMatch(/busy/i)
      expect(w.fake.log().some((entry) => entry.dir === 'start')).toBe(false)
    } finally { editor.release() }
  })
})
