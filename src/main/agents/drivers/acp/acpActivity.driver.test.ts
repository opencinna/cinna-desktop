/**
 * Session activity through the ACP driver, against the scripted fake agent
 * over real stdio: a Claude subagent turn saves the transcript it saved before
 * native subagent sessions, a background task that ends after the prompt
 * returned ends in the hub, and the reaper waits for it.
 */
import { afterEach, describe, expect, it } from 'vitest'
import type { SessionNotification } from '@agentclientprotocol/sdk'
import type { AgentRow } from '../../../db/agents'
import type { FollowUpRequest } from '../driver'
import { goldenRow } from '../__golden__/driverWorld'
import { pendingRequests } from '../pendingRequests'
import { createSessionActivityHub, type SessionActivityHub } from '../../../services/sessionActivityHub'
import { createAcpDriver, type AcpDriverDeps } from './acpDriver'
import { activityReapDeps, wirePoolToActivity } from './acpPool'
import { createAcpProcessPool } from './acpProcessPool'
import { startAcpConnection } from './acpConnection'
import type { AcpLauncher } from './acpLaunchers'
import { createFakeAcp, settle, waitFor, type FakeAcp, type FakeAcpHandlerScript, type FakeAcpScript, type FakeAcpStep } from './testSupport/fakeAcp'
import { sdkParams } from './testSupport/sdkMessageFixtures'
import { SDK_MESSAGE_METHOD } from './acpSdkTelemetry'
import type { SDKBackgroundTasksChangedMessage } from '@anthropic-ai/claude-agent-sdk'
import { beforeCapability, loadActivityFixture, loadOpencodeFixture, type ActivityFixture, type OpencodeFrame } from './testSupport/subagentFixtures'
import { ACP_PROTOCOL_VERSION, type AcpProcessPool } from './types'
import { codexNickname } from './codexNicknames'
import { clearLogEntries, getLogEntries } from '../../../logger/logger'

const AGENT_ID = 'folder:activity'
const CHAT_ID = 'chat-activity'
const RUN_SCOPE = { profileUserId: 'profile-1', settingsUserId: 'settings-1' }

const ROW: AgentRow = goldenRow({
  id: AGENT_ID, name: 'Activity', driver: 'acp', source: 'folder',
  driverConfig: { launcher: 'claude' }, localPath: '/tmp/agents/activity'
})

const cleanups: (() => void)[] = []
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup()
})

interface World {
  hub: SessionActivityHub
  pool: AcpProcessPool
  fake: FakeAcp
  followUps: FollowUpRequest[]
  run(overrides?: { registerSteer?: (steer: ((text: string) => Promise<string>) | null) => void }): ReturnType<ReturnType<typeof createAcpDriver>['run']>
}

function world(options: {
  sessionId: string
  emit: FakeAcpStep[]
  after?: FakeAcpStep[]
  reapMs?: number
  followUps?: boolean
  /** Merged over the prompt's `end_turn` answer. */
  response?: Record<string, unknown>
  /** One script per successive prompt (the last repeats); replaces `emit`, `after` and `response`. */
  prompts?: FakeAcpHandlerScript[]
  launcher?: 'claude' | 'codex' | 'opencode'
  /** What `session/load` streams before it answers. */
  loadSession?: FakeAcpHandlerScript
  /** The connection's pre-bind window, short for a test that waits it out. */
  preBindWindowMs?: number
  /** The turn's abort signal (the user's Stop). */
  signal?: AbortSignal
  /** More of the fake's script (`initialize`, `steer`). */
  script?: Pick<FakeAcpScript, 'initialize' | 'steer'>
  /** The launcher ends a follow-up on a costed `usage_update` (default) rather than on quiet. */
  costedEnd?: boolean
  /** A follow-up's quiet spell, for a launcher that ends on one. */
  followUpQuietMs?: number
}): World {
  const hub = createSessionActivityHub()
  const launcherId = options.launcher ?? 'claude'
  const fake = createFakeAcp({
    newSession: { sessionId: options.sessionId },
    prompt: options.prompts ? { sequence: options.prompts } : {
      emit: options.emit,
      ...(options.after ? { after: options.after } : {}),
      ...(options.response ? { response: options.response } : {})
    },
    ...(options.loadSession ? { loadSession: options.loadSession } : {}),
    ...options.script
  })
  const pool = createAcpProcessPool({
    start: options.preBindWindowMs
      ? (spec, init, connectionOptions) => startAcpConnection(spec, init, { ...connectionOptions, preBindWindowMs: options.preBindWindowMs })
      : startAcpConnection,
    ...(options.reapMs ? { idleReapMs: options.reapMs } : {}),
    ...activityReapDeps(hub)
  })
  const unwire = wirePoolToActivity(pool, hub)
  const launcher: AcpLauncher = {
    id: launcherId,
    endsTurnsWithCostedUsage: options.costedEnd ?? true,
    plan: async () => ({
      spec: fake.spec,
      init: { protocolVersion: ACP_PROTOCOL_VERSION, clientCapabilities: { elicitation: { form: {} } } },
      session: { mcpServers: [] },
      setup: {}
    })
  }
  const sessions = new Map<string, string>()
  const followUps: FollowUpRequest[] = []
  const deps: AcpDriverDeps = {
    pool,
    launcher: (id) => (id === launcherId ? launcher : undefined),
    readRuntime: () => ({
      type: 'folder',
      folder: {
        name: 'Activity', slug: 'activity', description: '', path: '/tmp/agents/activity', kind: 'kit',
        runtimeMode: 'isolated', enabled: true, readiness: 'ok', readinessReason: null, runtime: { engine: launcherId }
      },
      validate() {},
      readSession: (chatId) => sessions.get(chatId) ?? null,
      saveSession: (chatId, sessionId) => { sessions.set(chatId, sessionId) },
      isGranted: () => false,
      rememberGrant: () => false
    }),
    registerRequest: (input) => pendingRequests.register(input),
    resolveRequest: (requestId, resolution) => pendingRequests.resolve(requestId, resolution) !== null,
    withLock: (_agentId, _owner, fn) => fn(),
    cancelGraceMs: 300,
    activity: hub,
    ...(options.followUpQuietMs ? { followUpQuietMs: options.followUpQuietMs } : {}),
    ...(options.followUps ? { openFollowUp: (request: FollowUpRequest) => void followUps.push(request) } : {})
  }
  const driver = createAcpDriver(deps)
  cleanups.push(() => {
    unwire()
    void pool.shutdown()
    fake.cleanup()
  })
  return {
    hub, pool, fake, followUps,
    run: (overrides = {}) => driver.run('__default__', launcherId === 'claude' ? ROW : { ...ROW, driverConfig: { launcher: launcherId } }, {
      chatId: CHAT_ID,
      wireContent: 'go',
      signal: options.signal ?? new AbortController().signal,
      onEvent: () => {},
      runScope: RUN_SCOPE,
      ...(overrides.registerSteer ? { registerSteer: overrides.registerSteer } : {})
    })
  }
}

const steps = (notifications: SessionNotification[]): FakeAcpStep[] =>
  notifications.map((n) => ({ kind: 'update', sessionId: n.sessionId, update: n.update as unknown as Record<string, unknown> }))

/** Split at the prompt's answer, as recorded. */
function asRecorded(fixture: ActivityFixture): { emit: FakeAcpStep[]; after: FakeAcpStep[] } {
  const cut = fixture.promptReturnedAtIndex ?? fixture.notifications.length
  return { emit: steps(fixture.notifications.slice(0, cut)), after: steps(fixture.notifications.slice(cut)) }
}

/** A saved part, as far as these tests read it. */
interface SavedPart { kind: string; text?: string; toolName?: string; toolId?: string }

async function transcriptOf(sessionId: string, emit: FakeAcpStep[]): Promise<{ parts: SavedPart[]; hub: SessionActivityHub }> {
  const w = world({ sessionId, emit })
  const result = await w.run()
  expect(result.error).toBeUndefined()
  return { parts: result.parts as unknown as SavedPart[], hub: w.hub }
}

const withoutResultOf = (callId: string) => (parts: SavedPart[]): SavedPart[] =>
  parts.filter((part) => !(part.kind === 'tool_result' && part.toolId === callId))

describe('a Claude subagent turn under native subagent sessions', () => {
  it('synchronous: saves the transcript the pre-capability stream saved, child calls included', async () => {
    const fixture = loadActivityFixture('claude', 'subagent_sync')
    const parent = fixture.notifications[0].sessionId
    const report = 'The exact output of the command is:\n\n```\nsub-sync-ok\n```'
    const cut = fixture.promptReturnedAtIndex!

    const ours = await transcriptOf(parent, steps(fixture.notifications.slice(0, cut)))
    const before = await transcriptOf(parent, steps(beforeCapability({ notifications: fixture.notifications.slice(0, cut) }, parent, report)))

    expect(ours.parts).toEqual(before.parts)
    const tools = ours.parts.filter((part) => part.kind === 'tool')
    expect(tools.map((part) => part.toolName)).toEqual(['Agent', 'Bash'])
    expect(ours.parts.some((part) => part.text === report)).toBe(true)
    expect(ours.hub.snapshot(CHAT_ID).items.map((item) => [item.kind, item.title, item.state]))
      .toEqual([['subagent', 'Run echo command and report output', 'completed']])
  })

  it('background: the same, apart from the launch notice the wire does not carry', async () => {
    const fixture = loadActivityFixture('claude', 'subagent_background')
    const parent = fixture.notifications[0].sessionId
    const call = 'toolu_01KpzsEJcDiD2HbfUzc62uVd'
    const cut = fixture.promptReturnedAtIndex!

    const ours = await transcriptOf(parent, steps(fixture.notifications.slice(0, cut)))
    const before = await transcriptOf(parent, steps(beforeCapability({ notifications: fixture.notifications.slice(0, cut) }, parent, 'Async agent launched successfully.')))

    const strip = withoutResultOf(call)
    expect(strip(ours.parts)).toEqual(strip(before.parts))
    expect(strip(ours.parts)).toEqual(ours.parts)
    const tools = ours.parts.filter((part) => part.kind === 'tool')
    expect(tools.map((part) => part.toolName)).toEqual(['Agent', 'Bash'])
    expect(ours.parts.some((part) => (part.text ?? '').includes('sub-ok'))).toBe(true)
    expect(ours.hub.snapshot(CHAT_ID).items.map((item) => [item.kind, item.state])).toEqual([['subagent', 'completed']])
  })
})

describe('a background task that outlives its turn', () => {
  it('ends completed in the hub from traffic after the prompt returned, and opens no follow-up', async () => {
    const fixture = loadActivityFixture('claude', 'async_task_background_shell')
    const { emit, after } = asRecorded(fixture)
    const w = world({ sessionId: fixture.notifications[0].sessionId, emit, after, followUps: true })

    const result = await w.run()
    expect(result.error).toBeUndefined()
    await waitFor(() => w.hub.snapshot(CHAT_ID).items[0]?.state === 'completed', 'the task to complete')
    expect(w.hub.snapshot(CHAT_ID).items).toMatchObject([{
      kind: 'background', title: 'Background sleep and echo command', state: 'completed',
      outputPath: expect.stringContaining('b4kbpenhz.output')
    }])
    expect(w.followUps).toEqual([])
  })

  it('keeps the process from the idle reaper while it runs, then lets it go', async () => {
    const fixture = loadActivityFixture('claude', 'async_task_background_shell')
    const { emit, after } = asRecorded(fixture)
    const w = world({
      sessionId: fixture.notifications[0].sessionId,
      emit,
      after: [{ kind: 'delay', ms: 600 }, ...after],
      reapMs: 100
    })

    await w.run()
    await settle(350)
    // Three reap intervals past the turn: still up, the task still running.
    expect(w.pool.status(AGENT_ID).state).toBe('running')
    expect(w.hub.hasRunning({ agentId: AGENT_ID })).toBe(true)

    await waitFor(() => w.pool.status(AGENT_ID).state === 'stopped', 'the reap after the task ended')
    // Ended by its own message, not written off by the reap.
    expect(w.hub.snapshot(CHAT_ID).items[0].state).toBe('completed')
  })

  it('without the capability’s end, the reap writes a running task off as lost', async () => {
    const fixture = loadActivityFixture('claude', 'async_task_background_shell')
    const cut = fixture.promptReturnedAtIndex!
    const w = world({ sessionId: fixture.notifications[0].sessionId, emit: steps(fixture.notifications.slice(0, cut)), reapMs: 50 })
    await w.run()
    expect(w.hub.hasRunning({ agentId: AGENT_ID })).toBe(true)
    w.pool.retire(AGENT_ID)
    await waitFor(() => w.hub.snapshot(CHAT_ID).items[0]?.state === 'lost', 'the task to be lost')
  })
})

describe('the Claude turn-end safety net', () => {
  const SESSION = 'ses-net'
  const spawn = (child: string): FakeAcpStep =>
    ({ kind: 'update', sessionId: SESSION, update: { sessionUpdate: 'subagent_spawned', subagentSessionId: child, name: 'worker', task: 'work' } })
  const task: FakeAcpStep = {
    kind: 'update', sessionId: SESSION,
    update: { sessionUpdate: 'async_task_spawned', asyncTaskId: 'bash-1', name: 'sleep 60', canStop: true }
  }
  const states = (hub: SessionActivityHub): [string, string, string][] =>
    hub.snapshot(CHAT_ID).items.map((item) => [item.id, item.kind, item.state])

  it('ends a subagent still running at end_turn as lost', async () => {
    const w = world({ sessionId: SESSION, emit: [spawn('c1'), spawn('c2'), { kind: 'update', sessionId: SESSION, update: { sessionUpdate: 'subagent_state_update', subagentSessionId: 'c2', state: 'completed' } }] })
    const result = await w.run()
    expect(result.error).toBeUndefined()
    expect(Object.fromEntries(states(w.hub).map(([id, , state]) => [id, state]))).toEqual({
      [`${SESSION}:c1`]: 'lost', [`${SESSION}:c2`]: 'completed'
    })
  })

  it('ends a nested child spawned in this turn and left running as lost', async () => {
    const nested: FakeAcpStep = { kind: 'update', sessionId: 'c1', update: { sessionUpdate: 'subagent_spawned', subagentSessionId: 'g1', name: 'grandchild', task: 'dig' } }
    const w = world({ sessionId: SESSION, emit: [spawn('c1'), nested, { kind: 'update', sessionId: SESSION, update: { sessionUpdate: 'subagent_state_update', subagentSessionId: 'c1', state: 'completed' } }] })
    expect((await w.run()).error).toBeUndefined()
    expect(Object.fromEntries(states(w.hub).map(([id, , state]) => [id, state]))).toEqual({
      [`${SESSION}:c1`]: 'completed', [`${SESSION}:g1`]: 'lost'
    })
  })

  it('leaves a subagent an earlier turn spawned running when a later turn answers end_turn', async () => {
    const w = world({
      sessionId: SESSION, emit: [],
      prompts: [{ emit: [spawn('old')], response: { stopReason: 'cancelled' } }, { emit: [spawn('new')] }]
    })
    await w.run()
    expect(states(w.hub)).toEqual([[`${SESSION}:old`, 'subagent', 'running']])
    expect((await w.run()).error).toBeUndefined()
    expect(Object.fromEntries(states(w.hub).map(([id, , state]) => [id, state]))).toEqual({
      [`${SESSION}:old`]: 'running', [`${SESSION}:new`]: 'lost'
    })
  })

  it('leaves a subagent reported between turns running when the next turn answers end_turn', async () => {
    const w = world({ sessionId: SESSION, emit: [], prompts: [{ after: [spawn('between')] }, {}] })
    expect((await w.run()).error).toBeUndefined()
    await waitFor(() => w.hub.snapshot(CHAT_ID).items.length === 1, 'the subagent reported between turns')
    expect((await w.run()).error).toBeUndefined()
    expect(states(w.hub)).toEqual([[`${SESSION}:between`, 'subagent', 'running']])
  })

  const opener: FakeAcpStep = {
    kind: 'update', sessionId: SESSION, update: { sessionUpdate: 'agent_message_chunk', messageId: 'm-follow', content: { type: 'text', text: 'on my own' } }
  }

  it('leaves a subagent held between turns for a follow-up running when the next turn replays it and answers end_turn', async () => {
    const w = world({ sessionId: SESSION, emit: [], prompts: [{ after: [opener, spawn('held')] }, {}], followUps: true })
    expect((await w.run()).error).toBeUndefined()
    await waitFor(() => w.followUps.length === 1, 'the follow-up the agent opens')
    // The spawn is held behind the opener for the turn that takes the session, which replays it.
    await settle(100)
    expect((await w.run()).error).toBeUndefined()
    expect(states(w.hub)).toEqual([[`${SESSION}:held`, 'subagent', 'running']])
  })

  /** Claude's raw `background_tasks_changed`: the session's whole live background set. */
  const background = (...taskIds: string[]): FakeAcpStep => ({
    kind: 'notify',
    method: SDK_MESSAGE_METHOD,
    params: sdkParams({
      type: 'system',
      subtype: 'background_tasks_changed',
      tasks: taskIds.map((task_id) => ({ task_id, task_type: 'local_agent', subagent_type: 'general-purpose', description: 'work' })),
      uuid: '00000000-0000-4000-8000-000000000001',
      session_id: SESSION
    } satisfies SDKBackgroundTasksChangedMessage, SESSION)
  })

  it('leaves a subagent the turn spawned running at end_turn while the CLI still lists it as a live background task', async () => {
    const w = world({ sessionId: SESSION, emit: [spawn('bg1'), spawn('c2'), background('bg1')] })
    expect((await w.run()).error).toBeUndefined()
    expect(Object.fromEntries(states(w.hub).map(([id, , state]) => [id, state]))).toEqual({
      [`${SESSION}:bg1`]: 'running', [`${SESSION}:c2`]: 'lost'
    })
  })

  it('ends it as lost when a later background_tasks_changed of the turn no longer lists it', async () => {
    const w = world({ sessionId: SESSION, emit: [spawn('bg1'), background('bg1'), background()] })
    expect((await w.run()).error).toBeUndefined()
    expect(states(w.hub)).toEqual([[`${SESSION}:bg1`, 'subagent', 'lost']])
  })

  it('leaves a resumed run running while its task id is listed live', async () => {
    const w = world({ sessionId: SESSION, emit: [spawn('bg1:generation:2'), background('bg1')] })
    expect((await w.run()).error).toBeUndefined()
    expect(states(w.hub)).toEqual([[`${SESSION}:bg1:generation:2`, 'subagent', 'running']])
  })

  it('leaves a background task running at end_turn alone', async () => {
    const w = world({ sessionId: SESSION, emit: [task] })
    await w.run()
    expect(states(w.hub)).toEqual([[`${SESSION}:bash-1`, 'background', 'running']])
  })

  it('leaves a subagent running when the prompt ended cancelled', async () => {
    const w = world({ sessionId: SESSION, emit: [spawn('c1')], response: { stopReason: 'cancelled' } })
    await w.run()
    expect(states(w.hub)).toEqual([[`${SESSION}:c1`, 'subagent', 'running']])
  })

  it('leaves a subagent running on another engine', async () => {
    const w = world({ sessionId: SESSION, emit: [spawn('c1')], launcher: 'codex' })
    expect((await w.run()).error).toBeUndefined()
    expect(states(w.hub)).toEqual([[`${SESSION}:c1`, 'subagent', 'running']])
  })
})

/* ---------------------------------------- nested subagents (recorded live) */

/** A saved part with the lane it was filed under. */
interface LanePart extends SavedPart { parentToolId?: string }

/** The Agent calls of a transcript as `call → the Agent call its part sits under` (undefined at the root), in order. */
function agentLanes(parts: LanePart[]): [string, string | undefined][] {
  return parts.filter((part) => part.kind === 'tool' && part.toolName === 'Agent').map((part) => [part.toolId!, part.parentToolId])
}

const droppedTraffic = (): string[] =>
  getLogEntries().filter((entry) => entry.message.includes('dropped traffic for a session nobody bound')).map((entry) => JSON.stringify(entry.data))

/** The calls of the recorded three-level fan-out. */
const ORCH = 'toolu_01K7ETPweabzp1P4giQYufoQ'
const WORKER_ONE = 'toolu_01Az3ts4STRT1HeVA8w9Wfi1'
const WORKER_TWO = 'toolu_013m91ztirvNrtLumSVTpxeH'
const LEAF_OF_ONE = 'toolu_014usqjb5eNGeg8tUjiiW54E'
const LEAF_OF_TWO = 'toolu_01XDdWzMvWzULab5HzFPkcGX'

describe('nested Claude subagents', () => {
  it('files each level’s Agent call under its spawner’s, the spawner first, when the announcement names the call', async () => {
    clearLogEntries()
    const fixture = loadActivityFixture('claude', 'subagent_nested_fanout')
    const { emit, after } = asRecorded(fixture)
    const w = world({ sessionId: fixture.notifications[0].sessionId, emit, after })
    const result = await w.run()
    expect(result.error).toBeUndefined()
    const parts = result.parts as unknown as LanePart[]

    expect(agentLanes(parts)).toEqual([
      [ORCH, undefined],
      [WORKER_TWO, ORCH],
      [LEAF_OF_TWO, WORKER_TWO],
      [WORKER_ONE, ORCH],
      [LEAF_OF_ONE, WORKER_ONE]
    ])
    // Each leaf's Bash is in the leaf's lane.
    expect(parts.filter((part) => part.toolName === 'Bash').map((part) => part.parentToolId)).toEqual([LEAF_OF_TWO, LEAF_OF_ONE])
    await waitFor(() => w.hub.snapshot(CHAT_ID).items.length === 5, 'the five subagents')
    expect(w.hub.snapshot(CHAT_ID).items.map((item) => item.state)).toEqual(Array(5).fill('completed'))
    expect(droppedTraffic()).toEqual([])
  })

  it('without the call in the announcement (an unpatched adapter), keeps every level at the root as before', async () => {
    const fixture = loadActivityFixture('claude', 'subagent_nested_fanout')
    const bare = {
      ...fixture,
      notifications: fixture.notifications.map((n) => {
        const update = n.update as unknown as Record<string, unknown>
        if (update.sessionUpdate !== 'subagent_spawned') return n
        const { _meta: _dropped, ...rest } = update
        return { ...n, update: rest } as unknown as SessionNotification
      })
    }
    const { emit, after } = asRecorded(bare)
    const result = await world({ sessionId: fixture.notifications[0].sessionId, emit, after }).run()
    expect(agentLanes(result.parts as unknown as LanePart[])).toEqual([
      [LEAF_OF_TWO, undefined],
      [LEAF_OF_ONE, undefined],
      [WORKER_ONE, undefined],
      [WORKER_TWO, undefined],
      [ORCH, undefined]
    ])
  })

  it('on a Stop: the silent spawner gets its own lane, not a placeholder, and the tool left running inside closes failed', async () => {
    clearLogEntries()
    const fixture = loadActivityFixture('claude', 'subagent_nested_cancel')
    const orch = 'toolu_017K6xg8qG5Fi111RFGXamJc'
    const worker = 'toolu_01KPmNohM64K8BfdH5oxoyKg'
    const bash = 'toolu_018Jys3WZYn7RwsVEB5fJ17p'
    const { emit, after } = asRecorded(fixture)
    const w = world({ sessionId: fixture.notifications[0].sessionId, emit, after, response: { stopReason: 'cancelled' } })
    const result = await w.run()
    const parts = result.parts as unknown as LanePart[]

    expect(agentLanes(parts)).toEqual([[orch, undefined], [worker, orch]])
    expect(parts.find((part) => part.kind === 'tool' && part.toolId === bash)?.parentToolId).toBe(worker)
    expect(parts.filter((part) => part.kind === 'tool_result').map((part) => [part.toolId, part.text])).toEqual([
      [bash, 'Subagent stopped.'],
      [worker, 'Subagent stopped.'],
      [orch, 'Subagent stopped.']
    ])
    expect(w.hub.snapshot(CHAT_ID).items.map((item) => item.state)).toEqual(['stopped', 'stopped'])
    expect(droppedTraffic()).toEqual([])
  })

  it('a later turn’s session/load: the replayed subagent sessions are dropped quietly, nothing filed twice, no new items', async () => {
    const fixture = loadActivityFixture('claude', 'subagent_nested_fanout')
    const load = loadActivityFixture('claude', 'subagent_nested_load_replay') as ActivityFixture & { replay: SessionNotification[] }
    const { emit, after } = asRecorded(fixture)
    const w = world({
      sessionId: fixture.notifications[0].sessionId,
      emit: [],
      prompts: [{ emit, after }, { emit: steps(load.notifications) }],
      loadSession: { emit: steps(load.replay) },
      preBindWindowMs: 50
    })
    expect((await w.run()).error).toBeUndefined()
    await waitFor(() => w.hub.snapshot(CHAT_ID).items.length === 5, 'the five subagents')
    const before = w.hub.snapshot(CHAT_ID).items.map((item) => [item.id, item.state])
    clearLogEntries()

    const second = await w.run()
    expect(second.error).toBeUndefined()
    expect(w.fake.received('session/load')).toHaveLength(1)
    // The second turn's own reply, and none of the replay.
    expect((second.parts as unknown as LanePart[]).map((part) => [part.kind, part.text])).toEqual([['text', 'ok']])
    // Past the pre-bind window: nothing was left waiting for a bind.
    await settle(150)
    expect(droppedTraffic()).toEqual([])
    expect(w.hub.snapshot(CHAT_ID).items.map((item) => [item.id, item.state])).toEqual(before)
  })
})

/* ------------------------------- Codex collaboration calls (recorded live) */

describe('a Codex subagent turn (V1 collaboration calls)', () => {
  const CHILD = '01a15429-b7f3-7f80-b352-ef963ba9f782'
  const CANCELLED = '01a15433-7509-7f03-bcde-608ffc9fa85e'
  /** Each item's id, title, state and detail: a Codex item is named from its thread id (`codexNickname`). */
  const items = (hub: SessionActivityHub): [string, string, string, string | null][] =>
    hub.snapshot(CHAT_ID).items.map((item) => [item.id.slice(item.id.indexOf(':') + 1), item.title, item.state, item.detail])

  it('one item per spawn, ended with its report, and the report as the wait call’s output', async () => {
    const fixture = loadActivityFixture('codex', 'subagent_collab')
    const w = world({ sessionId: fixture.notifications[0].sessionId, emit: steps(fixture.notifications), launcher: 'codex' })
    const result = await w.run()
    expect(result.error).toBeUndefined()
    expect(items(w.hub)).toEqual([[CHILD, codexNickname(CHILD), 'completed', 'ORCH FINAL']])
    const parts = result.parts as unknown as SavedPart[]
    const wait = parts.find((part) => part.kind === 'tool' && part.toolName === 'wait')!
    expect(parts.find((part) => part.kind === 'tool_result' && part.toolId === wait.toolId)?.text).toBe('ORCH FINAL')
  })

  it('a resumed agent is a second item under the same name, ended by the second turn’s wait', async () => {
    const fixture = loadActivityFixture('codex', 'subagent_collab_resume') as ActivityFixture & { nextTurn: SessionNotification[] }
    const w = world({
      sessionId: fixture.notifications[0].sessionId, emit: [], launcher: 'codex',
      prompts: [{ emit: steps(fixture.notifications) }, { emit: steps(fixture.nextTurn) }]
    })
    const resumed = '01a15433-72d6-7d31-a125-23dfa346e088'
    expect((await w.run()).error).toBeUndefined()
    expect(items(w.hub).map(([id, title]) => [id, title])).toEqual([[resumed, codexNickname(resumed)]])
    expect((await w.run()).error).toBeUndefined()
    expect(items(w.hub)).toEqual([[`${resumed}#2`, codexNickname(resumed), 'completed', 'ORCH FINAL']])
  })

  it('on a Stop: the child the wire never ends again is ended stopped', async () => {
    const fixture = loadActivityFixture('codex', 'subagent_collab_cancel')
    const stop = new AbortController()
    const w = world({
      sessionId: fixture.notifications[0].sessionId, launcher: 'codex', signal: stop.signal,
      emit: [...steps(fixture.notifications), { kind: 'awaitCancel' }], response: { stopReason: 'cancelled' }
    })
    const running = w.run()
    await waitFor(() => w.hub.snapshot(CHAT_ID).items.length === 1, 'the spawned child')
    stop.abort()
    await running
    expect(w.fake.received('session/cancel')).toHaveLength(1)
    expect(items(w.hub)).toEqual([[CANCELLED, codexNickname(CANCELLED), 'stopped', 'MODE=LONG']])
  })

  it('a turn Codex starts on its own for a late mid-turn message is cancelled, and its children end stopped', async () => {
    // The patched adapter interrupts every child on that cancel and none
    // reports again. Mutation: drop the driver's `stopCodexSubagents` in the
    // unowned-turn branch and the child stays running.
    const fixture = loadActivityFixture('codex', 'subagent_collab_cancel')
    const spawned = fixture.notifications.filter((n) => (n.update as { title?: string }).title !== 'wait')
    const offered: ((text: string) => Promise<string>)[] = []
    const w = world({
      sessionId: fixture.notifications[0].sessionId, launcher: 'codex',
      script: {
        initialize: { response: { _meta: { steering: { supported: true } } } },
        steer: { delayMs: 600, response: { outcome: 'startedNewTurn' } }
      },
      emit: [
        ...steps(spawned),
        { kind: 'update', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Working.' } } },
        { kind: 'delay', ms: 150 }
      ]
    })
    const running = w.run({ registerSteer: (steer) => { if (steer) offered.push(steer) } })
    await waitFor(() => offered.length > 0, 'the turn to take messages')
    const late = offered[0]('next')
    expect((await running).error).toBeUndefined()
    expect(items(w.hub)).toEqual([[CANCELLED, codexNickname(CANCELLED), 'running', 'MODE=LONG']])
    // The next turn holds the process: it is left up, so nothing else would end the item.
    const release = w.pool.hold(AGENT_ID)
    expect(await late).toBe('unavailable')
    await waitFor(() => w.fake.received('session/cancel').length > 0, 'the unowned turn to be cancelled')
    await settle()
    expect(w.pool.status(AGENT_ID).state).toBe('running')
    expect(items(w.hub)).toEqual([[CANCELLED, codexNickname(CANCELLED), 'stopped', 'MODE=LONG']])
    release()
    // Under 1 s alone; real delays and two turns overrun the default 5 s under full-suite load.
  }, 15_000)

  it('a prompt Codex ends cancelled with no Stop from Cinna leaves the child running', async () => {
    const fixture = loadActivityFixture('codex', 'subagent_collab_cancel')
    const w = world({
      sessionId: fixture.notifications[0].sessionId, launcher: 'codex',
      emit: steps(fixture.notifications), response: { stopReason: 'cancelled' }
    })
    await w.run()
    expect(items(w.hub)).toEqual([[CANCELLED, codexNickname(CANCELLED), 'running', 'MODE=LONG']])
  })
})

/* ------------------------------- OpenCode subagents (recorded live, 2.0.27) */

describe('OpenCode subagents over child-session updates', () => {
  const ROOT = 'ses_root'
  const ocSteps = (frames: OpencodeFrame[]): FakeAcpStep[] =>
    frames.map((frame) => 'method' in frame
      ? { kind: 'notify', method: frame.method, params: frame.params }
      : { kind: 'update', sessionId: frame.sessionId, update: frame.update })
  const recorded = (name: string): { emit: FakeAcpStep[]; after: FakeAcpStep[]; frames: OpencodeFrame[] } => {
    const fixture = loadOpencodeFixture(name)
    const cut = fixture.promptReturnedAtIndex ?? fixture.frames.length
    return { emit: ocSteps(fixture.frames.slice(0, cut)), after: ocSteps(fixture.frames.slice(cut)), frames: fixture.frames }
  }
  const ocItems = (hub: SessionActivityHub): [string, string, string | null][] =>
    hub.snapshot(CHAT_ID).items.map((item) => [item.id.slice(ROOT.length + 1), item.title, item.state])
  const unrouted = (): number =>
    getLogEntries().filter((entry) => entry.message.includes('extension notification with no session')).length
  const subagentLanes = (parts: LanePart[]): [string, string | undefined][] =>
    parts.filter((part) => part.kind === 'tool' && part.toolName === 'subagent').map((part) => [part.toolId!, part.parentToolId])
  /** Child session → the `subagent` call whose final update names it (`rawOutput.metadata.sessionID`). */
  const namedCalls = (frames: OpencodeFrame[]): Map<string, string> => {
    const out = new Map<string, string>()
    for (const frame of frames) {
      const update = ('method' in frame ? frame.params.update : frame.update) as Record<string, unknown> | undefined
      const named = (update?.rawOutput as { metadata?: { sessionID?: string } } | undefined)?.metadata?.sessionID
      if (named) out.set(named, update!.toolCallId as string)
    }
    return out
  }
  /** Every child's own frames (ids `<child>:call_…`) sit in the lane of the call that named that child. */
  const expectLanesByNamedCall = (parts: LanePart[], frames: OpencodeFrame[]): void => {
    const calls = namedCalls(frames)
    const tools = parts.filter((part) => part.kind === 'tool' && part.toolId!.includes(':'))
    expect(tools.length).toBeGreaterThan(0)
    for (const part of tools) {
      const child = part.toolId!.slice(0, part.toolId!.indexOf(':'))
      expect([part.toolId, part.parentToolId]).toEqual([part.toolId, calls.get(child)])
    }
  }

  it('two levels: one item per child, named by its agent; the worker’s lane inside orch’s, each report in its lane', async () => {
    clearLogEntries()
    const { emit, after } = recorded('subagent_nested')
    const w = world({ sessionId: ROOT, emit, after, launcher: 'opencode' })
    const result = await w.run()
    expect(result.error).toBeUndefined()
    const parts = result.parts as unknown as LanePart[]
    const lanes = subagentLanes(parts)
    expect(lanes).toHaveLength(2)
    const [[orchCall, top], [workerCall, under]] = lanes
    expect(top).toBeUndefined()
    expect(under).toBe(orchCall)
    expect(workerCall.startsWith('ses_orch:')).toBe(true)
    expect(parts.find((part) => part.toolName === 'shell')?.parentToolId).toBe(workerCall)
    expect(parts.filter((part) => part.kind === 'text').map((part) => [part.text, part.parentToolId])).toEqual([
      ['WORKER DONE', workerCall], ['ORCH FINAL', orchCall], ['done', undefined]
    ])
    expect(ocItems(w.hub)).toEqual([['ses_orch', 'orch', 'completed'], ['ses_worker', 'worker', 'completed']])
    expect(w.hub.snapshot(CHAT_ID).items.map((item) => item.detail)).toEqual(['Nested mode probe', 'nested worker'])
    expect(unrouted()).toBe(0)
  })

  it('a fan-out: each child sits under the call that names it, by title not by order', async () => {
    const { emit, after, frames } = recorded('subagent_nested_fanout')
    const w = world({ sessionId: ROOT, emit, after, launcher: 'opencode' })
    const result = await w.run()
    expect(result.error).toBeUndefined()
    expectLanesByNamedCall(result.parts as unknown as LanePart[], frames)
    expect(ocItems(w.hub).map(([child, title, state]) => [child, title, state]).sort()).toEqual([
      ['ses_leaf_one', 'leaf', 'completed'], ['ses_leaf_two', 'leaf', 'completed'], ['ses_orch', 'orch', 'completed'],
      ['ses_worker_one', 'worker', 'completed'], ['ses_worker_two', 'worker', 'completed']
    ])
  })

  it('a fan-out whose second worker starts first still files each child under its own call', async () => {
    const { frames } = recorded('subagent_nested_fanout')
    const childOf = (frame: OpencodeFrame): string | undefined => ('method' in frame ? frame.params.childSessionId as string : undefined)
    const second = new Set(['ses_worker_two', 'ses_leaf_two'])
    const first = frames.findIndex((frame) => childOf(frame) === 'ses_worker_one')
    // Orch's update giving worker two's call its input (a child only starts once its call has one).
    const announce = frames.findIndex((frame, index) => index > first && childOf(frame) === 'ses_orch' &&
      ((frame as { params: { update?: { rawInput?: { description?: string } } } }).params.update?.rawInput?.description === 'worker two'))
    expect(announce).toBeGreaterThan(first)
    // Then worker two's whole tree ahead of worker one's first frame; everything else in recorded order.
    const rest = frames.slice(first).filter((_, index) => index + first !== announce)
    const reordered = [
      ...frames.slice(0, first),
      frames[announce],
      ...rest.filter((frame) => second.has(childOf(frame) ?? '')),
      ...rest.filter((frame) => !second.has(childOf(frame) ?? ''))
    ]
    expect(reordered).toHaveLength(frames.length)
    expect(childOf(reordered[first + 1])).toBe('ses_worker_two')
    const w = world({ sessionId: ROOT, emit: ocSteps(reordered), launcher: 'opencode' })
    const result = await w.run()
    expect(result.error).toBeUndefined()
    expectLanesByNamedCall(result.parts as unknown as LanePart[], frames)
  })

  /** `subagent_nested`'s frames, rewritten; the prompt answers after the last. */
  const nested = (rewrite: (frames: OpencodeFrame[]) => OpencodeFrame[]): FakeAcpStep[] =>
    ocSteps(rewrite(structuredClone(recorded('subagent_nested').frames)))
  const isChild = (frame: OpencodeFrame, child: string): boolean => 'method' in frame && frame.params.childSessionId === child
  const description = (frame: OpencodeFrame): unknown =>
    'method' in frame ? undefined : (frame.update.rawInput as { description?: unknown } | undefined)?.description
  /** Text parts as [text, lane]: no child's text may sit in the root's reply. */
  const texts = (parts: LanePart[]): [string | undefined, string | undefined][] =>
    parts.filter((part) => part.kind === 'text').map((part) => [part.text, part.parentToolId])

  it('a child heard before its call’s description: its frames wait for the match, then go out in its lane, in order', async () => {
    // Mutation: send an unmatched child's update at once (no hold) and
    // ORCH's opening frames, then WORKER DONE, land in the root's reply.
    const w = world({
      sessionId: ROOT, launcher: 'opencode', emit: nested((frames) => {
        // The root's updates giving the call its input, moved after the worker's report.
        const described = frames.filter((frame) => description(frame) !== undefined)
        expect(described).toHaveLength(2)
        const rest = frames.filter((frame) => !described.includes(frame))
        const after = rest.findIndex((frame) => isChild(frame, 'ses_worker') && (frame as { params: { status?: string } }).params.status === 'completed')
        return [...rest.slice(0, after), ...described, ...rest.slice(after)]
      })
    })
    const result = await w.run()
    expect(result.error).toBeUndefined()
    const parts = result.parts as unknown as LanePart[]
    const [[orchCall, top], [workerCall, under]] = subagentLanes(parts)
    expect([top, under]).toEqual([undefined, orchCall])
    expect(parts.find((part) => part.toolName === 'shell')?.parentToolId).toBe(workerCall)
    expect(texts(parts)).toEqual([['WORKER DONE', workerCall], ['ORCH FINAL', orchCall], ['done', undefined]])
    // Every status of orch's came before its call named the agent: its item keeps the title.
    expect(ocItems(w.hub)).toEqual([['ses_orch', 'Nested mode probe', 'completed'], ['ses_worker', 'worker', 'completed']])
  })

  it('a child whose title never matches waits for the completion that names it, its nested worker with it', async () => {
    // Mutation: as above; without the hold ORCH FINAL is the root's text.
    const w = world({
      sessionId: ROOT, launcher: 'opencode', emit: nested((frames) => {
        for (const frame of frames) if (isChild(frame, 'ses_orch')) (frame as { params: Record<string, unknown> }).params.title = 'Renamed by the agent'
        return frames
      })
    })
    const result = await w.run()
    expect(result.error).toBeUndefined()
    const parts = result.parts as unknown as LanePart[]
    const [[orchCall, top], [workerCall, under]] = subagentLanes(parts)
    expect([top, under]).toEqual([undefined, orchCall])
    expect(texts(parts)).toEqual([['WORKER DONE', workerCall], ['ORCH FINAL', orchCall], ['done', undefined]])
  })

  it('a child no call ever names goes out under a lane of its own once its call ends unnamed, never in the root’s reply', async () => {
    // Mutation: drop `closed` (opencodeChildren) and ORCH's work goes out only at the answer's drain, after `done`.
    clearLogEntries()
    const w = world({
      sessionId: ROOT, launcher: 'opencode', emit: nested((frames) => {
        for (const frame of frames) {
          if (isChild(frame, 'ses_orch')) (frame as { params: Record<string, unknown> }).params.title = 'Renamed by the agent'
          const metadata = 'method' in frame ? undefined : (frame.update.rawOutput as { metadata?: Record<string, unknown> } | undefined)?.metadata
          if (metadata) delete metadata.sessionID
        }
        return frames
      })
    })
    const result = await w.run()
    expect(result.error).toBeUndefined()
    const parts = result.parts as unknown as LanePart[]
    const workerCall = parts.find((part) => part.kind === 'tool' && part.toolName === 'subagent' && part.toolId!.startsWith('ses_orch:'))!.toolId!
    expect(texts(parts)).toEqual([['WORKER DONE', workerCall], ['ORCH FINAL', 'subagent:ses_orch'], ['done', undefined]])
    expect(parts.find((part) => part.toolId === workerCall)?.parentToolId).toBe('subagent:ses_orch')
    expect(getLogEntries().filter((entry) => entry.level === 'warn' && entry.message.includes('never matched to its call'))).toHaveLength(1)
  })

  /** `subagent_nested`, orch renamed and the root's call never completing: nothing names orch before the prompt ends. */
  const unnamedOrch = (): FakeAcpStep[] => nested((frames) => {
    for (const frame of frames) if (isChild(frame, 'ses_orch')) (frame as { params: Record<string, unknown> }).params.title = 'Renamed by the agent'
    return frames.filter((frame) => 'method' in frame || (frame.update.status !== 'completed' && frame.update.sessionUpdate !== 'agent_message_chunk'))
  })

  it('a prompt that never answers a Stop still writes what an unnamed child held, under its own lane', async () => {
    // Mutation: drain only on an answer and ORCH's work is never written.
    const stop = new AbortController()
    const w = world({ sessionId: ROOT, launcher: 'opencode', signal: stop.signal, emit: [], prompts: [{ emit: unnamedOrch(), hang: true }] })
    const running = w.run()
    await waitFor(() => w.hub.snapshot(CHAT_ID).items.length === 2 && !w.hub.hasRunning({ agentId: AGENT_ID }), 'both children to end')
    stop.abort()
    const parts = (await running).parts as unknown as LanePart[]
    const workerCall = parts.find((part) => part.kind === 'tool' && part.toolName === 'subagent' && part.toolId!.startsWith('ses_orch:'))!.toolId!
    expect(texts(parts)).toEqual([['WORKER DONE', workerCall], ['ORCH FINAL', 'subagent:ses_orch']])
  })

  it('a prompt that fails still writes what an unnamed child held, under its own lane', async () => {
    // Mutation: as above, on the failure path.
    const w = world({ sessionId: ROOT, launcher: 'opencode', emit: [], prompts: [{ emit: unnamedOrch(), error: { message: 'boom' } }] })
    const result = await w.run()
    expect(result.error).toBeDefined()
    expect(texts(result.parts as unknown as LanePart[]).map(([text, lane]) => [text, lane?.startsWith('subagent:') ? lane : 'call'])).toEqual([
      ['WORKER DONE', 'call'], ['ORCH FINAL', 'subagent:ses_orch']
    ])
  })

  it('on a Stop: every level arrives interrupted and ends stopped, the shell left running inside fails in its lane', async () => {
    const { emit, after } = recorded('subagent_nested_cancel')
    const w = world({ sessionId: ROOT, emit, after, launcher: 'opencode', response: { stopReason: 'cancelled' } })
    const result = await w.run()
    const parts = result.parts as unknown as LanePart[]
    const [[orchCall], [workerCall, under]] = subagentLanes(parts)
    expect(under).toBe(orchCall)
    const shell = parts.find((part) => part.kind === 'tool' && part.toolName === 'shell')!
    expect(shell.parentToolId).toBe(workerCall)
    expect(parts.find((part) => part.kind === 'tool_result' && part.toolId === shell.toolId)?.text).toContain('interrupted')
    // Sorted: the hub orders ended items by `endedAt`, and the two often end in the same millisecond.
    expect(ocItems(w.hub).sort()).toEqual([['ses_orch', 'orch', 'stopped'], ['ses_worker', 'worker', 'stopped']])
  })

  it('background: the call completes at once, its item runs on until the child says it ended, after the prompt returned', async () => {
    const { emit, after } = recorded('subagent_background')
    const w = world({ sessionId: ROOT, emit, after: [{ kind: 'delay', ms: 300 }, ...after], launcher: 'opencode' })
    const result = await w.run()
    expect(result.error).toBeUndefined()
    const parts = result.parts as unknown as LanePart[]
    const [[call]] = subagentLanes(parts)
    expect(parts.find((part) => part.kind === 'tool_result' && part.toolId === call)?.text).toContain('working in the background')
    // The call is completed; the subagent is not.
    expect(ocItems(w.hub)).toEqual([['ses_orch', 'orch', 'running']])
    await waitFor(() => w.hub.snapshot(CHAT_ID).items.length === 2 && !w.hub.hasRunning({ agentId: AGENT_ID }), 'both children to end')
    expect(ocItems(w.hub).sort()).toEqual([['ses_orch', 'orch', 'completed'], ['ses_worker', 'worker', 'completed']])
  })

  it('the next prompt writes off a child OpenCode no longer reports, as lost and with a warn', async () => {
    const { emit } = recorded('subagent_background')
    const w = world({ sessionId: ROOT, emit: [], launcher: 'opencode', prompts: [{ emit }, {}] })
    expect((await w.run()).error).toBeUndefined()
    expect(ocItems(w.hub)).toEqual([['ses_orch', 'orch', 'running']])
    clearLogEntries()
    expect((await w.run()).error).toBeUndefined()
    expect(ocItems(w.hub)).toEqual([['ses_orch', 'orch', 'lost']])
    expect(getLogEntries().filter((entry) => entry.level === 'warn' && entry.message.includes('OpenCode subagents still shown running'))).toHaveLength(1)
  })

  it('an answer leaves a background child’s unmatched child held, not split into a lane of its own', async () => {
    // Mutation: drain everything at the answer (`drainOpencodeChildren(true)` → `()`) and the
    // worker's first call goes out under `subagent:ses_worker` while orch's later frames name its call.
    clearLogEntries()
    const { frames } = recorded('subagent_background')
    const cut = loadOpencodeFixture('subagent_background').promptReturnedAtIndex!
    const statusOf = (frame: OpencodeFrame): unknown => ('method' in frame ? frame.params.status : undefined)
    const isUpdateOf = (frame: OpencodeFrame, child: string): boolean => isChild(frame, child) && 'method' in frame && frame.params.type === 'update'
    const kindOf = (frame: OpencodeFrame): unknown => ('method' in frame ? (frame.params.update as { sessionUpdate?: unknown } | undefined)?.sessionUpdate : undefined)
    // Before the answer: orch's spawn call with no input yet, the worker's start and its first call.
    const early = frames.filter((frame, index) => index >= cut && (
      (isUpdateOf(frame, 'ses_orch') && kindOf(frame) === 'tool_call') ||
      (isChild(frame, 'ses_worker') && (statusOf(frame) === 'created' || statusOf(frame) === 'running')) ||
      (isUpdateOf(frame, 'ses_worker') && kindOf(frame) === 'tool_call')))
    expect(early).toHaveLength(4)
    const late = frames.slice(cut).filter((frame) => !early.includes(frame))
    const w = world({ sessionId: ROOT, launcher: 'opencode', emit: ocSteps([...frames.slice(0, cut), ...early]), after: ocSteps(late) })
    const result = await w.run()
    expect(result.error).toBeUndefined()
    const parts = result.parts as unknown as LanePart[]
    expect(parts.filter((part) => part.parentToolId?.startsWith('subagent:'))).toEqual([])
    await waitFor(() => w.hub.snapshot(CHAT_ID).items.length === 2 && !w.hub.hasRunning({ agentId: AGENT_ID }), 'both children to end')
    expect(getLogEntries().filter((entry) => entry.level === 'warn' && entry.message.includes('never matched'))).toEqual([])
  })

  const rootStep = (update: Record<string, unknown>): FakeAcpStep => ({ kind: 'update', sessionId: ROOT, update })
  const childStep = (childSessionId: string, params: Record<string, unknown>): FakeAcpStep => ({
    kind: 'notify', method: 'opencode/session/child_update', params: { rootSessionId: ROOT, childSessionId, parentSessionId: ROOT, title: 'Renamed by the agent', ...params }
  })
  /** On its own after the answer: the root spawns a subagent whose title matches nothing, and it says something. */
  const unmatchedOnItsOwn: FakeAcpStep[] = [
    rootStep({ sessionUpdate: 'agent_message_chunk', messageId: 'm-follow', content: { type: 'text', text: 'on my own' } }),
    rootStep({ sessionUpdate: 'tool_call', toolCallId: 'call_x', title: 'subagent', name: 'subagent', kind: 'think', status: 'pending', rawInput: {} }),
    childStep('ses_x', { type: 'status', status: 'running' }),
    childStep('ses_x', { type: 'update', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'HELD WORK' } } })
  ]
  const followUpIo = { signal: new AbortController().signal, onEvent: () => {} }

  it('a follow-up that ends on quiet writes what an unmatched child still holds, under its own lane', async () => {
    // Mutation: drop the drain from the follow-up's `end` and HELD WORK is never written.
    const w = world({
      sessionId: ROOT, launcher: 'opencode', emit: [], followUps: true, costedEnd: false, followUpQuietMs: 100,
      // The call ends without naming the child: nothing open, so the quiet ends the turn.
      prompts: [{ after: [...unmatchedOnItsOwn, rootStep({ sessionUpdate: 'tool_call_update', toolCallId: 'call_x', status: 'completed', rawOutput: {} })] }]
    })
    expect((await w.run()).error).toBeUndefined()
    await waitFor(() => w.followUps.length === 1, 'the follow-up the agent opens')
    await settle(100)
    const result = await w.followUps[0].run(followUpIo)
    expect(texts(result.parts as unknown as LanePart[])).toEqual([['on my own', undefined], ['HELD WORK', 'subagent:ses_x']])
  })

  it('a follow-up a user turn takes over writes nothing a child holds: the user turn’s call may still name it', async () => {
    // Mutation: drain on `closed` too and HELD WORK goes out in the follow-up, under `subagent:ses_x`.
    const w = world({
      sessionId: ROOT, launcher: 'opencode', emit: [], followUps: true,
      prompts: [
        // The child ends once the follow-up runs, with its call still open: it can still be named.
        { after: [...unmatchedOnItsOwn, { kind: 'delay', ms: 300 }, childStep('ses_x', { type: 'status', status: 'completed' })] },
        { emit: [rootStep({ sessionUpdate: 'tool_call_update', toolCallId: 'call_x', status: 'completed', rawOutput: { metadata: { sessionID: 'ses_x' } } })] }
      ]
    })
    expect((await w.run()).error).toBeUndefined()
    await waitFor(() => w.followUps.length === 1, 'the follow-up the agent opens')
    const followUp = w.followUps[0].run(followUpIo)
    await waitFor(() => w.hub.snapshot(CHAT_ID).items.some((item) => item.state === 'completed'), 'the child to end')
    const user = await w.run()
    expect(user.error).toBeUndefined()
    const followed = await followUp
    expect(texts(followed.parts as unknown as LanePart[])).toEqual([['on my own', undefined]])
    expect(texts(user.parts as unknown as LanePart[])).toEqual([['HELD WORK', 'call_x']])
  })

  it('the next prompt leaves children that ended alone, and says nothing', async () => {
    const { emit, after } = recorded('subagent_nested')
    const w = world({ sessionId: ROOT, emit: [], launcher: 'opencode', prompts: [{ emit, after }, {}] })
    expect((await w.run()).error).toBeUndefined()
    clearLogEntries()
    expect((await w.run()).error).toBeUndefined()
    expect(ocItems(w.hub).map(([, , state]) => state)).toEqual(['completed', 'completed'])
    expect(getLogEntries().filter((entry) => entry.message.includes('OpenCode subagents'))).toEqual([])
  })
})
