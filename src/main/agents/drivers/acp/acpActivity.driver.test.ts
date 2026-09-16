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
import { createFakeAcp, settle, waitFor, type FakeAcp, type FakeAcpStep } from './testSupport/fakeAcp'
import { beforeCapability, loadActivityFixture, type ActivityFixture } from './testSupport/subagentFixtures'
import { ACP_PROTOCOL_VERSION, type AcpProcessPool } from './types'

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
  run(): ReturnType<ReturnType<typeof createAcpDriver>['run']>
}

function world(options: {
  sessionId: string
  emit: FakeAcpStep[]
  after?: FakeAcpStep[]
  reapMs?: number
  followUps?: boolean
}): World {
  const hub = createSessionActivityHub()
  const fake = createFakeAcp({
    newSession: { sessionId: options.sessionId },
    prompt: { emit: options.emit, ...(options.after ? { after: options.after } : {}) }
  })
  const pool = createAcpProcessPool({
    start: startAcpConnection,
    ...(options.reapMs ? { idleReapMs: options.reapMs } : {}),
    ...activityReapDeps(hub)
  })
  const unwire = wirePoolToActivity(pool, hub)
  const launcher: AcpLauncher = {
    id: 'claude',
    endsTurnsWithCostedUsage: true,
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
    launcher: (id) => (id === 'claude' ? launcher : undefined),
    readRuntime: () => ({
      type: 'folder',
      folder: {
        name: 'Activity', slug: 'activity', description: '', path: '/tmp/agents/activity', kind: 'kit',
        enabled: true, readiness: 'ok', readinessReason: null, runtime: { engine: 'claude' }
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
    run: () => driver.run('__default__', ROW, {
      chatId: CHAT_ID,
      wireContent: 'go',
      signal: new AbortController().signal,
      onEvent: () => {},
      runScope: RUN_SCOPE
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
