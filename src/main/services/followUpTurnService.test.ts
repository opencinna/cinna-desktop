import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createTestDatabase, type TestDatabase } from '../db/testSupport/nodeSqlite'
import type { FollowUpRequest } from '../agents/drivers/driver'
import type { RunAgentTurnResult, TurnIO } from './a2aStreamingService'
import type { RunWatchMessage } from '../../shared/runWatch'
import type { RunHandle } from './runExecutionService'

/**
 * Follow-up turns, opened and saved against a real database: a turn the
 * agent started on its own becomes an adopted run of the chat — an assistant
 * row with no user row, live events, the Inbox for its asks, the sidebar's
 * unread result — and it waits for a busy chat and refuses a chat that is no
 * longer the agent's. The driver half is `acpDriver.test.ts`'s.
 */

const holder = vi.hoisted(() => ({ current: null as TestDatabase | null }))

vi.mock('../db/client', () => ({
  getDb: () => {
    if (!holder.current) throw new Error('test database not initialised')
    return holder.current.db
  },
  getRawSqlite: () => {
    if (!holder.current) throw new Error('test database not initialised')
    return holder.current.sqlite
  }
}))
vi.mock('../auth/scope', () => ({
  getSettingsScopeUserId: () => '__default__',
  getProfileScopeUserId: () => '__default__',
  getAgentLookupScope: () => ['__default__']
}))
vi.mock('../index', () => ({ getMainWindow: () => null }))
vi.mock('./cinnaApiService', () => ({ getCinnaServerUrl: () => null, cinnaApiService: {} }))
vi.mock('./syncService', () => ({ syncService: { markDirty: () => undefined } }))
vi.mock('./chatTitleService', () => ({ chatTitleService: { autoGenerateForFirstMessage: async () => undefined } }))
vi.mock('../logger/logger', () => ({
  createLogger: () => ({ debug: () => {}, info: () => {}, warn: () => {}, error: () => {} })
}))
vi.mock('./agentService', () => ({ agentService: { findAgent: () => null, listMerged: () => [] } }))
vi.mock('../agents/drivers', () => ({ driverFor: () => { throw new Error('no driver in this test') } }))

const { followUpTurnService, followUpTimings } = await import('./followUpTurnService')
const { a2aStreamingService } = await import('./a2aStreamingService')
const { chatRepo } = await import('../db/chats')
const { chatRunResultRepo } = await import('../db/chatRunResults')
const { chatAgentCursorRepo } = await import('../db/chatAgentCursors')
const { chatOnDemandAgentRepo } = await import('../db/chatOnDemandAgent')
const { inflightTurnRepo } = await import('../db/inflightTurns')
const { taskInputRequestRepo } = await import('../db/taskInputRequests')
const { liveRunHub } = await import('./liveRunHub')
const { activeRunsByChat } = await import('./runExecutionState')
const { runExecutionService } = await import('./runExecutionService')
const { taskRunnersByChat } = await import('./taskRunnerState')

const USER = '__default__'
const AGENT = 'folder:pineapple'
const OTHER = 'folder:mango'
const savedTimings = { ...followUpTimings }

let chatId = ''

beforeEach(() => {
  holder.current = createTestDatabase()
  for (const id of [AGENT, OTHER]) {
    holder.current.raw.prepare("INSERT INTO agents (id, user_id, name, protocol, source, created_at) VALUES (?, ?, 'Agent', 'acp', 'folder', 0)").run(id, USER)
  }
  chatId = chatRepo.create(USER).id
  holder.current.raw.prepare('UPDATE chats SET agent_id = ? WHERE id = ?').run(AGENT, chatId)
})

afterEach(() => {
  Object.assign(followUpTimings, savedTimings)
  activeRunsByChat.clear()
  taskRunnersByChat.clear()
  holder.current?.close()
  holder.current = null
})

function deferred<T = void>(): { promise: Promise<T>; resolve(value: T): void } {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((yes) => { resolve = yes })
  return { promise, resolve }
}

const said = (text: string): RunAgentTurnResult => ({ text, parts: [{ kind: 'text', text }], notices: [] })

interface FakeRequest extends FollowUpRequest {
  abandoned: string[]
  /** Whether each abandon asked to keep the session listened to. */
  keptListening: boolean[]
  runs: number
  wantedNow: boolean
}

function request(body: (io: TurnIO) => Promise<RunAgentTurnResult>, overrides: Partial<FollowUpRequest> = {}): FakeRequest {
  const fake: FakeRequest = {
    chatId,
    agentId: AGENT,
    driverId: 'acp',
    scope: { profileUserId: USER, settingsUserId: USER },
    abandoned: [],
    keptListening: [],
    runs: 0,
    wantedNow: true,
    run: (io) => {
      fake.runs++
      fake.wantedNow = false
      return body(io)
    },
    wanted: () => fake.wantedNow,
    abandon: (reason, options) => {
      fake.abandoned.push(reason)
      fake.keptListening.push(options?.keepListening === true)
      fake.wantedNow = false
    },
    ...overrides
  }
  return fake
}

function watch(): RunWatchMessage[] {
  const seen: RunWatchMessage[] = []
  liveRunHub.watch(USER, chatId, (message) => { seen.push(message) })
  return seen
}

const rows = () => chatRepo.listMessages(chatId).map((row) => ({ role: row.role, content: row.content, sourceAgentId: row.sourceAgentId }))

describe('a follow-up turn', () => {
  it('is saved as an assistant turn with no user row, streamed live, and left unread in the sidebar', async () => {
    const seen = watch()
    let runningDuringTurn = false
    const fake = request(async (io) => {
      runningDuringTurn = runExecutionService.isRunning(chatId)
      io.onEvent({ type: 'delta', kind: 'text', text: 'Merged.' })
      return said('Merged.')
    })

    await followUpTurnService.open(fake)

    expect(fake.runs).toBe(1)
    expect(runningDuringTurn).toBe(true)
    expect(rows()).toEqual([{ role: 'assistant', content: 'Merged.', sourceAgentId: AGENT }])
    expect(seen.some((m) => m.type === 'event' && m.event.type === 'delta' && m.event.text === 'Merged.')).toBe(true)
    expect(seen.some((m) => m.type === 'event' && m.event.type === 'done')).toBe(true)
    expect(chatRunResultRepo.list(USER).get(chatId)).toMatchObject({ status: 'completed', unread: true })
    expect(chatAgentCursorRepo.get(chatId, AGENT)?.lastMessageId).toBe(chatRepo.listMessages(chatId)[0].id)
    expect(inflightTurnRepo.list()).toEqual([])
    expect(activeRunsByChat.has(chatId)).toBe(false)
    expect(fake.abandoned).toEqual([])
  })

  it('keeps what it streamed above the error when it fails, and records the failure', async () => {
    await followUpTurnService.open(request(async () => ({ ...said('Half.'), error: { message: 'The agent’s process ended.', raw: 'exit 1' } })))
    const saved = rows()
    expect(saved.map((row) => row.role)).toEqual(['assistant', 'error'])
    expect(saved[0].content).toBe('Half.')
    expect(JSON.parse(saved[1].content)).toMatchObject({ short: 'The agent’s process ended.' })
    expect(chatRunResultRepo.list(USER).get(chatId)).toMatchObject({ status: 'failed', unread: true })
  })

  it('records an ask it parks in the Inbox, and expires it when the turn ends', async () => {
    const parked = deferred()
    const answered = deferred()
    const running = followUpTurnService.open(request(async (io) => {
      io.onEvent({ type: 'needs_input', requestId: 'acp-permission-1', request: { kind: 'permission', action: 'gh pr merge', resources: [] }, resume: 'reply' })
      parked.resolve()
      await answered.promise
      return said('Merged.')
    }))
    await parked.promise

    const open = taskInputRequestRepo.listOpenForChat(chatId)
    expect(open.map((row) => [row.id, row.agentId, row.resume])).toEqual([['acp-permission-1', AGENT, 'reply']])

    answered.resolve()
    await running
    expect(taskInputRequestRepo.listOpenForChat(chatId)).toEqual([])
  })

  it('is stopped by the chat’s Stop, and records the stop', async () => {
    const started = deferred()
    let aborted = false
    const running = followUpTurnService.open(request(async (io) => {
      started.resolve()
      await new Promise<void>((resolve) => io.signal.addEventListener('abort', () => resolve(), { once: true }))
      aborted = true
      return { ...said('Stopped here.'), taskState: 'canceled', stopReason: 'canceled' }
    }))
    await started.promise

    runExecutionService.cancelChat(USER, chatId)
    await running
    expect(aborted).toBe(true)
    expect(rows().map((row) => row.content)).toEqual(['Stopped here.'])
    expect(chatRunResultRepo.list(USER).get(chatId)).toMatchObject({ status: 'canceled', unread: false })
  })

  it('is saved by the quit flush while it runs, and its in-flight marker stays for the next launch', async () => {
    const started = deferred()
    const finish = deferred()
    const running = followUpTurnService.open(request(async (io) => {
      io.registerSnapshot?.(() => ({ parts: [{ kind: 'text', text: 'Half a reply' }], notices: [] }))
      started.resolve()
      await finish.promise
      return said('Half a reply')
    }))
    await started.promise

    a2aStreamingService.saveInFlight()
    expect(rows().map((row) => [row.role, row.content])).toEqual([['assistant', 'Half a reply']])
    expect(inflightTurnRepo.list()).toMatchObject([{ chatId, agentId: AGENT, userMessageId: null, driver: 'acp' }])

    finish.resolve()
    await running
    // Nothing saved twice.
    expect(rows()).toHaveLength(1)
  })

  it('waits for the chat’s run to end, however long, then opens', async () => {
    // The poll budget is for a task runner or a handoff; a run is awaited.
    Object.assign(followUpTimings, { pollMs: 10, maxWaitMs: 20 })
    const busy = deferred<unknown>()
    activeRunsByChat.set(chatId, { completed: busy.promise } as unknown as RunHandle)
    const fake = request(async () => said('Merged.'))
    const opening = followUpTurnService.open(fake)

    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(fake.runs).toBe(0)

    activeRunsByChat.delete(chatId)
    busy.resolve(undefined)
    await opening
    expect(fake.runs).toBe(1)
    expect(rows().map((row) => row.content)).toEqual(['Merged.'])
  })

  it('opens nothing once a turn of the same session took what was held', async () => {
    const busy = deferred<unknown>()
    activeRunsByChat.set(chatId, { completed: busy.promise } as unknown as RunHandle)
    const fake = request(async () => said('Merged.'))
    const opening = followUpTurnService.open(fake)

    fake.wantedNow = false
    activeRunsByChat.delete(chatId)
    busy.resolve(undefined)
    await opening
    expect(fake.runs).toBe(0)
    expect(fake.abandoned).toEqual([])
    expect(rows()).toEqual([])
  })

  it('polls a chat a task runner holds, and gives up after the wait', async () => {
    Object.assign(followUpTimings, { pollMs: 10, maxWaitMs: 60 })
    taskRunnersByChat.set(chatId, { userId: USER, taskId: 'task-1' } as never)
    const fake = request(async () => said('Merged.'))

    await followUpTurnService.open(fake)
    expect(fake.runs).toBe(0)
    expect(fake.abandoned).toHaveLength(1)
    expect(fake.abandoned[0]).toContain('the chat stayed busy')
    // The chat still answers to the agent: only this traffic is dropped.
    expect(fake.keptListening).toEqual([true])
  })

  it('opens once the task runner lets go', async () => {
    Object.assign(followUpTimings, { pollMs: 10 })
    taskRunnersByChat.set(chatId, { userId: USER, taskId: 'task-1' } as never)
    const fake = request(async () => said('Merged.'))
    const opening = followUpTurnService.open(fake)
    await new Promise((resolve) => setTimeout(resolve, 40))
    expect(fake.runs).toBe(0)

    taskRunnersByChat.delete(chatId)
    await opening
    expect(fake.runs).toBe(1)
  })

  it.each([
    ['the chat is in the trash', () => { chatRepo.softDelete(USER, chatId) }],
    ['the chat no longer answers to this agent', () => { holder.current!.raw.prepare('UPDATE chats SET agent_id = ? WHERE id = ?').run(OTHER, chatId) }],
    ['the chat is gone', () => { chatRepo.permanentDelete(USER, chatId) }]
  ])('is refused when %s', async (reason, change) => {
    change()
    const fake = request(async () => said('Merged.'))
    await followUpTurnService.open(fake)
    expect(fake.runs).toBe(0)
    expect(fake.abandoned).toEqual([reason])
    expect(chatRunResultRepo.list(USER).get(chatId)).toBeUndefined()
  })

  it('is refused when the chat changed hands while it waited', async () => {
    const busy = deferred<unknown>()
    activeRunsByChat.set(chatId, { completed: busy.promise } as unknown as RunHandle)
    const fake = request(async () => said('Merged.'))
    const opening = followUpTurnService.open(fake)

    chatRepo.softDelete(USER, chatId)
    activeRunsByChat.delete(chatId)
    busy.resolve(undefined)
    await opening
    expect(fake.runs).toBe(0)
    expect(fake.abandoned).toEqual(['the chat is in the trash'])
    expect(fake.keptListening).toEqual([false])
  })

  it('opens for an agent attached to a chat the user routes, and not for one that is only named', async () => {
    holder.current!.raw.prepare("UPDATE chats SET agent_id = NULL, router = 'human' WHERE id = ?").run(chatId)
    chatOnDemandAgentRepo.add(chatId, OTHER)

    const attached = request(async () => said('From mango.'), { agentId: OTHER })
    await followUpTurnService.open(attached)
    expect(attached.runs).toBe(1)

    const detached = request(async () => said('From pineapple.'))
    await followUpTurnService.open(detached)
    expect(detached.runs).toBe(0)
    expect(detached.abandoned).toEqual(['the chat no longer answers to this agent'])
    expect(detached.keptListening).toEqual([false])
  })

  it('runs two follow-ups of one chat one after the other, as two runs', async () => {
    const first = deferred()
    const order: string[] = []
    const one = followUpTurnService.open(request(async () => {
      order.push('first:start')
      await first.promise
      order.push('first:end')
      return said('First.')
    }))
    const two = followUpTurnService.open(request(async () => {
      order.push('second:start')
      return said('Second.')
    }))
    await new Promise((resolve) => setTimeout(resolve, 20))
    first.resolve()
    await Promise.all([one, two])

    expect(order).toEqual(['first:start', 'first:end', 'second:start'])
    expect(rows().map((row) => row.content)).toEqual(['First.', 'Second.'])
  })
})
