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
import type { AgentDriver } from '../driver'
import { pendingRequests } from '../pendingRequests'
import {
  describeDriverContract,
  type DriverContractSubject
} from '../__golden__/driverContract'
import { goldenRow } from '../__golden__/driverWorld'
import { createAcpDriver, type AcpDriverDeps, type AcpFolderView, type AcpRuntimeView } from './acpDriver'
import { createAcpProcessPool } from './acpProcessPool'
import { startAcpConnection } from './acpConnection'
import type { AcpLauncher, AcpLaunchPlan, AcpPlanResult } from './acpLaunchers'
import { createFakeAcp, settle, waitFor, type FakeAcp, type FakeAcpScript } from './testSupport/fakeAcp'
import { ACP_PROTOCOL_VERSION, type AcpLauncherId, type AcpProcessPool } from './types'

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
    ...(options.launcherReadiness ? { readiness: options.launcherReadiness } : {})
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
        onEvent: overrides.onEvent ?? ((event) => void events.push(event))
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

  it('refuses an engine this build has no launcher for', async () => {
    const result = await world({
      folder: { ...FOLDER, runtime: { engine: 'gemini' } }
    }).run()
    expect(result.error?.message).toMatch(/does not support/)
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
