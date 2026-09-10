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

import { afterEach, describe, expect, it } from 'vitest'
import type { LocalAgentKind } from '../../../../shared/localAgents'
import type { LocalPermissionRequest } from '../../../../shared/localAgentRequests'
import type { RunEvent } from '../../../../shared/runEvents'
import type { AgentDriver } from '../driver'
import { pendingRequests } from '../../../services/agentTurn/pendingRequests'
import {
  describeDriverContract,
  type DriverContractSubject
} from '../../../services/agentTurn/__golden__/driverContract'
import { goldenRow } from '../../../services/agentTurn/__golden__/driverWorld'
import { createAcpDriver, type AcpDriverDeps, type AcpFolderView } from './acpDriver'
import { createAcpProcessPool } from './acpProcessPool'
import { startAcpConnection } from './acpConnection'
import type { AcpLauncher, AcpLaunchPlan, AcpPlanResult } from './acpLaunchers'
import { createFakeAcp, waitFor, type FakeAcp, type FakeAcpScript } from './testSupport/fakeAcp'
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
    readFolder: () => {
      if (options.folderThrows) throw new Error('the folder could not be read')
      if (options.folder !== undefined) return options.folder
      // The folder names the launcher the world was built for: the turn
      // reconciles against the folder, so a world whose launcher and folder
      // disagreed would be testing the reconcile rather than the launcher.
      return { ...FOLDER, runtime: { engine: launcher.id } }
    },
    readSession: (chatId) => sessions.get(chatId) ?? null,
    saveSession: ({ chatId, sessionId }) => {
      saved.push(sessionId)
      sessions.set(chatId, sessionId)
    },
    isGranted: () => options.granted === true,
    rememberGrant: (_agentId, request) => {
      if (options.grantWriteFails) return false
      grants.push(request)
      return true
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

  it('denies, in words written for the model, when the park expires', async () => {
    const w = world({ script: ASKS })
    const running = w.run()
    const asked = await askedFor(w)
    expect(pendingRequests.resolve(asked.requestId, { kind: 'rejected' })).not.toBeNull()
    await running
    expect(w.fake.answers('session/request_permission')[0].result).toEqual({
      outcome: { outcome: 'selected', optionId: 'reject' }
    })
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
    expect(pendingRequests.resolve(asked.requestId, { kind: 'question', answers: [['Blue']] })).not.toBeNull()
    await running
    expect(w.fake.answers('elicitation/create')[0].result).toEqual({
      action: 'accept',
      content: { question_0: 'Blue' }
    })
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

describe('a stop', () => {
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
    // And nobody is told an answer was recorded: the abort swept the ask away.
    expect(w.events.filter((event) => event.type === 'input_resolved')).toEqual([])
  })

  it('gives up on a ceiling the agent never acknowledges, and says so', async () => {
    // The ceiling and the user's Stop share one grace: armed only by the abort,
    // a ceiling that the agent ignored would hold the agent's lock for the life
    // of the app — the exact failure the ceiling exists to prevent.
    const w = world({ script: { prompt: { hang: true } }, deps: { turnCeilingMs: 50 } })
    const result = await w.run()
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

  it('is the row’s when the folder cannot speak for itself', async () => {
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
      parks: () => ({
        ...subject({
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
        }).turn,
        answer: { kind: 'permission', reply: 'once' } as const
      }),
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
  },
  {
    knownViolations: {
      // Inherited deliberately from both runners it replaces: an aborted turn
      // returns the parts it collected with **no** `error` and no `canceled`
      // task state, because a stop the user asked for is not a failure. The
      // terminal event posted above the driver is what the renderer acts on.
      // Whoever gives a run its own stop reason (phase 5's task states) is who
      // deletes this entry.
      'abort.reports': 'an aborted ACP turn reports parts with no error, like both runners before it'
    }
  }
)
