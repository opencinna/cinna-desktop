import { describe, it, expect, vi, beforeEach } from 'vitest'
import { ClaudeAgentTurnRunner, type ClaudeTurnDeps } from './claudeAgentTurnRunner'
import type { RunAgentTurnInput } from '../a2aStreamingService'
import type { AgentStreamEvent } from '../../../shared/agentStreamEvents'

vi.mock('../../logger/logger', () => ({
  createLogger: () => ({ debug: () => {}, info: () => {}, warn: () => {}, error: () => {} })
}))

/**
 * The Claude runner, driven with no child process and no Electron.
 *
 * The `query` function is injected, which is the whole reason this file can
 * exist: every property below is about how the runner reacts to a **stream
 * shape**, and the shapes that matter are the ones the SDK produces on a bad
 * day. Those were watched against the real binary
 * (`docs/agents/local_agents/claude_contract.md`) and none of them is visible
 * in the SDK's types:
 *
 * - a failure arrives as a **thrown exception**, never as a `result` message;
 * - a cancellation is also a throw, and its `.name` is `'Error'`;
 * - a `resume` against a forgotten session throws, and is told apart from
 *   every other failure only by the wording of its message.
 *
 * `runTurn` never throwing is the contract all of that has to survive: an
 * exception crossing `ipcMain.handle` loses its code, and the renderer is left
 * streaming forever with neither `done` nor `error` posted.
 */

const MSG = 'msg_1'

/** A generator over a fixed list, which throws at the end when told to. */
function stubQuery(script: {
  messages?: unknown[]
  throws?: Error
  onOptions?: (options: Record<string, unknown>) => void
}): ClaudeTurnDeps['query'] {
  return ((args: { options?: Record<string, unknown> }) => {
    script.onOptions?.(args.options ?? {})
    return (async function* () {
      for (const m of script.messages ?? []) yield m
      if (script.throws) throw script.throws
    })()
  }) as unknown as ClaudeTurnDeps['query']
}

const init = {
  type: 'system',
  subtype: 'init',
  session_id: 'sess-new',
  apiKeySource: 'none',
  model: 'claude-opus-5',
  claude_code_version: '2.1.266'
}
const answer = [
  { type: 'stream_event', session_id: 'sess-new', event: { type: 'message_start', message: { id: MSG } } },
  { type: 'stream_event', event: { type: 'content_block_start', index: 0, content_block: { type: 'text' } } },
  { type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'marzipan' } } },
  { type: 'result', subtype: 'success', is_error: false, result: 'marzipan', session_id: 'sess-new' }
]

const saved: unknown[] = []
let deps: ClaudeTurnDeps

function makeDeps(over: Partial<ClaudeTurnDeps> = {}): ClaudeTurnDeps {
  return {
    getAgent: () => ({
      name: 'Invoices',
      path: '/agents/invoices',
      kind: 'kit',
      enabled: true,
      readiness: 'ok',
      readinessReason: null
    }),
    systemPrompt: () => 'You are the invoices agent.',
    model: () => 'sonnet',
    claudePath: async () => '/usr/local/bin/claude',
    claudeAuth: async () => ({ state: 'logged_in', authMethod: 'claude.ai', subscriptionType: 'max', email: 'someone@example.com' }) as const,
    shellEnv: async () => ({ PATH: '/usr/bin', HOME: '/Users/x', USER: 'x' }),
    appVersion: () => '1.2.3',
    readSession: () => null,
    saveSession: (s) => void saved.push(s),
    withLock: (_agentId, _owner, fn) => fn(),
    userId: () => 'user-1',
    isGranted: () => false,
    query: stubQuery({ messages: [init, ...answer] }),
    ...over
  }
}

function turn(over: Partial<RunAgentTurnInput> = {}): RunAgentTurnInput {
  return {
    chatId: 'chat-1',
    agentId: 'folder:aaa',
    agentName: 'Invoices',
    wireContent: 'what is the secret word?',
    signal: new AbortController().signal,
    ...over
  }
}

beforeEach(() => {
  saved.length = 0
  deps = makeDeps()
})

describe('a turn that works', () => {
  it('streams the answer into parts and remembers the session', async () => {
    const events: AgentStreamEvent[] = []
    const result = await new ClaudeAgentTurnRunner(deps).runTurn(
      turn({ onEvent: (e) => void events.push(e) })
    )
    expect(result.error).toBeUndefined()
    expect(result.text).toBe('marzipan')
    expect(result.contextId).toBe('sess-new')
    expect(events.filter((e) => e.type === 'delta')).toHaveLength(1)
    expect(saved).toEqual([
      {
        chatId: 'chat-1',
        agentId: 'folder:aaa',
        agentDir: '/agents/invoices',
        agentKind: 'kit',
        sessionId: 'sess-new'
      }
    ])
  })

  it('takes the per-agent lock, so the agent is busy in a second chat', async () => {
    const withLock = vi.fn((_a: string, _o: string, fn: () => Promise<unknown>) => fn())
    await new ClaudeAgentTurnRunner(makeDeps({ withLock: withLock as never })).runTurn(turn())
    expect(withLock).toHaveBeenCalledWith('folder:aaa', 'turn', expect.any(Function))
  })
})

describe('the options handed to the SDK', () => {
  const capture = async (over: Partial<ClaudeTurnDeps> = {}): Promise<Record<string, unknown>> => {
    let options: Record<string, unknown> = {}
    await new ClaudeAgentTurnRunner(
      makeDeps({
        query: stubQuery({ messages: [init, ...answer], onOptions: (o) => (options = o) }),
        ...over
      })
    ).runTurn(turn())
    return options
  }

  it('closes the boundary the user’s own config would otherwise redefine', async () => {
    const options = await capture()
    // `settingSources: []` alone is NOT the boundary — verified against the
    // real binary, which still attached the user's Gmail, Drive and Calendar
    // connectors. These three travel together or the isolation is a fiction.
    expect(options.settingSources).toEqual([])
    expect(options.strictMcpConfig).toBe(true)
    expect(options.mcpServers).toEqual({})
  })

  it('asks for partial messages, without which the turn looks hung', async () => {
    expect((await capture()).includePartialMessages).toBe(true)
  })

  it('passes no allowedTools, which would shadow the permission callback', async () => {
    // A bare tool name there auto-approves before `canUseTool` is consulted —
    // the SDK warns `CLAUDE_SDK_CAN_USE_TOOL_SHADOWED`. Phase 4's grant
    // registry is meaningless unless this stays absent.
    expect(Object.hasOwn(await capture(), 'allowedTools')).toBe(false)
  })

  it('runs the user’s own binary, never the SDK’s bundled one', async () => {
    expect((await capture()).pathToClaudeCodeExecutable).toBe('/usr/local/bin/claude')
  })

  it('sends the folder’s assembled prompt as a plain string, not a preset', async () => {
    expect((await capture()).systemPrompt).toBe('You are the invoices agent.')
  })

  it('hands over a constructed environment with no key in it', async () => {
    const env = (await capture({
      shellEnv: async () => ({
        PATH: '/usr/bin',
        HOME: '/Users/x',
        USER: 'x',
        ANTHROPIC_API_KEY: 'sk-ant-real'
      })
    }).then((o) => o.env)) as Record<string, string>
    expect(env.USER).toBe('x')
    expect(Object.hasOwn(env, 'ANTHROPIC_API_KEY')).toBe(false)
    expect(env.CLAUDE_AGENT_SDK_CLIENT_APP).toBe('cinna-desktop/1.2.3')
  })

  it('omits the model entirely when the runtime names none', async () => {
    // Absent, not null: the CLI picks its own default, and an explicit null
    // would be a value it has to interpret.
    expect(Object.hasOwn(await capture({ model: () => null }), 'model')).toBe(false)
  })
})

describe('readiness, answered before the turn rather than as a failed one', () => {
  it('says so when there is no Claude Code on this machine', async () => {
    const result = await new ClaudeAgentTurnRunner(
      makeDeps({ claudePath: async () => null, query: stubQuery({ throws: new Error('never') }) })
    ).runTurn(turn())
    expect(result.error?.message).toMatch(/no Claude Code installation was found/)
  })

  it('names the remedy when that install is not logged in, without offering to do it', async () => {
    // The CLI's own words are "Not logged in · Please run /login", which names
    // a command that does not exist outside its REPL. Logging in is something
    // only the user can do, against their own account.
    const result = await new ClaudeAgentTurnRunner(
      makeDeps({
        query: stubQuery({
          throws: new Error('Claude Code returned an error result: Not logged in · Please run /login')
        })
      })
    ).runTurn(turn())
    expect(result.error?.message).toMatch(/not logged in/i)
    expect(result.error?.message).toMatch(/claude` in a terminal/)
  })

  it('a logged-out install is refused before a turn is spawned, not after one fails', async () => {
    // The rung that used to cost a turn. `claude auth status` answers it for
    // free, so the user reads the remedy instead of waiting for a turn to come
    // back with the CLI's own words.
    let spawned = false
    const result = await new ClaudeAgentTurnRunner(
      makeDeps({
        claudeAuth: async () => ({ state: 'logged_out', authMethod: 'none', subscriptionType: null, email: null }),
        query: stubQuery({
          onOptions: () => void (spawned = true),
          messages: [init, ...answer]
        })
      })
    ).runTurn(turn())

    expect(result.error?.message).toMatch(/not logged in/i)
    expect(result.error?.message).toMatch(/claude` in a terminal/)
    expect(spawned).toBe(false)
  })

  it('a probe that could not answer runs the turn anyway', async () => {
    // `unknown` is not evidence of a logged-out install. A readiness check that
    // can refuse a working engine on its own uncertainty is worse than none —
    // and the thrown-error fallback above still covers the case it missed.
    const result = await new ClaudeAgentTurnRunner(
      makeDeps({ claudeAuth: async () => ({ state: 'unknown', authMethod: null, subscriptionType: null, email: null }) })
    ).runTurn(turn())

    expect(result.error).toBeUndefined()
    expect(result.text).toBe('marzipan')
  })

  it('a readiness probe that rejects does not become a thrown turn', async () => {
    // This one is awaited outside `runTurn`'s `try`. A rejection escaping here
    // loses its code across `ipcMain.handle` and leaves the renderer streaming
    // with neither `done` nor `error` — the never-throws contract broken by the
    // check that exists to make turns fail *less*.
    const result = await new ClaudeAgentTurnRunner(
      makeDeps({ claudeAuth: async () => { throw new Error('the probe blew up') } })
    ).runTurn(turn())

    expect(result.error).toBeUndefined()
    expect(result.text).toBe('marzipan')
  })

  it('no install outranks a login: the probe is never consulted for it', async () => {
    let asked = false
    const result = await new ClaudeAgentTurnRunner(
      makeDeps({
        claudePath: async () => null,
        claudeAuth: async () => {
          asked = true
          return { state: 'logged_out', authMethod: 'none', subscriptionType: null, email: null }
        }
      })
    ).runTurn(turn())

    expect(result.error?.message).toMatch(/no Claude Code installation was found/)
    expect(asked).toBe(false)
  })

  it('refuses a switched-off agent and a folder that does not validate', async () => {
    const off = await new ClaudeAgentTurnRunner(
      makeDeps({
        getAgent: () => ({
          name: 'Invoices',
          path: '/p',
          kind: 'kit',
          enabled: false,
          readiness: 'ok',
          readinessReason: null
        })
      })
    ).runTurn(turn())
    expect(off.error?.message).toMatch(/switched off/)

    const invalid = await new ClaudeAgentTurnRunner(
      makeDeps({
        getAgent: () => ({
          name: 'Invoices',
          path: '/p',
          kind: 'kit',
          enabled: true,
          readiness: 'invalid',
          readinessReason: 'Its manifest does not parse.'
        })
      })
    ).runTurn(turn())
    expect(invalid.error?.message).toBe('Its manifest does not parse.')
  })
})

describe('runTurn never throws', () => {
  it('turns a thrown SDK failure into a result carrying the error', async () => {
    // The structural fact this runner is built around: the SDK reports failures
    // by throwing out of the async iterator, not by yielding a `result`.
    const result = await new ClaudeAgentTurnRunner(
      makeDeps({ query: stubQuery({ throws: new Error('the child exited with code 1') }) })
    ).runTurn(turn())
    expect(result.error?.message).toBe('the child exited with code 1')
  })

  it('keeps what streamed before the failure', async () => {
    // An error after a partial answer must not blank the answer.
    const result = await new ClaudeAgentTurnRunner(
      makeDeps({
        query: stubQuery({
          messages: [init, ...answer.slice(0, 3)],
          throws: new Error('the connection dropped')
        })
      })
    ).runTurn(turn())
    expect(result.text).toBe('marzipan')
    expect(result.error?.message).toBe('the connection dropped')
  })

  it('turns a lock refusal into a result, not a rejection', async () => {
    const result = await new ClaudeAgentTurnRunner(
      makeDeps({
        withLock: () => Promise.reject(new Error('This agent is busy right now.'))
      })
    ).runTurn(turn())
    expect(result.error?.message).toBe('This agent is busy right now.')
  })

  it('reports an error result the SDK yielded rather than threw', async () => {
    const result = await new ClaudeAgentTurnRunner(
      makeDeps({
        query: stubQuery({
          messages: [
            init,
            { type: 'result', subtype: 'error_during_execution', is_error: true, result: 'out of usage' }
          ]
        })
      })
    ).runTurn(turn())
    expect(result.error?.message).toBe('out of usage')
  })
})

describe('who paid for the turn', () => {
  it('says nothing when the CLI reports the install’s own login', () => {
    // `'none'` is a claude.ai login. This app never *asserts* a subscription —
    // it only reports when the CLI says otherwise — so the healthy case is
    // silent.
    return new ClaudeAgentTurnRunner(deps).runTurn(turn()).then((result) => {
      expect(result.notices).toEqual([])
    })
  })

  it('puts a non-none apiKeySource in the transcript, not only in the log', async () => {
    // **The failure that otherwise looks exactly like success.** A value other
    // than `'none'` means something reached the child that the environment
    // construction intended to strip, and the person is being billed on an
    // account they did not pick in the Runs-with panel. Nobody reads the log
    // until they already suspect something, so this has to be where they are.
    const result = await new ClaudeAgentTurnRunner(
      makeDeps({
        query: stubQuery({
          messages: [{ ...init, apiKeySource: 'ANTHROPIC_API_KEY' }, ...answer]
        })
      })
    ).runTurn(turn())

    expect(result.notices).toHaveLength(1)
    expect(result.notices[0].text).toMatch(/did not run on your Claude Code login/)
    expect(result.notices[0].text).toMatch(/ANTHROPIC_API_KEY/)
    // The turn itself still succeeded — this is a warning about billing, not a
    // failure, and blanking the answer would help nobody.
    expect(result.error).toBeUndefined()
    expect(result.text).toBe('marzipan')
  })

  it('reports it on a turn that failed after init, which was still billed', async () => {
    // **Every exit, not just the happy one.** The observation is made at the
    // init message; a turn that reported the wrong account and *then* failed
    // has still been billed to it, so the exit path it took cannot decide
    // whether the user is told.
    const result = await new ClaudeAgentTurnRunner(
      makeDeps({
        query: stubQuery({
          messages: [{ ...init, apiKeySource: 'ANTHROPIC_API_KEY' }, ...answer.slice(0, 3)],
          throws: new Error('the connection dropped')
        })
      })
    ).runTurn(turn())
    expect(result.error).toBeTruthy()
    expect(result.notices.map((n) => n.text).join(' ')).toMatch(/ANTHROPIC_API_KEY/)
  })

  it('reports it on a turn the user cancelled, which was also billed', async () => {
    const controller = new AbortController()
    const query = (() =>
      (async function* () {
        yield { ...init, apiKeySource: 'ANTHROPIC_API_KEY' }
        for (const m of answer.slice(0, 3)) yield m
        controller.abort()
        throw Object.assign(new Error('Claude Code process aborted by user'), { name: 'Error' })
      })()) as unknown as ClaudeTurnDeps['query']

    const result = await new ClaudeAgentTurnRunner(makeDeps({ query })).runTurn(
      turn({ signal: controller.signal })
    )
    // Cancelling is not an error, but it does not undo the billing.
    expect(result.error).toBeUndefined()
    expect(result.notices.map((n) => n.text).join(' ')).toMatch(/ANTHROPIC_API_KEY/)
  })

  it('reports it on a turn that hit the ceiling, which was billed longest of all', async () => {
    // The third exit. A turn that ran to the twenty-minute ceiling on the wrong
    // account is the most expensive way to get this wrong, and was the one path
    // with no test pinning it.
    const query = ((args: { options?: { abortController?: AbortController } }) => {
      const signal = args.options?.abortController?.signal
      return (async function* () {
        yield { ...init, apiKeySource: 'ANTHROPIC_API_KEY' }
        await new Promise<void>((resolve) => signal?.addEventListener('abort', () => resolve()))
        throw new Error('Claude Code process aborted by user')
      })()
    }) as unknown as ClaudeTurnDeps['query']

    const result = await new ClaudeAgentTurnRunner(
      makeDeps({ query, turnCeilingMs: 10 })
    ).runTurn(turn())
    expect(result.error?.message).toMatch(/stopped responding/)
    expect(result.notices.map((n) => n.text).join(' ')).toMatch(/ANTHROPIC_API_KEY/)
  })

  it('says nothing when no turn ever reported one', async () => {
    // A turn that failed before the init message has no observation to report,
    // and inventing one would be the assertion this whole rule exists against.
    const result = await new ClaudeAgentTurnRunner(
      makeDeps({ query: stubQuery({ throws: new Error('the child exited with code 1') }) })
    ).runTurn(turn())
    expect(result.notices).toEqual([])
  })
})

describe('cancellation', () => {
  it('is not an error, though it arrives as a throw, and keeps what streamed', async () => {
    // The abort throws with `.name === 'Error'`, not `'AbortError'`, so the
    // only thing separating "the user pressed stop" from "the agent crashed" is
    // `signal.aborted`. Reporting a stop as an error tells the user something
    // went wrong when they made it go right.
    //
    // Aborted **mid-stream**, not before the call: a signal already aborted on
    // entry is a different case entirely — the runner spawns nothing at all for
    // it — and constructing this one that way would test that branch instead of
    // this one, while looking like it tested this one.
    const controller = new AbortController()
    const query = (() => {
      return (async function* () {
        yield init
        for (const m of answer.slice(0, 3)) yield m
        controller.abort()
        throw Object.assign(new Error('Claude Code process aborted by user'), { name: 'Error' })
      })()
    }) as unknown as ClaudeTurnDeps['query']

    const result = await new ClaudeAgentTurnRunner(makeDeps({ query })).runTurn(
      turn({ signal: controller.signal })
    )
    expect(result.error).toBeUndefined()
    expect(result.text).toBe('marzipan')
  })
})

describe('an abort that lands before the turn starts', () => {
  it('spawns no child at all, rather than running a turn nobody wanted', async () => {
    // **`addEventListener('abort')` on an already-aborted signal never fires.**
    // The pre-flight awaits (`claudePath`, `shellEnv`) happen before the
    // listener is attached, so a stop landing in that window was dropped: the
    // ceiling controller was never aborted, and the `claude` child ran the
    // whole turn — spending the user's plan on a turn they had cancelled — while
    // the result was still reported, correctly, as "not an error".
    let called = 0
    const query = (() => {
      called++
      return (async function* () {
        yield init
      })()
    }) as unknown as ClaudeTurnDeps['query']

    const controller = new AbortController()
    controller.abort()
    const result = await new ClaudeAgentTurnRunner(makeDeps({ query })).runTurn(
      turn({ signal: controller.signal })
    )

    expect(called).toBe(0)
    expect(result.error).toBeUndefined()
    expect(result.text).toBe('')
  })

  it('spawns nothing when the abort lands during pre-flight either', async () => {
    // The same window from the other side: the signal is live when `runTurn` is
    // entered and aborts while `claudePath()` is still resolving — which is a
    // real await, since detection walks the login-shell PATH and macOS app
    // bundles on first use.
    const controller = new AbortController()
    let called = 0
    const query = (() => {
      called++
      return (async function* () {
        yield init
      })()
    }) as unknown as ClaudeTurnDeps['query']

    await new ClaudeAgentTurnRunner(
      makeDeps({
        claudePath: async () => {
          controller.abort()
          return '/usr/local/bin/claude'
        },
        query
      })
    ).runTurn(turn({ signal: controller.signal }))

    expect(called).toBe(0)
  })
})

describe('session continuity', () => {
  it('resumes the remembered session', async () => {
    let options: Record<string, unknown> = {}
    await new ClaudeAgentTurnRunner(
      makeDeps({
        readSession: () => 'sess-old',
        query: stubQuery({ messages: [init, ...answer], onOptions: (o) => (options = o) })
      })
    ).runTurn(turn())
    expect(options.resume).toBe('sess-old')
  })

  it('starts a fresh session when the CLI has forgotten the remembered one', async () => {
    // There is no endpoint to ask whether a session exists, so it is verified
    // by use. A forgotten one throws, and the right answer is to start over and
    // carry on **without explaining** — the user asked a question, not to be
    // told about our bookkeeping.
    const seen: (string | undefined)[] = []
    let call = 0
    const query = ((args: { options?: Record<string, unknown> }) => {
      seen.push(args.options?.resume as string | undefined)
      const first = call++ === 0
      return (async function* () {
        if (first) {
          throw new Error(
            'Claude Code returned an error result: No conversation found with session ID: sess-old'
          )
        }
        for (const m of [init, ...answer]) yield m
      })()
    }) as unknown as ClaudeTurnDeps['query']

    const result = await new ClaudeAgentTurnRunner(
      makeDeps({ readSession: () => 'sess-old', query })
    ).runTurn(turn())

    expect(seen).toEqual(['sess-old', undefined])
    expect(result.error).toBeUndefined()
    expect(result.text).toBe('marzipan')
  })

  it('does not retry an error that merely mentions a session id', async () => {
    // The trigger is the *observed* wording and nothing wider. Every error
    // result arrives with the same `errorClass`, so the message text is the
    // only discriminator there is — and a rate-limit or state error that names
    // the session would otherwise re-run the whole turn, billing a second one
    // for a failure that had nothing to do with continuity.
    let calls = 0
    const query = (() => {
      calls++
      return (async function* () {
        throw new Error(
          'Claude Code returned an error result: rate limit reached for session id abc-123'
        )
        // eslint-disable-next-line no-unreachable
        yield undefined
      })()
    }) as unknown as ClaudeTurnDeps['query']

    await new ClaudeAgentTurnRunner(makeDeps({ readSession: () => 'sess-old', query })).runTurn(
      turn()
    )
    expect(calls).toBe(1)
  })

  it('does not retry once the turn has already streamed something', async () => {
    // **The duplication guard.** The retry reuses this turn's accumulator, and
    // a second pass arrives under fresh message ids — so its parts are appended
    // to the first pass's, not swapped for them, and the user reads the answer
    // twice. A turn that has already streamed has no forgotten session to
    // blame: the CLI plainly found one.
    let calls = 0
    const query = (() => {
      calls++
      return (async function* () {
        yield init
        for (const m of answer.slice(0, 3)) yield m
        throw new Error(
          'Claude Code returned an error result: No conversation found with session ID: sess-old'
        )
      })()
    }) as unknown as ClaudeTurnDeps['query']

    const result = await new ClaudeAgentTurnRunner(
      makeDeps({ readSession: () => 'sess-old', query })
    ).runTurn(turn())

    expect(calls).toBe(1)
    // The partial answer is kept, once, with the failure reported beside it.
    expect(result.text).toBe('marzipan')
    expect(result.error).toBeTruthy()
  })

  it('does not retry a failure that is not a forgotten session', async () => {
    // Retrying an ordinary failure would double every failed turn's cost and
    // its wait.
    let calls = 0
    const query = (() => {
      calls++
      return (async function* () {
        throw new Error('Claude Code returned an error result: something else entirely')
        // eslint-disable-next-line no-unreachable
        yield undefined
      })()
    }) as unknown as ClaudeTurnDeps['query']

    await new ClaudeAgentTurnRunner(makeDeps({ readSession: () => 'sess-old', query })).runTurn(
      turn()
    )
    expect(calls).toBe(1)
  })

  it('does not retry when there was no remembered session to blame', async () => {
    let calls = 0
    const query = (() => {
      calls++
      return (async function* () {
        throw new Error('No conversation found with session ID: whatever')
        // eslint-disable-next-line no-unreachable
        yield undefined
      })()
    }) as unknown as ClaudeTurnDeps['query']

    await new ClaudeAgentTurnRunner(makeDeps({ readSession: () => null, query })).runTurn(turn())
    expect(calls).toBe(1)
  })
})

describe('the ceiling', () => {
  it('ends a turn that never ends, rather than holding the lock for ever', async () => {
    // A turn that never settles holds its per-agent lock for the life of the
    // app. The generator here yields nothing and never returns until aborted.
    const query = ((args: { options?: { abortController?: AbortController } }) => {
      const signal = args.options?.abortController?.signal
      return (async function* () {
        yield init
        await new Promise<void>((resolve) => signal?.addEventListener('abort', () => resolve()))
        throw new Error('Claude Code process aborted by user')
      })()
    }) as unknown as ClaudeTurnDeps['query']

    const result = await new ClaudeAgentTurnRunner(
      makeDeps({ query, turnCeilingMs: 10 })
    ).runTurn(turn())
    expect(result.error?.message).toMatch(/stopped responding/)
  })
})

describe('permissions', () => {
  /** A stub whose generator calls `canUseTool` once, then answers accordingly. */
  function permissionQuery(record: {
    decision?: { behavior: string; message?: string }
    calls?: number
  }): ClaudeTurnDeps['query'] {
    return ((args: { options?: { canUseTool?: (n: string, i: Record<string, unknown>) => Promise<unknown> } }) =>
      (async function* () {
        yield init
        yield {
          type: 'stream_event',
          session_id: 'sess-new',
          event: { type: 'message_start', message: { id: MSG } }
        }
        const decision = (await args.options?.canUseTool?.('Bash', {
          command: 'rm -rf /tmp/x'
        })) as { behavior: string; message?: string }
        record.decision = decision
        record.calls = (record.calls ?? 0) + 1
        yield { type: 'result', subtype: 'success', is_error: false, result: 'ok', session_id: 'sess-new' }
      })()) as unknown as ClaudeTurnDeps['query']
  }

  /**
   * Answer the one parked request as soon as it is registered.
   *
   * Through the real `pendingRequests`, not a stub, because the registry is the
   * half of this that the IPC answer path also drives — a stub here would test
   * the runner against a registry that does not exist.
   */
  async function answerWhenAsked(
    reply: 'once' | 'always' | 'reject',
    remembered = false
  ): Promise<void> {
    const { pendingRequests } = await import('./pendingRequests')
    for (let i = 0; i < 400; i++) {
      const [first] = pendingRequests.listForChat('chat-1')
      if (first) {
        pendingRequests.resolve(first.requestId, { kind: 'permission', reply, remembered })
        return
      }
      await new Promise((r) => setTimeout(r, 5))
    }
    throw new Error('no permission request was ever registered')
  }

  it('never puts a bare tool name in allowedTools, and always passes canUseTool', async () => {
    // The two are mutually exclusive in practice: a bare name auto-approves
    // before the callback runs, so the desktop's grants would be bypassed for
    // exactly the tools a profile named. The SDK warns about it by name.
    let options: Record<string, unknown> = {}
    await new ClaudeAgentTurnRunner(
      makeDeps({
        query: stubQuery({ messages: [init, ...answer], onOptions: (o) => (options = o) })
      })
    ).runTurn(turn())
    expect(Object.hasOwn(options, 'allowedTools')).toBe(false)
    expect(typeof options.canUseTool).toBe('function')
  })

  it('allows silently when a standing grant already covers the ask', async () => {
    // No block, no wait. A block that appeared and answered itself milliseconds
    // later would be a widget the user cannot act on, mid-stream.
    const record: { decision?: { behavior: string } } = {}
    const events: AgentStreamEvent[] = []
    const result = await new ClaudeAgentTurnRunner(
      makeDeps({ isGranted: () => true, query: permissionQuery(record) })
    ).runTurn(turn({ onEvent: (e) => void events.push(e) }))

    expect(record.decision?.behavior).toBe('allow')
    expect(result.parts.some((p) => p.toolName === 'cinna_permission_request')).toBe(false)
  })

  it('asks what the grant store does not cover, and scopes the ask to the resource', async () => {
    const seen: unknown[] = []
    const record: { decision?: { behavior: string } } = {}
    const runner = new ClaudeAgentTurnRunner(
      makeDeps({
        isGranted: (_dir, _kind, request) => {
          seen.push(request)
          return false
        },
        query: permissionQuery(record)
      })
    )
    const running = runner.runTurn(turn())
    await answerWhenAsked('once')
    const result = await running

    expect(seen[0]).toEqual({ action: 'Bash', resources: ['rm -rf /tmp/x'], savable: [] })
    expect(record.decision?.behavior).toBe('allow')

    const block = result.parts.find((p) => p.toolName === 'cinna_permission_request')
    expect(block?.text).toBe('Permission needed to run a command: rm -rf /tmp/x')
    // The decision is filed beside the ask, paired by the same tool id, or the
    // transcript shows a prompt with no record of what was decided.
    expect(block?.toolId).toMatch(/^per_/)
    const decision = result.parts.find((p) => p.kind === 'tool_result' && p.toolId === block?.toolId)
    expect(decision?.text).toBe('Allowed once.')
  })

  it('mints an id the renderer will treat as dead once the turn ends', async () => {
    // `isEngineRequestId` gates on the `per_` prefix, and that is what stops a
    // persisted block rendering as answerable after its turn is gone.
    const { isEngineRequestId } = await import('../../../shared/localAgentRequests')
    const record: { decision?: { behavior: string; message?: string } } = {}
    const runner = new ClaudeAgentTurnRunner(makeDeps({ query: permissionQuery(record) }))
    const running = runner.runTurn(turn())
    await answerWhenAsked('once')
    const result = await running
    const block = result.parts.find((p) => p.toolName === 'cinna_permission_request')
    expect(isEngineRequestId(block?.toolId)).toBe(true)
  })

  it('says the rule was remembered only when it actually was', async () => {
    const record: { decision?: { behavior: string; message?: string } } = {}
    const runner = new ClaudeAgentTurnRunner(makeDeps({ query: permissionQuery(record) }))
    const running = runner.runTurn(turn())
    await answerWhenAsked('always', true)
    const result = await running
    expect(result.parts.some((p) => p.text === 'Allowed, and remembered for this agent.')).toBe(true)
  })

  it('denies with a message written for the model, since that is what receives it', async () => {
    // Verified: the deny message is handed to the model verbatim as the tool
    // result. So it explains the refusal rather than describing our UI.
    const record: { decision?: { behavior: string; message?: string } } = {}
    const runner = new ClaudeAgentTurnRunner(makeDeps({ query: permissionQuery(record) }))
    const running = runner.runTurn(turn())
    await answerWhenAsked('reject')
    const result = await running

    expect(record.decision?.behavior).toBe('deny')
    expect(record.decision?.message).toMatch(/declined/)
    expect(result.parts.some((p) => p.text === 'Denied.')).toBe(true)
  })

  it('denies when nobody answers, and says so rather than claiming a refusal', async () => {
    // **The path that must never fail open.** `pendingRequests` settles an
    // expired park by *resolving* with `{kind:'rejected'}`, not by rejecting —
    // so this is ordinary control flow, not the catch. Allowing here would let
    // an unattended action be approved by nobody.
    //
    // The wording matters too: an approval log that cannot tell a refusal from
    // an abandonment is worth very little, so the transcript says which it was.
    const record: { decision?: { behavior: string; message?: string } } = {}
    const runner = new ClaudeAgentTurnRunner(makeDeps({ query: permissionQuery(record) }))
    const running = runner.runTurn(turn())

    const { pendingRequests } = await import('./pendingRequests')
    for (let i = 0; i < 400; i++) {
      const [first] = pendingRequests.listForChat('chat-1')
      if (first) {
        pendingRequests.resolve(first.requestId, { kind: 'rejected' })
        break
      }
      await new Promise((r) => setTimeout(r, 5))
    }
    const result = await running

    expect(record.decision?.behavior).toBe('deny')
    expect(record.decision?.message).toMatch(/not answered in time/)
    expect(result.parts.some((p) => p.text === 'No answer — the request expired.')).toBe(true)
    expect(result.parts.some((p) => p.text === 'Denied.')).toBe(false)
  })

  it('treats an unreadable grant store as “ask the user”, not as “allow”', async () => {
    // The safe direction. Failing open here would let a store that cannot be
    // read authorise everything.
    const record: { decision?: { behavior: string } } = {}
    const runner = new ClaudeAgentTurnRunner(
      makeDeps({
        isGranted: () => {
          throw new Error('desktop.json is unreadable')
        },
        query: permissionQuery(record)
      })
    )
    const running = runner.runTurn(turn())
    await answerWhenAsked('once')
    const result = await running
    expect(result.parts.some((p) => p.toolName === 'cinna_permission_request')).toBe(true)
    expect(record.decision?.behavior).toBe('allow')
  })
})
