/**
 * Stop for ACP background tasks: the `_session/async_task/stop` request over a
 * real connection (the fake agent replaying the recorded stops), the answers
 * and non-answers, which session an item is found in, and that what the
 * engines send around a stop opens no follow-up turn.
 */
import { afterEach, describe, expect, it } from 'vitest'
import type { SessionNotification } from '@agentclientprotocol/sdk'
import type { SessionActivityItem } from '../../../../shared/sessionActivity'
import { createSessionActivityHub, type SessionActivityHub } from '../../../services/sessionActivityHub'
import { createSessionActivityRegistry, type SessionActivityRegistry } from './acpActivity'
import { createAcpActivityStopper, stopAcpAsyncTask } from './acpActivityStop'
import { startAcpConnection } from './acpConnection'
import { createFollowUpGate } from './acpFollowUp'
import type { SessionTrafficSink } from './acpSessionObserver'
import { createFakeAcp, waitFor, type FakeAcp, type FakeAcpScript, type FakeAcpStep } from './testSupport/fakeAcp'
import { loadActivityFixture } from './testSupport/subagentFixtures'
import { ACP_PROTOCOL_VERSION, type AcpAsyncTaskStopRequest, type AcpAsyncTaskStopResponse, type AcpConnection, type AcpExit } from './types'

const CHAT = 'chat-1'
const AGENT = 'agent-1'
const SCOPE = { chatId: CHAT, agentId: AGENT }

type StopFixture = ReturnType<typeof loadActivityFixture> & {
  stopRequest: AcpAsyncTaskStopRequest
  stopResult: AcpAsyncTaskStopResponse
}
const load = (engine: 'claude' | 'codex'): StopFixture => loadActivityFixture(engine, 'async_task_stop') as StopFixture

const fakes: FakeAcp[] = []
const connections: AcpConnection[] = []
afterEach(async () => {
  for (const connection of connections.splice(0)) await connection.dispose()
  for (const fake of fakes.splice(0)) fake.cleanup()
})

const step = (n: SessionNotification): FakeAcpStep => ({ kind: 'update', sessionId: n.sessionId, update: n.update as unknown as Record<string, unknown> })

/** A real connection whose session feeds a registry and a hub, as the driver's listener does. */
async function wired(script: FakeAcpScript, sessionId: string): Promise<{
  connection: AcpConnection
  fake: FakeAcp
  hub: SessionActivityHub
  registry: SessionActivityRegistry
}> {
  const fake = createFakeAcp(script)
  fakes.push(fake)
  const connection = await startAcpConnection(fake.spec, { protocolVersion: ACP_PROTOCOL_VERSION, clientCapabilities: {} }, { startTimeoutMs: 5_000 })
  connections.push(connection)
  const hub = createSessionActivityHub()
  const registry = createSessionActivityRegistry(hub)
  const feed = registry.session(connection, sessionId, SCOPE)
  connection.observeSession(sessionId, {
    onUpdate: (n) => feed.observe(n),
    onPermission: async () => ({ outcome: { outcome: 'cancelled' } })
  })
  return { connection, fake, hub, registry }
}

const itemOf = (hub: SessionActivityHub, id: string): SessionActivityItem | undefined =>
  hub.snapshot(CHAT).items.find((item) => item.id === id)

describe.each(['claude', 'codex'] as const)('stopping a recorded %s background task', (engine) => {
  const fixture = load(engine)
  const { sessionId, asyncTaskId } = fixture.stopRequest
  const itemId = `${sessionId}:${asyncTaskId}`
  const before = fixture.notifications.slice(0, fixture.promptReturnedAtIndex)
  const stopIndex = fixture.notifications.findIndex((n, i) =>
    i >= fixture.promptReturnedAtIndex! && (n.update as { sessionUpdate: string }).sessionUpdate === 'async_task_state_update')
  const atStop = fixture.notifications.slice(fixture.promptReturnedAtIndex, stopIndex + 1)
  const afterStop = fixture.notifications.slice(stopIndex + 1)

  it('sends the request the engine expects and answers stopped, the hub already moved', async () => {
    const { fake, hub, registry } = await wired({
      newSession: { sessionId, emit: before.map(step) },
      asyncTaskStop: { emit: atStop.map(step), response: fixture.stopResult, after: afterStop.map(step) }
    }, sessionId)
    const [connection] = connections
    await connection.newSession({ cwd: fake.dir, mcpServers: [] })
    const running = await waitFor(() => itemOf(hub, itemId), 'the running task')
    expect(running).toMatchObject({ state: 'running', canStop: true, kind: 'background' })

    const outcome = await createAcpActivityStopper(registry).stop(CHAT, running)

    expect(outcome).toBe('stopped')
    expect(fake.received('_session/async_task/stop').map((e) => e.params)).toEqual([{ sessionId, asyncTaskId }])
    // The state update came before the answer.
    expect(itemOf(hub, itemId)).toMatchObject({ state: 'stopped', canStop: false })
  })

  it('opens no follow-up turn for what the engine sends around the stop', () => {
    const known = new Set(before.flatMap((n) => {
      const id = (n.update as { toolCallId?: unknown }).toolCallId
      return typeof id === 'string' ? [id] : []
    }))
    let opened = 0
    const activity: string[] = []
    const sink: SessionTrafficSink = {
      update: (n) => void activity.push((n.update as { sessionUpdate: string }).sessionUpdate),
      permission: async () => ({ outcome: { outcome: 'cancelled' } }),
      elicitation: async () => ({ action: 'cancel' })
    }
    const gate = createFollowUpGate({ agentId: AGENT, chatId: CHAT, sessionId, launcherId: engine }, {
      activity: sink, knownToolCalls: known, open: () => { opened++ }
    })
    for (const n of [...atStop, ...afterStop]) gate.sink.update(n)

    expect(opened).toBe(0)
    expect(gate.pending).toBe(false)
    // Claude's "Task stopped by user" chunk has no messageId; Codex's failed exec is a late update.
    const dropped = [...atStop, ...afterStop].filter((n) => ['agent_message_chunk', 'tool_call_update'].includes((n.update as { sessionUpdate: string }).sessionUpdate))
    expect(dropped.length).toBeGreaterThan(0)
  })
})

describe('the stop answer', () => {
  const target = (connection: AcpConnection) => ({ connection, sessionId: 'ses_1', asyncTaskId: 'bg1' })

  it('reads stopped: false (an unknown task) as already ended', async () => {
    const { connection } = await wired({ newSession: { sessionId: 'ses_1' } }, 'ses_1')
    expect(await stopAcpAsyncTask(target(connection))).toBe('already_ended')
  })

  it('is unavailable when the agent does not answer in time', async () => {
    const { connection, fake } = await wired({ asyncTaskStop: { hang: true } }, 'ses_1')
    const started = Date.now()
    expect(await stopAcpAsyncTask(target(connection), 150)).toBe('unavailable')
    expect(Date.now() - started).toBeLessThan(2_000)
    expect(fake.received('_session/async_task/stop')).toHaveLength(1)
  })

  it('is unavailable when the agent refuses the request', async () => {
    const { connection } = await wired({ asyncTaskStop: { error: { code: -32601, message: 'Method not found' } } }, 'ses_1')
    expect(await stopAcpAsyncTask(target(connection))).toBe('unavailable')
  })

  it('is unavailable when the process exits before it answers', async () => {
    const { connection } = await wired({ asyncTaskStop: { emit: [{ kind: 'exit', code: 1 }] } }, 'ses_1')
    expect(await stopAcpAsyncTask(target(connection), 4_000)).toBe('unavailable')
  })

  it('sends nothing to a connection that is already gone', async () => {
    const { connection, fake } = await wired({}, 'ses_1')
    await connection.dispose()
    expect(await stopAcpAsyncTask(target(connection))).toBe('unavailable')
    expect(fake.received('_session/async_task/stop')).toHaveLength(0)
  })

  it('does not ask a connection that says it is dead, whatever it would answer', async () => {
    let asked = 0
    const dead = {
      alive: false,
      exited: new Promise<AcpExit>(() => {}),
      stopAsyncTask: async () => { asked++; return { stopped: true } }
    } as unknown as AcpConnection
    expect(await stopAcpAsyncTask(target(dead))).toBe('unavailable')
    expect(asked).toBe(0)
  })
})

describe('which session a background item is stopped in', () => {
  function stub(name: string): AcpConnection & { stops: AcpAsyncTaskStopRequest[] } {
    const stops: AcpAsyncTaskStopRequest[] = []
    return {
      stops,
      alive: true,
      exited: new Promise<AcpExit>(() => {}),
      aliasSession: () => () => {},
      stopAsyncTask: async (params: AcpAsyncTaskStopRequest) => { stops.push(params); return { stopped: true, by: name } }
    } as unknown as AcpConnection & { stops: AcpAsyncTaskStopRequest[] }
  }
  const spawn = (sessionId: string, asyncTaskId: string): SessionNotification =>
    ({ sessionId, update: { sessionUpdate: 'async_task_spawned', asyncTaskId, name: 'sleep 120', canStop: true } }) as unknown as SessionNotification
  const item = (id: string, over: Partial<SessionActivityItem> = {}): SessionActivityItem => ({
    id, kind: 'background', agentId: AGENT, title: 't', detail: null, state: 'running',
    startedAt: new Date(0), endedAt: null, outputPath: null, canStop: true, ...over
  })

  it('finds a task a previous turn\'s session started, on that session\'s connection', async () => {
    const registry = createSessionActivityRegistry()
    const first = stub('first')
    const second = stub('second')
    registry.session(first, 'ses_old', SCOPE).observe(spawn('ses_old', 'bg1'))
    // The next turn runs in a new session, on a new process.
    registry.session(second, 'ses_new', SCOPE).observe(spawn('ses_new', 'bg2'))

    const stopper = createAcpActivityStopper(registry)
    expect(await stopper.stop(CHAT, item('ses_old:bg1'))).toBe('stopped')
    expect(first.stops).toEqual([{ sessionId: 'ses_old', asyncTaskId: 'bg1' }])
    expect(second.stops).toEqual([])
    expect(await stopper.stop(CHAT, item('ses_new:bg2'))).toBe('stopped')
    expect(second.stops).toEqual([{ sessionId: 'ses_new', asyncTaskId: 'bg2' }])
  })

  it.each([
    ['an id no session announced', CHAT, item('ses_old:nope')],
    ['another chat\'s item', 'chat-2', item('ses_old:bg1')],
    ['another agent\'s item', CHAT, item('ses_old:bg1', { agentId: 'agent-2' })],
    ['a subagent', CHAT, item('ses_old:bg1', { kind: 'subagent' })],
    ['a session id that only shares a prefix', CHAT, item('ses:old:bg1')]
  ])('does not claim %s', async (_label, chatId, candidate) => {
    const registry = createSessionActivityRegistry()
    const connection = stub('c')
    registry.session(connection, 'ses_old', SCOPE).observe(spawn('ses_old', 'bg1'))
    expect(await createAcpActivityStopper(registry).stop(chatId, candidate)).toBeNull()
    expect(connection.stops).toEqual([])
  })

  it('does not claim a task once its chat\'s sessions were forgotten', async () => {
    const registry = createSessionActivityRegistry()
    registry.session(stub('c'), 'ses_old', SCOPE).observe(spawn('ses_old', 'bg1'))
    registry.forgetChat(CHAT)
    expect(await createAcpActivityStopper(registry).stop(CHAT, item('ses_old:bg1'))).toBeNull()
  })
})
