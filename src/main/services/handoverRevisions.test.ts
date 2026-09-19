import { describe, it, expect, beforeEach, vi } from 'vitest'
import type { HandoverRow } from '../db/handovers'

vi.mock('../auth/activation', () => ({ userActivation: { isActivated: () => true } }))
vi.mock('../auth/scope', () => ({ getProfileScopeUserId: () => 'profile' }))
vi.mock('../db/client', () => ({ getDb: () => ({}) }))
vi.mock('../db/handovers', () => ({ handoverRepo: {} }))
vi.mock('../logger/logger', () => ({
  createLogger: () => ({ debug() {}, info() {}, warn() {}, error() {} })
}))
vi.mock('./chatRouting', () => ({ chatAnswersToAgent: () => null }))
vi.mock('./inboxService', () => ({ inboxService: { recordRunEvent() {} } }))
vi.mock('./runExecutionService', () => ({ runExecutionService: { isRunning: () => false, start: () => {} } }))

const { createHandoverRevisions, handoverRevisionTimings } = await import('./handoverRevisions')

/**
 * The mirror image of `handoverWake`: there the origin chat is busy because the
 * requester carried on, here the executor's chat is busy because it is still
 * working through the brief. Same queue, same asymmetry — the revision is on
 * disk whatever happens here, so nothing this module does may throw at the scan
 * that called it.
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
    state: 'running',
    ...overrides
  } as HandoverRow
}

interface Fixture {
  sender: ReturnType<typeof createHandoverRevisions>
  sent: { chatId: string; content: string }[]
  recorded: { rowId: string; patch: Record<string, unknown> }[]
  running: Set<string>
  refusal: string | null
  sendError: string | null
  clock: number
  release: (() => void) | null
  /** Settles the turn the last send handed back, as a real one does minutes later. */
  endTurn: ((outcome: { state: string; text: string }) => void) | null
}

function fixture(options: { holdSend?: boolean } = {}): Fixture {
  const f: Fixture = {
    sent: [],
    recorded: [],
    running: new Set(),
    refusal: null,
    sendError: null,
    clock: 0,
    release: null,
    endTurn: null
  } as unknown as Fixture

  f.sender = createHandoverRevisions({
    chatAnswersToAgent: () => f.refusal,
    isRunning: (chatId) => f.running.has(chatId),
    async send(_scope, chatId, content) {
      if (f.sendError) throw new Error(f.sendError)
      f.sent.push({ chatId, content })
      if (options.holdSend) await new Promise<void>((resolve) => { f.release = resolve })
      const completed = new Promise<{ state: string; text: string }>((resolve) => {
        f.endTurn = resolve
      })
      return { runId: `run-${f.sent.length}`, completed: completed as never }
    },
    record: (_userId, rowId, patch) => f.recorded.push({ rowId, patch: patch as Record<string, unknown> }),
    logger: { info() {}, warn() {} },
    now: () => f.clock,
    delay: async (ms) => {
      f.clock += ms
    }
  })
  return f
}

const input = (overrides: Record<string, unknown> = {}) => ({
  scope: SCOPE,
  row: row(),
  chatId: 'chat-exec',
  file: '001.md',
  content: 'Revision 001 of handover `20260917-1200-retry`.',
  ...overrides
})

beforeEach(() => {
  handoverRevisionTimings.pollMs = 1_000
  handoverRevisionTimings.maxWaitMs = 30 * 60_000
})

describe('delivering a revision', () => {
  it('starts a turn on the executor’s chat and records the run it became', async () => {
    const f = fixture()
    f.sender.send(input())
    await f.sender.idle()

    expect(f.sent).toEqual([
      { chatId: 'chat-exec', content: 'Revision 001 of handover `20260917-1200-retry`.' }
    ])
    expect(f.recorded).toEqual([{ rowId: 'row-1', patch: { runId: 'run-1' } }])
  })

  it('hands the turn’s end to whoever asked to follow it', async () => {
    /*
      A revision is a turn like the first one, and `handoverService` closes a
      handover from the turn's outcome when no report was written. This sender
      used to drop `completed`, so a revision's turn was watched by nobody and
      the row was swept as a lost run two minutes later. Mutation: stop calling
      `watch` and `followed` stays null.
    */
    const f = fixture()
    let followed: Promise<{ state: string; text: string }> | null = null
    f.sender.send(input({ watch: (completed: Promise<{ state: string; text: string }>) => { followed = completed } }))
    await f.sender.idle()

    expect(followed).not.toBeNull()
    f.endTurn?.({ state: 'completed', text: 'Retried 429 too.' })
    expect(await followed!).toEqual({ state: 'completed', text: 'Retried 429 too.' })
  })

  it('follows nothing when the turn was refused', async () => {
    const f = fixture()
    f.sendError = 'This conversation already has a turn running.'
    let followed = false
    f.sender.send(input({ watch: () => { followed = true } }))
    await f.sender.idle()
    expect(followed).toBe(false)
  })

  it('waits for the turn already running in that chat', async () => {
    // The ordinary case: the executor is mid-turn on the brief when the
    // requester adds to it, and `runExecutionService` refuses a busy chat.
    const f = fixture()
    f.running.add('chat-exec')
    f.sender.send(input())
    await Promise.resolve()
    expect(f.sent).toEqual([])

    f.running.delete('chat-exec')
    await f.sender.idle()
    expect(f.sent.length).toBe(1)
  })

  it('gives up on a chat that never goes idle, and says so on the row', async () => {
    const f = fixture()
    f.running.add('chat-exec')
    f.sender.send(input())
    await f.sender.idle()

    expect(f.sent).toEqual([])
    expect(f.recorded).toEqual([{ rowId: 'row-1', patch: { warning: 'revision_send_timed_out' } }])
  })

  it('records a refused turn rather than losing it', async () => {
    const f = fixture()
    f.sendError = 'This conversation already has a turn running.'
    f.sender.send(input())
    await f.sender.idle()

    expect(f.recorded).toEqual([
      { rowId: 'row-1', patch: { warning: 'revision_send_failed:This conversation already has a turn running.' } }
    ])
  })

  it('refuses a chat that no longer answers to the executor', async () => {
    const f = fixture()
    f.refusal = 'the chat is gone'
    f.sender.send(input())
    await f.sender.idle()

    expect(f.sent).toEqual([])
    expect(f.recorded).toEqual([{ rowId: 'row-1', patch: { warning: 'revision_send_failed:the chat is gone' } }])
  })

  it('sends two revisions in order, never both at once', async () => {
    const f = fixture({ holdSend: true })
    f.sender.send(input({ file: '001.md', content: 'first' }))
    f.sender.send(input({ file: '002.md', content: 'second' }))

    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(f.sent.map((entry) => entry.content)).toEqual(['first'])

    f.release?.()
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(f.sent.map((entry) => entry.content)).toEqual(['first', 'second'])
    f.release?.()
    await f.sender.idle()
  })

  /*
    `handoverService` counts the revisions a row is still owed a turn for and
    holds its task open until the last of them has ended, so every way a send
    can produce no turn has to say so. Mutation: drop any one `onNotSent` call
    and that row waits for a turn that is never coming.
  */
  it('says so when there will be no turn: refused, failed or never idle', async () => {
    const refused = fixture()
    refused.refusal = 'the chat is gone'
    const refusedReasons: string[] = []
    refused.sender.send(input({ onNotSent: (reason: string) => refusedReasons.push(reason) }))
    await refused.sender.idle()
    expect(refusedReasons).toEqual(['the chat is gone'])

    const failed = fixture()
    failed.sendError = 'This conversation already has a turn running.'
    const failedReasons: string[] = []
    failed.sender.send(input({ onNotSent: (reason: string) => failedReasons.push(reason) }))
    await failed.sender.idle()
    expect(failedReasons).toEqual(['This conversation already has a turn running.'])

    const busy = fixture()
    busy.running.add('chat-exec')
    const busyReasons: string[] = []
    busy.sender.send(input({ onNotSent: (reason: string) => busyReasons.push(reason) }))
    await busy.sender.idle()
    expect(busyReasons).toEqual(['revision_send_timed_out'])
  })

  it('says nothing of the sort when the turn was accepted', async () => {
    // The turn is the caller's to follow from here; `watch` is what carries it.
    const f = fixture()
    let notSent = false
    f.sender.send(input({ onNotSent: () => { notSent = true } }))
    await f.sender.idle()
    expect(notSent).toBe(false)
  })

  it('never throws at the scan that called it', () => {
    const f = fixture()
    f.sendError = 'boom'
    expect(() => f.sender.send(input())).not.toThrow()
  })
})
