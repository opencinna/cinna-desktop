/**
 * The connection, against a real child process.
 *
 * Everything interesting here is a fact about a process and a pipe — what the
 * child's environment actually is, what happens when it dies mid-turn, whether
 * a notification written behind a response survives the race to the handler —
 * and none of those survive being faked in memory. So every test drives
 * `fakeAcpAgent.mjs` over real stdio, and the assertions are made from two
 * sides: what our handlers saw, and what the agent recorded being told.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { realpathSync } from 'node:fs'
import type {
  CreateElicitationRequest,
  InitializeRequest,
  RequestPermissionRequest,
  SessionNotification
} from '@agentclientprotocol/sdk'
import { startAcpConnection, type AcpConnectionOptions } from './acpConnection'
import { createFakeAcp, settle, waitFor, type FakeAcp, type FakeAcpScript } from './testSupport/fakeAcp'
import { ACP_PROTOCOL_VERSION, type AcpConnection, type AcpSessionHandlers } from './types'

const INIT: InitializeRequest = { protocolVersion: ACP_PROTOCOL_VERSION, clientCapabilities: {} }

const fakes: FakeAcp[] = []
const connections: AcpConnection[] = []

afterEach(async () => {
  for (const connection of connections.splice(0)) await connection.dispose()
  for (const fake of fakes.splice(0)) fake.cleanup()
})

function fakeAgent(script: FakeAcpScript = {}): FakeAcp {
  const fake = createFakeAcp(script)
  fakes.push(fake)
  return fake
}

async function start(fake: FakeAcp, options: AcpConnectionOptions = {}): Promise<AcpConnection> {
  const connection = await startAcpConnection(fake.spec, INIT, { startTimeoutMs: 5_000, ...options })
  connections.push(connection)
  return connection
}

/** Handlers that record everything and answer a permission with `once`. */
function recorder(): AcpSessionHandlers & {
  updates: SessionNotification[]
  permissions: RequestPermissionRequest[]
  elicitations: CreateElicitationRequest[]
  ext: { method: string; params: Record<string, unknown> }[]
} {
  const updates: SessionNotification[] = []
  const permissions: RequestPermissionRequest[] = []
  const elicitations: CreateElicitationRequest[] = []
  const ext: { method: string; params: Record<string, unknown> }[] = []
  return {
    updates,
    permissions,
    elicitations,
    ext,
    onUpdate: (notification) => void updates.push(notification),
    onPermission: async (params) => {
      permissions.push(params)
      return { outcome: { outcome: 'selected', optionId: 'once' } }
    },
    onElicitation: async (params) => {
      elicitations.push(params)
      return { action: 'decline' }
    },
    onExtNotification: (method, params) => void ext.push({ method, params })
  }
}

function textUpdate(sessionId: string, text: string): {
  kind: 'update'
  sessionId: string
  update: Record<string, unknown>
} {
  return {
    kind: 'update',
    sessionId,
    update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } }
  }
}

describe('startAcpConnection', () => {
  it('gives the child exactly the environment and cwd the spec names', async () => {
    const fake = fakeAgent()
    await start(fake)
    const started = await waitFor(() => fake.log().find((e) => e.dir === 'start'), 'the start line')

    // `__CF_USER_TEXT_ENCODING` is macOS's, added by the loader below us; every
    // other key is one we chose. Nothing of this process's environment — no
    // PATH, no HOME, none of the decrypted credentials the main process holds —
    // leaks into an agent that the launcher did not name.
    const passed = Object.keys(started.env ?? {}).filter((key) => !key.startsWith('__CF_'))
    expect(passed.sort()).toEqual(['FAKE_ACP_LOG', 'FAKE_ACP_SCRIPT'])
    expect(started.cwd).toBe(realpathSync(fake.spec.cwd))
  })

  it('exposes the agent’s initialize answer, its pid and its liveness', async () => {
    const connection = await start(fakeAgent())

    expect(connection.initialized.protocolVersion).toBe(1)
    expect(connection.initialized.agentCapabilities?.loadSession).toBe(true)
    expect(connection.pid).toBeGreaterThan(0)
    expect(connection.alive).toBe(true)
  })

  it('rejects with a readable message when the command is not there', async () => {
    const fake = fakeAgent()
    await expect(
      startAcpConnection({ ...fake.spec, command: '/nope/not-an-agent' }, INIT, {
        startTimeoutMs: 5_000
      })
    ).rejects.toThrow(/\/nope\/not-an-agent.*ENOENT/s)
  })

  it('rejects with the stderr tail when the process dies before initialize', async () => {
    const fake = fakeAgent({
      stderr: ['fake-acp: no adapter installed'],
      exitOnStart: { code: 3 }
    })

    await expect(start(fake)).rejects.toThrow(
      /exited \(code 3\) before answering initialize[\s\S]*no adapter installed/
    )
  })

  it('rejects when initialize goes unanswered, and says how long it waited', async () => {
    const fake = fakeAgent({ stderr: ['fake-acp: wedged'], initialize: { hang: true } })

    await expect(start(fake, { startTimeoutMs: 150 })).rejects.toThrow(
      /did not answer initialize within 150 ms[\s\S]*wedged/
    )
  })
})

describe('session routing', () => {
  it('delivers a bound session’s updates in order', async () => {
    const fake = fakeAgent({
      newSession: { sessionId: 'ses_1' },
      prompt: { emit: [textUpdate('ses_1', 'one'), textUpdate('ses_1', ' two')] }
    })
    const connection = await start(fake)
    await connection.newSession({ cwd: fake.dir, mcpServers: [] })
    const handlers = recorder()
    connection.bindSession('ses_1', handlers)

    await connection.prompt({ sessionId: 'ses_1', prompt: [{ type: 'text', text: 'hi' }] })

    expect(handlers.updates.map((u) => u.sessionId)).toEqual(['ses_1', 'ses_1'])
    expect(handlers.updates.map((u) => u.update)).toEqual([
      { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'one' } },
      { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: ' two' } }
    ])
  })

  it('stops delivering once the bind is released', async () => {
    const fake = fakeAgent({
      setMode: { emit: [textUpdate('ses_1', 'after')] }
    })
    const connection = await start(fake)
    const handlers = recorder()
    const unbind = connection.bindSession('ses_1', handlers)
    unbind()

    await connection.setSessionMode({ sessionId: 'ses_1', modeId: 'default' })
    await settle(50)

    expect(handlers.updates).toHaveLength(0)
  })

  it('keeps traffic that arrives before the bind and replays it in order', async () => {
    // The reason this exists: `session/new` answers and its updates follow in
    // the same read, and the SDK dispatches them concurrently — so the turn
    // that binds on the answer is racing its own opening.
    const fake = fakeAgent({
      setMode: {
        emit: [
          textUpdate('ses_late', 'first'),
          textUpdate('ses_late', 'second'),
          textUpdate('ses_late', 'third')
        ]
      }
    })
    const connection = await start(fake, { preBindWindowMs: 5_000 })
    await connection.setSessionMode({ sessionId: 'ses_other', modeId: 'default' })
    await settle()

    const handlers = recorder()
    connection.bindSession('ses_late', handlers)

    expect(
      handlers.updates.map((u) => (u.update as { content: { text: string } }).content.text)
    ).toEqual(['first', 'second', 'third'])
  })

  it('drops what nobody bound before the window closed', async () => {
    const fake = fakeAgent({ setMode: { emit: [textUpdate('ses_late', 'gone')] } })
    const connection = await start(fake, { preBindWindowMs: 60 })
    await connection.setSessionMode({ sessionId: 'ses_other', modeId: 'default' })
    await settle(200)

    const handlers = recorder()
    connection.bindSession('ses_late', handlers)

    expect(handlers.updates).toHaveLength(0)
  })

  it('holds no more than the buffer limit for one unbound session', async () => {
    const fake = fakeAgent({
      setMode: {
        emit: [
          textUpdate('ses_late', 'a'),
          textUpdate('ses_late', 'b'),
          textUpdate('ses_late', 'c'),
          textUpdate('ses_late', 'd')
        ]
      }
    })
    const connection = await start(fake, { preBindWindowMs: 5_000, preBindLimit: 2 })
    await connection.setSessionMode({ sessionId: 'ses_other', modeId: 'default' })
    await settle()

    const handlers = recorder()
    connection.bindSession('ses_late', handlers)

    expect(
      handlers.updates.map((u) => (u.update as { content: { text: string } }).content.text)
    ).toEqual(['a', 'b'])
  })

  it('delivers an update kind this SDK has never heard of, and keeps the turn alive', async () => {
    // The SDK's own routing parses `session/update` against a closed union and
    // drops anything outside it (measured: the connection survives, the update
    // does not). One agent version bump and that would be a missing chunk of a
    // message, so this layer routes by session id and judges nothing else.
    const fake = fakeAgent({
      setMode: {
        emit: [
          {
            kind: 'update',
            sessionId: 'ses_1',
            update: { sessionUpdate: 'something_from_the_future', payload: { note: 'hi' } }
          },
          textUpdate('ses_1', 'after')
        ]
      }
    })
    const connection = await start(fake)
    const handlers = recorder()
    connection.bindSession('ses_1', handlers)

    await connection.setSessionMode({ sessionId: 'ses_1', modeId: 'default' })
    await settle(50)

    expect(handlers.updates.map((u) => u.update)).toEqual([
      { sessionUpdate: 'something_from_the_future', payload: { note: 'hi' } },
      { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'after' } }
    ])
    expect(connection.alive).toBe(true)
  })

  it('routes an extension notification that names a session, and survives one that does not', async () => {
    const fake = fakeAgent({
      setMode: {
        emit: [
          // `_auth/status_update` really does arrive with no session id, twice
          // per start — see spike/acp/claude/recordings/s1-session-new-mcp.ndjson.
          { kind: 'notify', method: '_auth/status_update', params: { authStatus: { kind: 'account' } } },
          { kind: 'notify', method: 'usage_update', params: { sessionId: 'ses_1', cost: 0.02 } }
        ]
      }
    })
    const connection = await start(fake)
    const handlers = recorder()
    connection.bindSession('ses_1', handlers)

    await connection.setSessionMode({ sessionId: 'ses_1', modeId: 'default' })
    await settle(50)

    expect(handlers.ext).toEqual([
      { method: 'usage_update', params: { sessionId: 'ses_1', cost: 0.02 } }
    ])
    expect(connection.alive).toBe(true)
  })
})

describe('requests from the agent', () => {
  it('hands a permission to the session that owns it and returns the answer', async () => {
    const fake = fakeAgent({ setMode: { emit: [{ kind: 'permission', sessionId: 'ses_1' }] } })
    const connection = await start(fake)
    const handlers = recorder()
    connection.bindSession('ses_1', handlers)

    await connection.setSessionMode({ sessionId: 'ses_1', modeId: 'default' })

    expect(handlers.permissions).toHaveLength(1)
    expect(handlers.permissions[0].toolCall.toolCallId).toBe('call_fake')
    expect(fake.answers('session/request_permission')[0].result).toEqual({
      outcome: { outcome: 'selected', optionId: 'once' }
    })
  })

  it('cancels a permission for a session nobody binds', async () => {
    const fake = fakeAgent({ setMode: { emit: [{ kind: 'permission', sessionId: 'ses_ghost' }] } })
    const connection = await start(fake, { preBindWindowMs: 60 })

    await connection.setSessionMode({ sessionId: 'ses_1', modeId: 'default' })
    const answer = await waitFor(
      () => fake.answers('session/request_permission')[0],
      'the cancelled permission'
    )

    expect(answer.result).toEqual({ outcome: { outcome: 'cancelled' } })
  })

  it('still delivers a permission when the bind lands inside the window', async () => {
    const fake = fakeAgent({ setMode: { emit: [{ kind: 'permission', sessionId: 'ses_slow' }] } })
    const connection = await start(fake, { preBindWindowMs: 5_000 })
    void connection.setSessionMode({ sessionId: 'ses_1', modeId: 'default' })
    await settle()

    const handlers = recorder()
    connection.bindSession('ses_slow', handlers)
    const answer = await waitFor(
      () => fake.answers('session/request_permission')[0],
      'the answered permission'
    )

    expect(handlers.permissions).toHaveLength(1)
    expect(answer.result).toEqual({ outcome: { outcome: 'selected', optionId: 'once' } })
  })

  it('hands an elicitation to the session, and cancels one nobody bound', async () => {
    const fake = fakeAgent({
      setMode: {
        emit: [
          { kind: 'elicitation', sessionId: 'ses_1' },
          { kind: 'elicitation', sessionId: 'ses_ghost' }
        ]
      }
    })
    const connection = await start(fake, { preBindWindowMs: 60 })
    const handlers = recorder()
    connection.bindSession('ses_1', handlers)

    await connection.setSessionMode({ sessionId: 'ses_1', modeId: 'default' })

    expect(handlers.elicitations).toHaveLength(1)
    expect(fake.answers('elicitation/create').map((e) => e.result)).toEqual([
      { action: 'decline' },
      { action: 'cancel' }
    ])
  })

  it('answers fs/* and terminal/* with method not found', async () => {
    // OpenCode 1.18.27 calls `fs/write_text_file` even though we declare no fs
    // capability; on the -32601 it writes the file itself and the turn goes on
    // (spike/acp/opencode/recordings/q2-permission.ndjson, lines 276-278).
    const fake = fakeAgent({
      setMode: {
        emit: [
          { kind: 'request', method: 'fs/write_text_file', params: { sessionId: 'ses_1', path: '/tmp/x', content: 'x' } },
          { kind: 'request', method: 'fs/read_text_file', params: { sessionId: 'ses_1', path: '/tmp/x' } },
          { kind: 'request', method: 'terminal/create', params: { sessionId: 'ses_1', command: 'ls' } },
          { kind: 'request', method: '_vendor/unknown', params: { sessionId: 'ses_1' } }
        ]
      }
    })
    const connection = await start(fake)
    connection.bindSession('ses_1', recorder())

    await connection.setSessionMode({ sessionId: 'ses_1', modeId: 'default' })

    const codes = fake
      .log()
      .filter((e) => e.dir === 'answer')
      .map((e) => e.error?.code)
    expect(codes).toEqual([-32601, -32601, -32601, -32601])
    expect(connection.alive).toBe(true)
  })
})

describe('the process itself', () => {
  it('cancels a turn with session/cancel and lets the prompt answer', async () => {
    const fake = fakeAgent({
      newSession: { sessionId: 'ses_1' },
      prompt: { emit: [{ kind: 'awaitCancel', sessionId: 'ses_1' }], response: { stopReason: 'cancelled' } }
    })
    const connection = await start(fake)
    connection.bindSession('ses_1', recorder())

    const turn = connection.prompt({ sessionId: 'ses_1', prompt: [{ type: 'text', text: 'go' }] })
    await connection.cancel('ses_1')

    expect((await turn).stopReason).toBe('cancelled')
    expect(fake.received('session/cancel')).toHaveLength(1)
  })

  it('surfaces an agent’s RPC error as a rejection, with its code and message', async () => {
    // What a real one looks like: OpenCode fails `session/prompt` with -32603
    // when the session's model is gone, after streaming part of the turn.
    const fake = fakeAgent({
      newSession: { sessionId: 'ses_1' },
      prompt: {
        emit: [textUpdate('ses_1', 'thinking')],
        error: { code: -32603, message: "Internal error: model 'x' not found" }
      }
    })
    const connection = await start(fake)
    const handlers = recorder()
    connection.bindSession('ses_1', handlers)

    await expect(
      connection.prompt({ sessionId: 'ses_1', prompt: [{ type: 'text', text: 'go' }] })
    ).rejects.toMatchObject({ code: -32603, message: /model 'x' not found/ })
    expect(handlers.updates).toHaveLength(1)
    expect(connection.alive).toBe(true)
  })

  it('keeps a bounded stderr tail', async () => {
    const fake = fakeAgent({
      stderr: Array.from({ length: 60 }, (_, i) => `line ${i}`)
    })
    const connection = await start(fake)
    await waitFor(() => connection.stderrTail().includes('line 59') || null, 'the stderr tail')

    const lines = connection.stderrTail().split('\n')
    expect(lines).toHaveLength(40)
    expect(lines[0]).toBe('line 20')
    expect(lines.at(-1)).toBe('line 59')
  })

  it('settles `exited` once, with the code, when the agent dies on its own', async () => {
    const fake = fakeAgent({
      newSession: { sessionId: 'ses_1' },
      prompt: { emit: [{ kind: 'exit', code: 7 }] }
    })
    const connection = await start(fake)
    void connection
      .prompt({ sessionId: 'ses_1', prompt: [{ type: 'text', text: 'go' }] })
      .catch(() => undefined)

    const exit = await connection.exited
    expect(exit.code).toBe(7)
    expect(connection.alive).toBe(false)
  })

  it('disposes idempotently, and the process is gone afterwards', async () => {
    const connection = await start(fakeAgent())
    const pid = connection.pid as number

    await Promise.all([connection.dispose(), connection.dispose()])
    await connection.dispose()

    expect(connection.alive).toBe(false)
    expect(() => process.kill(pid, 0)).toThrow()
  })

  it('escalates to SIGKILL when the agent ignores SIGTERM', async () => {
    const fake = fakeAgent({ ignoreSigterm: true, exitOnClose: 0 })
    const connection = await start(fake, { killGraceMs: 100 })
    const pid = connection.pid as number

    await connection.dispose()

    expect((await connection.exited).signal).toBe('SIGKILL')
    expect(() => process.kill(pid, 0)).toThrow()
  })
})
