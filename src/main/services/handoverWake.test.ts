import { describe, it, expect, beforeEach, vi } from 'vitest'
import type { HandoverRow } from '../db/handovers'

vi.mock('../db/client', () => ({ getDb: () => ({}) }))
vi.mock('../db/handovers', () => ({ handoverRepo: {} }))
vi.mock('../logger/logger', () => ({
  createLogger: () => ({ debug() {}, info() {}, warn() {}, error() {} })
}))
vi.mock('./chatRouting', () => ({ chatAnswersToAgent: () => null }))
vi.mock('./inboxService', () => ({ inboxService: { recordRunEvent() {} } }))
vi.mock('./runExecutionService', () => ({ runExecutionService: { isRunning: () => false, start: () => {} } }))

const { createHandoverWake, handoverWakeTimings } = await import('./handoverWake')

/**
 * The wake is a *notification about work that is already recorded*, and every
 * test here is about that asymmetry: it may be refused, it may time out, it may
 * queue behind another — and none of those may take the handover's own result
 * down with them.
 *
 * The clock and the delay are injected rather than faked with timers, so the
 * busy-chat loop is driven deterministically instead of by `vi.advanceTimers`
 * racing a promise chain.
 */
const SCOPE = { profileUserId: 'profile', settingsUserId: '__default__' }

function row(overrides: Partial<HandoverRow> = {}): HandoverRow {
  return {
    id: 'row-1',
    userId: 'profile',
    agentId: 'folder:external:root:.',
    folderPath: '/projects/uploader',
    handoverId: '20260917-1200-retry',
    taskId: 'task-7',
    originAgentId: 'agent-known',
    originChatId: 'chat-known',
    originTaskId: null,
    depth: 1,
    groupId: null,
    execution: 'ask',
    state: 'running',
    refusalReason: null,
    warning: null,
    briefDigest: 'd1',
    reportDigest: null,
    reportStatus: null,
    gateRequestId: null,
    gateChatId: null,
    runId: null,
    wokeAt: null,
    wakeRunId: null,
    lastScannedAt: new Date(0),
    createdAt: new Date(0),
    updatedAt: new Date(0),
    ...overrides
  } as HandoverRow
}

interface Fixture {
  wake: ReturnType<typeof createHandoverWake>
  sent: { chatId: string; content: string }[]
  recorded: { rowId: string; patch: Record<string, unknown> }[]
  running: Set<string>
  refusal: string | null
  sendError: string | null
  /** Advanced by the injected `delay`, so the timeout is reached without waiting. */
  clock: number
  /** Resolves the in-flight send, so ordering can be observed. */
  release: (() => void) | null
}

function fixture(options: { holdSend?: boolean } = {}): Fixture {
  const f: Fixture = {
    sent: [],
    recorded: [],
    running: new Set(),
    refusal: null,
    sendError: null,
    clock: 0,
    release: null
  } as unknown as Fixture

  f.wake = createHandoverWake({
    chatAnswersToAgent: () => f.refusal,
    isRunning: (chatId) => f.running.has(chatId),
    async send(_scope, chatId, content) {
      if (f.sendError) throw new Error(f.sendError)
      f.sent.push({ chatId, content })
      if (options.holdSend) await new Promise<void>((resolve) => { f.release = resolve })
      return { runId: `run-${f.sent.length}` }
    },
    record: (_userId, rowId, patch) => f.recorded.push({ rowId, patch: patch as Record<string, unknown> }),
    logger: { debug() {}, info() {}, warn() {} },
    now: () => f.clock,
    // The loop's own clock: every poll advances time, so a busy chat reaches the
    // ceiling in as many iterations as the real one would minutes.
    delay: async (ms) => {
      f.clock += ms
    }
  })
  return f
}

const done = { status: 'done' as const, summary: 'Retry added', body: 'Body.' }

/** Let every queued microtask and timer callback run, without counting them. */
const settled = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

beforeEach(() => {
  handoverWakeTimings.pollMs = 1_000
  handoverWakeTimings.maxWaitMs = 30 * 60_000
})

describe('waking an origin chat', () => {
  it('sends the packet and records the turn that carried it', async () => {
    const f = fixture()
    f.wake.wake({ scope: SCOPE, row: row(), ...done })
    await f.wake.idle()

    expect(f.sent).toEqual([
      { chatId: 'chat-known', content: expect.stringContaining('Handover `20260917-1200-retry` finished: Retry added') }
    ])
    expect(f.recorded).toEqual([
      { rowId: 'row-1', patch: expect.objectContaining({ wakeRunId: 'run-1', wokeAt: expect.any(Date) }) }
    ])
  })

  it('does nothing at all for a human-origin handover', async () => {
    const f = fixture()
    f.wake.wake({ scope: SCOPE, row: row({ originChatId: null }), ...done })
    f.wake.wake({ scope: SCOPE, row: row({ originAgentId: null }), ...done })
    await f.wake.idle()

    // No send, and — the part that matters — no warning either: there is no
    // failure here to report.
    expect(f.sent).toEqual([])
    expect(f.recorded).toEqual([])
  })

  it('refuses rather than sends when the chat no longer answers to the agent', async () => {
    // `origin.chat` is a string out of a file in a project folder. Anything that
    // can write there can name any chat, so the guard is the whole point.
    const f = fixture()
    f.refusal = 'the chat no longer answers to this agent'
    f.wake.wake({ scope: SCOPE, row: row(), ...done })
    await f.wake.idle()

    expect(f.sent).toEqual([])
    expect(f.recorded).toEqual([
      { rowId: 'row-1', patch: { warning: 'wake_refused:the chat no longer answers to this agent' } }
    ])
  })

  it('waits for a busy chat and sends once it is free', async () => {
    const f = fixture()
    f.running.add('chat-known')
    f.wake.wake({ scope: SCOPE, row: row(), ...done })
    await Promise.resolve()
    expect(f.sent).toEqual([])

    f.running.delete('chat-known')
    await f.wake.idle()
    expect(f.sent.length).toBe(1)
  })

  it('gives up on a chat that never goes idle, and says so', async () => {
    const f = fixture()
    f.running.add('chat-known')
    f.wake.wake({ scope: SCOPE, row: row(), ...done })
    await f.wake.idle()

    expect(f.sent).toEqual([])
    expect(f.recorded).toEqual([{ rowId: 'row-1', patch: { warning: 'wake_timed_out' } }])
    expect(f.clock).toBeGreaterThanOrEqual(handoverWakeTimings.maxWaitMs)
  })

  it('records a refused turn instead of losing it', async () => {
    const f = fixture()
    f.sendError = 'This conversation already has a turn running.'
    f.wake.wake({ scope: SCOPE, row: row(), ...done })
    await f.wake.idle()

    expect(f.recorded).toEqual([
      { rowId: 'row-1', patch: { warning: 'wake_failed:This conversation already has a turn running.' } }
    ])
  })

  it('queues two handovers finishing into the same chat, never racing them', async () => {
    // A fan-out is the point of the feature, and `runExecutionService.start`
    // refuses a chat that already has a turn. The chain is what turns that
    // refusal into a queue.
    const f = fixture({ holdSend: true })
    f.wake.wake({ scope: SCOPE, row: row({ id: 'row-1' }), ...done })
    f.wake.wake({ scope: SCOPE, row: row({ id: 'row-2' }), ...done })

    await settled()
    expect(f.sent.length).toBe(1)

    f.release?.()
    await settled()
    expect(f.sent.length).toBe(2)

    f.release?.()
    await f.wake.idle()
    expect(f.recorded.map((entry) => entry.rowId)).toEqual(['row-1', 'row-2'])
  })

  it('lets a chat that is not the origin proceed in parallel', async () => {
    const f = fixture({ holdSend: true })
    f.wake.wake({ scope: SCOPE, row: row({ id: 'row-1', originChatId: 'chat-a' }), ...done })
    f.wake.wake({ scope: SCOPE, row: row({ id: 'row-2', originChatId: 'chat-b' }), ...done })

    await settled()
    expect(f.sent.map((entry) => entry.chatId).sort()).toEqual(['chat-a', 'chat-b'])
  })

  it('never throws at its caller, whatever goes wrong', () => {
    const f = fixture()
    f.sendError = 'boom'
    expect(() => f.wake.wake({ scope: SCOPE, row: row(), ...done })).not.toThrow()
  })
})

describe('waking an origin chat once for a whole group', () => {
  it('sends one packet naming every member and records the wake on each row', async () => {
    const f = fixture()
    const rows = [
      row({ id: 'row-1', handoverId: '20260917-1200-api', state: 'done', summary: 'Retry added' }),
      row({ id: 'row-2', handoverId: '20260917-1200-web', state: 'failed', summary: 'The build broke' })
    ]
    f.wake.wakeGroup({ scope: SCOPE, groupId: 'release-cut', rows })
    await f.wake.idle()

    expect(f.sent.length).toBe(1)
    expect(f.sent[0].chatId).toBe('chat-known')
    expect(f.sent[0].content).toContain('Handover group `release-cut` has finished — 2 handovers:')
    expect(f.sent[0].content).toContain('`20260917-1200-api` — done: Retry added')
    expect(f.sent[0].content).toContain('`20260917-1200-web` — failed: The build broke')

    // Every member, not just the first: `woke_at` is what keeps the next scan
    // from telling that chat about the same handovers again.
    expect(f.recorded.map((entry) => entry.rowId)).toEqual(['row-1', 'row-2'])
    for (const entry of f.recorded) {
      expect(entry.patch).toEqual(expect.objectContaining({ wakeRunId: 'run-1', wokeAt: expect.any(Date) }))
    }
  })

  it('records a refusal on every member rather than on the first', async () => {
    const f = fixture()
    f.refusal = 'the chat is gone'
    f.wake.wakeGroup({
      scope: SCOPE,
      groupId: 'release-cut',
      rows: [row({ id: 'row-1' }), row({ id: 'row-2' })]
    })
    await f.wake.idle()

    expect(f.sent).toEqual([])
    expect(f.recorded).toEqual([
      { rowId: 'row-1', patch: { warning: 'wake_refused:the chat is gone' } },
      { rowId: 'row-2', patch: { warning: 'wake_refused:the chat is gone' } }
    ])
  })

  it('says nothing for a group whose origin is a person, or for no rows at all', async () => {
    const f = fixture()
    f.wake.wakeGroup({ scope: SCOPE, groupId: 'g', rows: [row({ originChatId: null })] })
    f.wake.wakeGroup({ scope: SCOPE, groupId: 'g', rows: [] })
    await f.wake.idle()

    expect(f.sent).toEqual([])
    expect(f.recorded).toEqual([])
  })

  it('queues behind a single wake into the same chat instead of racing it', async () => {
    const f = fixture({ holdSend: true })
    f.wake.wake({ scope: SCOPE, row: row({ id: 'row-1' }), ...done })
    f.wake.wakeGroup({ scope: SCOPE, groupId: 'g', rows: [row({ id: 'row-2', state: 'done' })] })

    await settled()
    expect(f.sent.length).toBe(1)
    f.release?.()
    await settled()
    expect(f.sent.length).toBe(2)
    f.release?.()
    await f.wake.idle()
  })
})
