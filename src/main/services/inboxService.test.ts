import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createTestDatabase, type TestDatabase } from '../db/testSupport/nodeSqlite'
import { ASK_NO_LONGER_WAITING, type InboxAnswerResult, type InboxEntry } from '../../shared/inbox'
import type { AgentDriver } from '../agents/drivers/driver'
import type { AgentRow } from '../db/agents'
import type { RequestResolution } from '../../shared/localAgentRequests'
import type { RunEvent } from '../../shared/runEvents'
import type { RemoteTaskAdapter } from '../tasks/adapters/adapter'
import { RemoteTaskError } from '../tasks/adapters/adapter'
import { createNullAdapter } from '../tasks/adapters/nullAdapter'

/**
 * `inboxService` against a real database with the real migrations applied — the
 * arrangement `taskService.test.ts` uses, for the same reason: what is under
 * test is a set of rules about rows (which asks get one, when it settles, whose
 * they are), and a mocked repo would only assert that the service calls a mock.
 *
 * The one thing genuinely mocked is `askDelivery`, because it is the boundary
 * to the live driver: it reaches into the in-memory pending-request registry
 * and, for a permission, writes a grant into an agent folder on disk. Its own
 * behaviour is covered end-to-end through the real folder driver in
 * `ipc/agent_a2a.answerRequest.test.ts`; what matters here is what the inbox
 * does with each answer it can come back with.
 */

const holder = vi.hoisted(() => ({
  current: null as TestDatabase | null,
  adapters: [] as RemoteTaskAdapter[],
  deliver: null as ((requestId: string) => InboxAnswerResult) | null
}))

vi.mock('../tasks/adapters', () => ({
  adapterFor: (id: string) => holder.adapters.find((a) => a.id === id) ?? createNullAdapter(id)
}))

vi.mock('../logger/logger', () => ({
  createLogger: () => ({ debug: () => {}, info: () => {}, warn: () => {}, error: () => {} })
}))
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
vi.mock('../db/sync', () => ({ syncRepo: { getState: () => null } }))

const deliverAnswer = vi.fn(
  (_userId: string, requestId: string): InboxAnswerResult =>
    holder.deliver?.(requestId) ?? { ok: true }
)
vi.mock('./askDelivery', () => ({
  deliverAnswer: (...args: [string, string, unknown]) =>
    deliverAnswer(args[0] as string, args[1] as string),
  deliverAnswerWithCommit: (userId: string, requestId: string, resolution: RequestResolution, commit: (value: RequestResolution) => void, validate: () => void) => {
    const result = deliverAnswer(userId, requestId)
    if (result.ok) { validate(); commit(resolution) }
    return result
  }
}))

const toolRun = vi.hoisted(() => vi.fn<AgentDriver['run']>(async () => ({ text: 'Done', parts: [], notices: [] })))
vi.mock('../agents/drivers', () => ({ driverFor: () => ({ run: toolRun }) }))

const runStart = vi.hoisted(() => vi.fn())
const runBusy = vi.hoisted(() => vi.fn(() => false))
vi.mock('./runExecutionService', () => ({
  runExecutionService: { start: runStart, isRunning: runBusy }
}))
vi.mock('./agentService', () => ({ agentService: { findAgent: () => ({ row: {}, userId: '__default__' }) } }))
vi.mock('../mcp/manager', () => ({ mcpManager: {} }))
vi.mock('./fileStore', () => ({ attachmentToMediaPart: async () => null }))
vi.mock('../auth/scope', () => ({ getSettingsScopeUserId: () => '__default__' }))

const { inboxService } = await import('./inboxService')
const { taskService } = await import('./taskService')
const { taskInputRequestRepo } = await import('../db/taskInputRequests')
const { jobsRepo, jobRunsRepo } = await import('../db/jobs')

const USER = '__default__'
const CHAT = 'chat-1'
const AGENT = 'folder:alpha'

/**
 * What is waiting, without the completeness half.
 *
 * `list` answers an {@link InboxSnapshot} — the entries plus the services this
 * read could not reach — and most of what is tested here is which rows exist,
 * whose they are and when they settle. The tests that are *about* the second
 * half call `inboxService.list` directly and assert `unreadable`.
 */
async function listEntries(userId: string): Promise<InboxEntry[]> {
  return (await inboxService.list(userId)).entries
}

const permission: Extract<RunEvent, { type: 'needs_input' }> = {
  type: 'needs_input',
  requestId: 'per_1',
  request: { kind: 'permission', action: 'bash', resources: ['rm -rf build'] },
  resume: 'reply'
}

function ctx(overrides: { chatId?: string; agentId?: string | null; turnId?: string; rootRunId?: string; completionOwner?: 'turn' | 'runner' } = {}) {
  return { userId: USER, chatId: CHAT, agentId: AGENT, ...overrides }
}

/** A chat row, because `tasks.chat_id` is a real foreign key and tests run with FKs on. */
function makeChat(id: string): void {
  holder.current?.raw.exec(
    `INSERT INTO chats (id, user_id, title, created_at, updated_at)
     VALUES ('${id}', '${USER}', 'Run', 0, 0)`
  )
}

/**
 * A task in the state a job run leaves it in: started, running in its chat, and
 * **carrying its run's id**.
 *
 * `jobRunId` is what decides who ends the task, so it is not decoration here.
 * A task a job run owns is finished by `jobService.reportRunCompletion`, which
 * knows the outcome a `done` event cannot — a stop, a refusal, a budget ceiling
 * — so `endTurn` leaves it in `in_progress` for that write to find. A task a
 * *chat* made for itself has no such hook, and `endTurn` is the only thing that
 * can end it. `makeChatTask` is the other shape.
 */
function makeTask(chatId: string | null = CHAT) {
  const job = jobsRepo.create(USER, { title: 'Ship the thing', prompt: 'Ship by Friday', type: 'local' })
  const run = jobRunsRepo.create({ userId: USER, jobId: job.id, type: 'local', localChatId: chatId, status: 'running' })
  const task = taskService.create(USER, {
    title: 'Ship the thing',
    goal: 'Ship the thing by Friday',
    chatId,
    jobId: job.id,
    jobRunId: run.id
  })
  jobRunsRepo.setTaskId(run.id, task.id)
  return taskService.start(USER, task.id, { chatId })
}

/** The shape `inboxService` itself mints: a chat's own task, with no job run. */
function makeChatTask(chatId: string | null = CHAT) {
  const task = taskService.create(USER, {
    title: 'Tidy the build',
    goal: 'Tidy the build directory',
    chatId
  })
  return taskService.start(USER, task.id, { chatId })
}

beforeEach(() => {
  holder.current = createTestDatabase()
  toolRun.mockClear()
  runBusy.mockReturnValue(false)
  runStart.mockReset().mockImplementation((scope, payload, options) => {
    options.onAccepted({ userId: scope.profileUserId, chatId: payload.chatId, agentId: payload.addressedAgentId })
    return { accepted: Promise.resolve(), completed: Promise.resolve() }
  })
  holder.deliver = null
  holder.adapters = []
  deliverAnswer.mockClear()
  makeChat(CHAT)
})

it('finishes a new desktop conversation even when its task retains an older job attempt', () => {
  const task = makeTask(null)
  taskService.beginDesktopChat(USER, task.id, CHAT, { kind: 'agent', agentId: AGENT, name: 'Alpha' })
  inboxService.recordRunEvent(ctx(), { type: 'done', stopReason: 'end_turn' })
  expect(taskService.getById(USER, task.id).status).toBe('completed')
  expect(jobRunsRepo.getById(USER, task.jobRunId!)?.status).toBe('succeeded')
  expect(jobRunsRepo.getByLocalChatId(CHAT)).toBeUndefined()
})

afterEach(() => {
  holder.current?.close()
  holder.current = null
})

describe('recording an ask', () => {
  it('opens a row and blocks the task when a run parks', async () => {
    const task = makeTask()
    inboxService.recordRunEvent(ctx(), permission)

    const entries = (await listEntries(USER))
    expect(entries).toHaveLength(1)
    expect(entries[0]).toMatchObject({
      requestId: 'per_1',
      source: 'local',
      taskId: task.id,
      taskTitle: 'Ship the thing',
      chatId: CHAT,
      agentId: AGENT,
      resume: 'reply'
    })
    expect(entries[0].request).toEqual(permission.request)
    expect(taskService.getById(USER, task.id).status).toBe('blocked')
  })

  it('records a next-message ask and keeps the task blocked after the turn ends', async () => {
    const task = makeTask()
    inboxService.recordRunEvent(ctx({ turnId: 'turn-1' }), { ...permission, resume: 'next_message' })
    inboxService.recordRunEvent(ctx(), { type: 'done', stopReason: 'end_turn' })
    const entries = await listEntries(USER)
    expect(entries).toHaveLength(1)
    expect(entries[0]).toMatchObject({ taskId: task.id, resume: 'next_message' })
    expect(entries[0].requestId).not.toBe(permission.requestId)
    expect(taskService.getById(USER, task.id).status).toBe('blocked')
  })

  describe('an ask in a chat that has no task', () => {
    /**
     * **The phase's exit criterion, and the case it was failing on.** Only a
     * job run created a task, so an ask raised in a chat the user opened by
     * hand was answerable in the transcript and in no list at all — which is
     * the commonest way a person meets an agent here.
     */
    it('makes one, so the ask is in the inbox', async () => {
      holder.current?.raw.exec(
        `INSERT INTO chats (id, user_id, title, created_at, updated_at)
         VALUES ('chat-2', '${USER}', 'Tidy the build', 0, 0)`
      )
      holder.current?.raw.exec(
        `INSERT INTO messages (id, chat_id, role, content, sort_order, created_at)
         VALUES ('m1', 'chat-2', 'user', 'Please tidy up the build directory', 1, 0)`
      )

      inboxService.recordRunEvent(ctx({ chatId: 'chat-2' }), permission)

      const entries = (await listEntries(USER))
      expect(entries).toHaveLength(1)
      expect(entries[0].requestId).toBe('per_1')
      const task = taskService.getById(USER, entries[0].taskId)
      expect(task.chatId).toBe('chat-2')
      // Created *started*: `new → blocked` is not in the transition table, so a
      // task left at `new` would sit there while `applyRunState` no-ops, and
      // the row would hang off a task that never says it is waiting.
      expect(task.status).toBe('blocked')
      // The first thing the user said, not the chat's forty-character title:
      // `goal` is the original ask and is immutable once written.
      expect(task.goal).toBe('Please tidy up the build directory')
      expect(task.title).toBe('Tidy the build')
      expect(task.assignee).toEqual({ agentId: AGENT, name: null, kind: 'agent' })
      // It is not a job's task, which is the half of this decision the task
      // page has to answer for — a task with no job above it.
      expect(task.jobId).toBeNull()
      expect(task.jobRunId).toBeNull()
    })

    it('makes exactly one, however many asks the chat raises', async () => {
      holder.current?.raw.exec(
        `INSERT INTO chats (id, user_id, title, created_at, updated_at)
         VALUES ('chat-2', '${USER}', 'Tidy the build', 0, 0)`
      )
      inboxService.recordRunEvent(ctx({ chatId: 'chat-2' }), permission)
      inboxService.recordRunEvent(ctx({ chatId: 'chat-2' }), {
        ...permission,
        requestId: 'per_2'
      })

      const taskIds = new Set((await listEntries(USER)).map((e) => e.taskId))
      expect(taskIds.size).toBe(1)
      expect(taskService.list(USER)).toHaveLength(1)
    })

    /**
     * A behaviour pin, not a branch pin — worth saying out loud. Deleting
     * `taskForChat`'s chat-existence guard does not fail this: the create
     * would throw on the missing row instead, `recordRunEvent` would catch it,
     * and the outcome the test can see is identical. What the guard buys is a
     * debug line for something that is not a fault, in place of a warning that
     * reads like one.
     */
    it('creates a task for a hand-opened chat whose next message must answer an ask', async () => {
      makeChat('chat-2')
      inboxService.recordRunEvent(ctx({ chatId: 'chat-2' }), { ...permission, resume: 'next_message' })
      expect(taskService.list(USER)).toHaveLength(1)
      expect(await listEntries(USER)).toHaveLength(1)
      expect(taskService.list(USER)[0].status).toBe('blocked')
    })

    it('makes none for a parked ask that named no agent, which nothing could answer', () => {
      holder.current?.raw.exec(
        `INSERT INTO chats (id, user_id, title, created_at, updated_at)
         VALUES ('chat-2', '${USER}', 'Tidy the build', 0, 0)`
      )

      inboxService.recordRunEvent(ctx({ chatId: 'chat-2', agentId: null }), permission)

      expect(taskService.list(USER)).toEqual([])
    })

    it('records nothing when the chat itself is gone, and does not throw', async () => {
      expect(() =>
        inboxService.recordRunEvent(ctx({ chatId: 'chat-gone' }), permission)
      ).not.toThrow()
      expect((await listEntries(USER))).toEqual([])
      expect(taskInputRequestRepo.getById('per_1')).toBeUndefined()
      expect(taskService.list(USER)).toEqual([])
    })
  })

  it('attributes a nested agent’s ask to the agent that raised it', async () => {
    // The orchestrator's own turn is the model's, so the outer context names no
    // agent; only the `child` wrapper knows who asked.
    makeTask()
    inboxService.recordRunEvent(ctx({ agentId: null }), {
      type: 'child',
      toolCallId: 'call-1',
      agentId: 'folder:beta',
      event: permission
    })
    expect((await listEntries(USER))[0].agentId).toBe('folder:beta')
  })

  it('drops a parked ask nobody can be said to have raised', async () => {
    makeTask()
    inboxService.recordRunEvent(ctx({ agentId: null }), permission)
    expect((await listEntries(USER))).toEqual([])
  })

  it('never throws into the stream it is observing', () => {
    // The tap runs inside the turn's event pump, ahead of `port.postMessage`:
    // a throw here would fail the *turn*, so the ask would never reach the
    // renderer and the agent would sit parked for the whole park timeout.
    makeTask()
    holder.current?.close()
    holder.current = null
    expect(() => inboxService.recordRunEvent(ctx(), permission)).not.toThrow()
  })

  it('supersedes an ask re-raised under the same id', async () => {
    const task = makeTask()
    inboxService.recordRunEvent(ctx(), permission)
    inboxService.closeAsk(ctx(), 'per_1', { kind: 'permission', reply: 'once' })
    inboxService.recordRunEvent(ctx(), permission)

    // A driver that re-asks under an id it has used before (a reconnect
    // replaying the ask) is describing the same ask again; the answered row
    // must not be what the user is left looking at.
    expect((await listEntries(USER))).toHaveLength(1)
    expect(taskService.getById(USER, task.id).status).toBe('blocked')
  })
})

describe('settling an ask from the stream', () => {
  it('closes the row and returns the task to in_progress', async () => {
    const task = makeTask()
    inboxService.recordRunEvent(ctx(), permission)
    inboxService.recordRunEvent(ctx(), {
      type: 'input_resolved',
      requestId: 'per_1',
      resolution: { kind: 'permission', reply: 'once' }
    })

    expect((await listEntries(USER))).toEqual([])
    expect(taskInputRequestRepo.getById('per_1')?.status).toBe('answered')
    expect(taskService.getById(USER, task.id).status).toBe('in_progress')
  })

  it('records a denial as declined rather than answered', () => {
    makeTask()
    inboxService.recordRunEvent(ctx(), permission)
    inboxService.closeAsk(ctx(), 'per_1', { kind: 'permission', reply: 'reject' })
    expect(taskInputRequestRepo.getById('per_1')?.status).toBe('rejected')
  })

  it('records an ask the registry gave up on as expired', () => {
    // `{kind: 'rejected'}` is how the park timeout and a turn ending underneath
    // settle an ask. Nobody decided anything, so it is not a decision.
    makeTask()
    inboxService.recordRunEvent(ctx(), permission)
    inboxService.closeAsk(ctx(), 'per_1', { kind: 'rejected' })
    expect(taskInputRequestRepo.getById('per_1')?.status).toBe('expired')
  })

  it('does nothing for an ask it never recorded', () => {
    const task = makeTask()
    expect(() =>
      inboxService.closeAsk(ctx(), 'que_unknown', { kind: 'question', answers: [['yes']] })
    ).not.toThrow()
    expect(taskService.getById(USER, task.id).status).toBe('in_progress')
  })
})

describe('a turn that ends while it is still parked', () => {
  const done: RunEvent = { type: 'done', stopReason: 'canceled' }

  it('expires the ask and takes the task off blocked', async () => {
    // The ACP driver closes the turn *before* releasing its parks, and
    // `input_resolved` is gated on the turn being open — so a Stop, the turn
    // ceiling and a crash all settle the registry in silence. Without this the
    // row sits open until the next restart: an inbox entry whose only possible
    // outcome is "no longer waiting for an answer".
    const task = makeTask()
    inboxService.recordRunEvent(ctx(), permission)
    inboxService.recordRunEvent(ctx(), done)

    expect(taskInputRequestRepo.getById('per_1')?.status).toBe('expired')
    expect((await listEntries(USER))).toEqual([])
    // Back to in_progress, which is where `jobService.reportRunCompletion` has
    // to find it a beat later to write the outcome the run actually had.
    expect(taskService.getById(USER, task.id).status).toBe('in_progress')
  })

  it('does the same when the turn ends in an error', () => {
    const task = makeTask()
    inboxService.recordRunEvent(ctx(), permission)
    inboxService.recordRunEvent(ctx(), { type: 'error', error: 'the agent died' })

    expect(taskInputRequestRepo.getById('per_1')?.status).toBe('expired')
    expect(taskService.getById(USER, task.id).status).toBe('in_progress')
  })

  it('leaves an ask alone when a nested agent finishes', async () => {
    // A coordinator can have several agents in flight in one chat, and one of
    // them finishing says nothing about what another is parked on.
    makeTask()
    inboxService.recordRunEvent(ctx(), permission)
    inboxService.recordRunEvent(ctx({ agentId: null }), {
      type: 'child',
      toolCallId: 'call-1',
      agentId: 'folder:beta',
      event: done
    })

    expect((await listEntries(USER))).toHaveLength(1)
  })

  it('leaves a task blocked by an ask the next message answers', () => {
    // An A2A ask *is* the turn ending, so `done` says nothing about whether the
    // user still owes an answer. Nothing was expired, so nothing is unblocked
    // here — `reportRunCompletion` is what writes the run's own outcome.
    const task = makeTask()
    inboxService.recordRunEvent(ctx(), { ...permission, resume: 'next_message' })
    inboxService.recordRunEvent(ctx(), { type: 'done', stopReason: 'end_turn' })

    expect(taskService.getById(USER, task.id).status).toBe('blocked')
  })

  it('leaves an answered turn’s task where the answer left it', () => {
    const task = makeTask()
    inboxService.recordRunEvent(ctx(), permission)
    inboxService.closeAsk(ctx(), 'per_1', { kind: 'permission', reply: 'once' })
    inboxService.recordRunEvent(ctx(), { type: 'done', stopReason: 'end_turn' })

    expect(taskInputRequestRepo.getById('per_1')?.status).toBe('answered')
    expect(taskService.getById(USER, task.id).status).toBe('in_progress')
  })
})

/**
 * **Who ends a task nobody else will.**
 *
 * `jobService.reportRunCompletion` is keyed on
 * `jobRunsRepo.getByLocalChatId(chatId)`, which answers nothing for a chat the
 * user opened by hand — so a task this service minted for such a chat had no
 * finisher at all. It went `in_progress → blocked → in_progress` and stopped
 * there for the life of the profile: listed as running, holding this device's
 * claim, and **synced**, so the user's second device offered *Take over* on it
 * for ever (`CLAIM_MATTERS` includes `in_progress`). One per hand-opened chat
 * that ever raised an ask.
 */
describe('a turn ending in a chat that owns its own task', () => {
  it('completes the task, because for this chat the turn is the work', () => {
    const task = makeChatTask()
    inboxService.recordRunEvent(ctx(), permission)
    inboxService.closeAsk(ctx(), 'per_1', { kind: 'permission', reply: 'once' })
    inboxService.recordRunEvent(ctx(), { type: 'done', stopReason: 'end_turn' })

    expect(taskService.getById(USER, task.id).status).toBe('completed')
  })

  it('records an error as an error', () => {
    const task = makeChatTask()
    inboxService.recordRunEvent(ctx(), permission)
    inboxService.recordRunEvent(ctx(), { type: 'error', error: 'the agent died' })

    expect(taskService.getById(USER, task.id).status).toBe('error')
  })

  it('records a stop as cancelled, not as finished work', () => {
    // A task marked `completed` because the user pressed Stop is a lie the task
    // list would keep for ever.
    const task = makeChatTask()
    inboxService.recordRunEvent(ctx(), { type: 'done', stopReason: 'canceled' })

    expect(taskService.getById(USER, task.id).status).toBe('cancelled')
  })

  it('ends it even when the turn was never parked on anything', () => {
    // The commonest shape by far: a chat whose task was minted by an earlier
    // turn's ask, and whose later turns raise none. `endTurn` used to return
    // early whenever it expired no rows.
    const task = makeChatTask()
    inboxService.recordRunEvent(ctx(), { type: 'done', stopReason: 'end_turn' })

    expect(taskService.getById(USER, task.id).status).toBe('completed')
  })

  it('is not ended by a nested agent finishing', () => {
    // A coordinator can have several agents in flight in one chat; one of them
    // finishing says nothing about whether the chat's work is done.
    const task = makeChatTask()
    inboxService.recordRunEvent(ctx({ agentId: null }), {
      type: 'child',
      toolCallId: 'call-1',
      agentId: 'folder:beta',
      event: { type: 'done', stopReason: 'end_turn' }
    })

    expect(taskService.getById(USER, task.id).status).toBe('in_progress')
  })
})

describe('the list', () => {
  it('shows the newest ask first', async () => {
    makeTask()
    inboxService.recordRunEvent(ctx(), permission)
    inboxService.recordRunEvent(ctx(), { ...permission, requestId: 'per_2' })
    // Both rows are written in the same millisecond here; the older one is aged
    // by hand so the ordering under test is the column's, not the insert order.
    holder.current?.raw.exec(
      `UPDATE task_input_requests SET created_at = created_at - 1000 WHERE id = 'per_1'`
    )

    expect((await listEntries(USER)).map((e) => e.requestId)).toEqual(['per_2', 'per_1'])
  })

  it('drops the asks of a task the user deleted', async () => {
    // `taskService.remove` is a *soft* delete, so the `ON DELETE CASCADE` on
    // `task_input_requests` never fires and the rows outlive the task. The list
    // has to exclude them itself rather than trust the foreign key.
    const task = makeTask()
    inboxService.recordRunEvent(ctx(), permission)
    taskService.remove(USER, task.id)
    expect((await listEntries(USER))).toEqual([])
  })

  it('shows nothing to another profile', async () => {
    makeTask()
    inboxService.recordRunEvent(ctx(), permission)
    expect((await listEntries('someone-else'))).toEqual([])
  })

  /**
   * A file-handover gate asks whether to *start* a task, so its task is still
   * `new` and has no chat of its own — neither of the two things the list's
   * second branch looks for (`executor: 'desktop'` **and** a status of `blocked`
   * or `in_progress`). It reaches the Inbox only through the first branch:
   * `resume: 'reply'` and a `deliveryOwner` that is not `runner`.
   *
   * Pinned because that is a coincidence of two conditions, either of which a
   * later change to either side could break — and the symptom would be a card
   * that never appears, which nothing else in the suite would notice.
   */
  it('shows a handover gate whose task has not started', async () => {
    const task = taskService.create(USER, { title: 'Add retry', goal: 'Add retry to the uploader' })
    expect(task.status).toBe('new')
    expect(task.chatId).toBeNull()

    taskInputRequestRepo.open({
      requestId: 'handover:row-1',
      taskId: task.id,
      chatId: 'gate-chat',
      agentId: null,
      deliveryOwner: 'handover',
      request: { kind: 'question', questions: [{ question: 'Run it?', multiSelect: false, options: [{ label: 'Run' }] }] },
      resume: 'reply'
    })

    const entries = await listEntries(USER)
    expect(entries).toEqual([
      expect.objectContaining({ requestId: 'handover:row-1', deliveryOwner: 'handover', agentId: null, taskId: task.id })
    ])
  })
})

describe('answering from the inbox', () => {
  it('delivers the answer, closes the row and unblocks the task', async () => {
    const task = makeTask()
    inboxService.recordRunEvent(ctx(), permission)

    const result = (await inboxService.answer(USER, 'per_1', { kind: 'permission', reply: 'once' }))

    expect(result.ok).toBe(true)
    expect(deliverAnswer).toHaveBeenCalledWith(USER, 'per_1')
    expect(taskInputRequestRepo.getById('per_1')?.status).toBe('answered')
    expect((await listEntries(USER))).toEqual([])
    expect(taskService.getById(USER, task.id).status).toBe('in_progress')
  })

  it('settles the row here rather than waiting for the stream to say so', async () => {
    // The whole point of the inbox is that it is answered when nobody is
    // watching the turn's port. If the row only closed on the `input_resolved`
    // the driver posts there, an answer given with the chat closed would leave
    // the entry sitting in the list.
    makeTask()
    inboxService.recordRunEvent(ctx(), permission)
    await inboxService.answer(USER, 'per_1', { kind: 'permission', reply: 'once' })
    expect(taskInputRequestRepo.getById('per_1')?.resolvedAt).not.toBeNull()
  })

  it('expires an ask whose driver is gone, and does not throw', async () => {
    const task = makeTask()
    inboxService.recordRunEvent(ctx(), permission)
    holder.deliver = () => ({
      ok: false,
      reason: ASK_NO_LONGER_WAITING,
      code: 'no_longer_waiting'
    })

    const result = (await inboxService.answer(USER, 'per_1', { kind: 'permission', reply: 'once' }))

    expect(result).toEqual({
      ok: false,
      reason: ASK_NO_LONGER_WAITING,
      code: 'no_longer_waiting'
    })
    // The entry stops offering a button whose only outcome is that message.
    expect(taskInputRequestRepo.getById('per_1')?.status).toBe('expired')
    expect((await listEntries(USER))).toEqual([])
    // No answerable request remains; the completion owner decides the final outcome.
    expect(taskService.getById(USER, task.id).status).toBe('in_progress')
  })

  it('keeps the ask open when the answer was merely the wrong shape', async () => {
    makeTask()
    inboxService.recordRunEvent(ctx(), permission)
    holder.deliver = () => ({ ok: false, reason: 'Malformed answer', code: 'malformed' })

    expect((await inboxService.answer(USER, 'per_1', { kind: 'rejected' })).ok).toBe(false)
    expect(taskInputRequestRepo.getById('per_1')?.status).toBe('open')
  })

  it('refuses a second answer to the same ask', async () => {
    makeTask()
    inboxService.recordRunEvent(ctx(), permission)
    await inboxService.answer(USER, 'per_1', { kind: 'permission', reply: 'once' })

    const again = (await inboxService.answer(USER, 'per_1', { kind: 'permission', reply: 'once' }))
    expect(again).toMatchObject({ ok: false, code: 'already_answered' })
    expect(deliverAnswer).toHaveBeenCalledTimes(1)
  })

  it('does not call an expired ask answered', async () => {
    // Mutation: fold the `expired` arm back into `row.status !== 'open'` and
    // this fails — an ask the turn abandoned comes back "already answered",
    // which over `rm -rf build` tells the user somebody allowed it. Nobody
    // decided anything; the address simply died.
    makeTask()
    inboxService.recordRunEvent(ctx(), permission)
    // The turn ends under the parked ask — a Stop, the ceiling, a crash.
    inboxService.recordRunEvent(ctx(), { type: 'done', stopReason: 'canceled' })
    expect(taskInputRequestRepo.getById('per_1')?.status).toBe('expired')

    const result = (await inboxService.answer(USER, 'per_1', { kind: 'permission', reply: 'once' }))

    expect(result).toMatchObject({ ok: false, code: 'no_longer_waiting' })
    expect(result.reason).toBe(ASK_NO_LONGER_WAITING)
    expect(deliverAnswer).not.toHaveBeenCalled()
  })

  it('refuses an ask that belongs to another profile, without delivering it', async () => {
    makeTask()
    inboxService.recordRunEvent(ctx(), permission)

    const result = (await inboxService.answer('someone-else', 'per_1', {
      kind: 'permission',
      reply: 'once'
    }))

    expect(result).toMatchObject({ ok: false, code: 'no_longer_waiting' })
    expect(deliverAnswer).not.toHaveBeenCalled()
    expect(taskInputRequestRepo.getById('per_1')?.status).toBe('open')
  })

  it('refuses an ask nobody recorded', async () => {
    expect((await inboxService.answer(USER, 'per_missing', { kind: 'permission', reply: 'once' }))).toMatchObject({
      ok: false,
      code: 'no_longer_waiting'
    })
    expect(deliverAnswer).not.toHaveBeenCalled()
  })
})

describe('the boot sweep', () => {
  it('expires every open ask, because no driver process survived the restart', async () => {
    makeTask()
    inboxService.recordRunEvent(ctx(), permission)

    expect(taskInputRequestRepo.expireOpen()).toBe(1)
    expect(taskInputRequestRepo.getById('per_1')?.status).toBe('expired')
    expect((await listEntries(USER))).toEqual([])
    // Idempotent: a second boot finds nothing left to expire.
    expect(taskInputRequestRepo.expireOpen()).toBe(0)
  })
})

describe('remote inbox', () => {
  function remote(id = 'service', remoteId = 'task-there') {
    const adapter: RemoteTaskAdapter = {
      ...createNullAdapter(id),
      capabilities: () => ({ ...createNullAdapter(id).capabilities(), asks: true }),
      availability: async () => ({ ready: true }),
      listOpenAsks: vi.fn(async () => [{
        id: 'same-ask', request: { kind: 'question' as const, questions: [{ question: 'Ship?', header: 'Ship', options: [], multiSelect: false }] },
        createdAt: new Date('2026-09-11T12:00:00Z')
      }]),
      answerAsk: vi.fn(async () => ({ delivered: true }))
    }
    holder.adapters.push(adapter)
    const task = taskService.create(USER, { title: id, goal: 'Remote work', executor: 'remote' })
    taskService.bindRemote(USER, task.id, { adapter: id, id: remoteId, key: null, url: null, state: {} })
    taskService.acceptRemoteStatus(USER, task.id, 'blocked')
    return { adapter, task }
  }

  it('combines local and remote questions without colliding across tasks or services', async () => {
    makeTask()
    inboxService.recordRunEvent(ctx(), { ...permission, requestId: 'same-ask' })
    const first = remote()
    const second = remote('another')
    const entries = await listEntries(USER)
    expect(entries).toHaveLength(3)
    expect(new Set(entries.map((e) => e.requestId)).size).toBe(3)
    const entry = entries.find((e) => e.taskId === second.task.id)!
    expect(entry).toMatchObject({ source: 'remote', chatId: null, resume: 'reply' })
    expect(await inboxService.answer(USER, entry.requestId, { kind: 'question', answers: [['Yes']] })).toEqual({ ok: true })
    expect(second.adapter.answerAsk).toHaveBeenCalledWith(USER, expect.objectContaining({ id: 'task-there', adapter: 'another' }), 'same-ask', { kind: 'question', answers: [['Yes']] })
    expect(first.adapter.answerAsk).not.toHaveBeenCalled()
    expect(deliverAnswer).not.toHaveBeenCalled()
    expect(taskService.getById(USER, second.task.id).status).toBe('blocked')
  })

  it('never sends a stale address after deletion, re-binding, or from a different profile', async () => {
    const { task, adapter } = remote()
    const [entry] = await listEntries(USER)
    expect((await inboxService.answer('other-user', entry.requestId, { kind: 'question', answers: [[]] })).ok).toBe(false)
    taskService.bindRemote(USER, task.id, { adapter: adapter.id, id: 'new-task', key: null, url: null, state: {} })
    expect((await inboxService.answer(USER, entry.requestId, { kind: 'question', answers: [[]] })).ok).toBe(false)
    taskService.remove(USER, task.id)
    expect((await inboxService.answer(USER, entry.requestId, { kind: 'question', answers: [[]] })).ok).toBe(false)
    expect(adapter.answerAsk).not.toHaveBeenCalled()
  })

  it('names a failed or unavailable service instead of losing the list to it', async () => {
    // This used to reject, which is the bug the snapshot exists to fix: one
    // service being unreachable is not the list failing, and the reason is
    // carried per service so a caller can say how much of it is missing.
    const { adapter } = remote()
    vi.mocked(adapter.listOpenAsks).mockRejectedValue(new Error('offline'))
    expect(await inboxService.list(USER)).toEqual({
      entries: [], unreadable: [{ adapter: 'service', reason: 'offline' }]
    })
    adapter.availability = async () => ({ ready: false, reason: 'Sign in again.' })
    expect(await inboxService.list(USER)).toEqual({
      entries: [], unreadable: [{ adapter: 'service', reason: 'Sign in again.' }]
    })
  })

  it('still answers with the local asks while a remote service cannot be read', async () => {
    // **The whole point.** Mutation: rethrow the first rejection from
    // `remoteInboxService.read` and this fails on the first assertion — an ask
    // parked on *this* machine, which needed no network to find, disappears
    // from the only list it is in for the length of somebody else's outage.
    makeTask()
    inboxService.recordRunEvent(ctx(), permission)
    const { adapter } = remote()
    vi.mocked(adapter.listOpenAsks).mockRejectedValue(new Error('offline'))
    const snapshot = await inboxService.list(USER)
    expect(snapshot.entries.map((entry) => entry.requestId)).toEqual(['per_1'])
    expect(snapshot.unreadable).toEqual([{ adapter: 'service', reason: 'offline' }])
  })

  it('reports one unreadable entry per service, however many of its tasks are blocked', async () => {
    const { adapter } = remote()
    const second = taskService.create(USER, { title: 'Also there', goal: 'More remote work', executor: 'remote' })
    taskService.bindRemote(USER, second.id, { adapter: adapter.id, id: 'task-two', key: null, url: null, state: {} })
    taskService.acceptRemoteStatus(USER, second.id, 'blocked')
    vi.mocked(adapter.listOpenAsks)
      .mockRejectedValueOnce(new Error('offline'))
      .mockRejectedValueOnce(new Error('offline again'))
    const { unreadable } = await inboxService.list(USER)
    expect(unreadable).toEqual([{ adapter: 'service', reason: 'offline' }])
  })

  it('skips unsupported services and non-blocked tasks', async () => {
    const { task, adapter } = remote()
    taskService.acceptRemoteStatus(USER, task.id, 'in_progress')
    expect(await listEntries(USER)).toEqual([])
    taskService.acceptRemoteStatus(USER, task.id, 'blocked')
    adapter.capabilities = () => createNullAdapter(adapter.id).capabilities()
    expect(await listEntries(USER)).toEqual([])
    expect(adapter.listOpenAsks).not.toHaveBeenCalled()
  })

  it('keeps a network refusal retryable and distinguishes an already settled ask', async () => {
    const { adapter } = remote()
    const [entry] = await listEntries(USER)
    vi.mocked(adapter.answerAsk).mockRejectedValueOnce(new RemoteTaskError('unavailable', 'Sign in again.'))
    expect(await inboxService.answer(USER, entry.requestId, { kind: 'question', answers: [[]] })).toMatchObject({ ok: false, code: 'unavailable', reason: 'Sign in again.' })
    vi.mocked(adapter.answerAsk).mockResolvedValueOnce({ delivered: false })
    expect(await inboxService.answer(USER, entry.requestId, { kind: 'question', answers: [[]] })).toMatchObject({ ok: false, code: 'no_longer_waiting' })
  })

  it('coalesces overlapping reads and discards tasks removed during the round trip', async () => {
    const { adapter, task } = remote()
    let release!: (value: []) => void
    vi.mocked(adapter.listOpenAsks).mockImplementation(() => new Promise((resolve) => { release = resolve }))
    const first = listEntries(USER)
    const second = listEntries(USER)
    await vi.waitFor(() => expect(adapter.listOpenAsks).toHaveBeenCalledTimes(1))
    taskService.remove(USER, task.id)
    release([])
    expect(await first).toEqual([])
    expect(await second).toEqual([])
  })

  it('coalesces concurrent answers so two windows cannot send twice', async () => {
    const { adapter } = remote()
    const [entry] = await listEntries(USER)
    let release!: (value: { delivered: boolean }) => void
    vi.mocked(adapter.answerAsk).mockImplementation(() => new Promise((resolve) => { release = resolve }))
    const first = inboxService.answer(USER, entry.requestId, { kind: 'question', answers: [['Yes']] })
    const second = inboxService.answer(USER, entry.requestId, { kind: 'question', answers: [['Yes']] })
    const conflicting = inboxService.answer(USER, entry.requestId, { kind: 'question', answers: [['No']] })
    await vi.waitFor(() => expect(adapter.answerAsk).toHaveBeenCalledTimes(1))
    release({ delivered: true })
    expect(await conflicting).toMatchObject({ ok: false, code: 'unavailable' })
    expect(await first).toEqual({ ok: true })
    expect(await second).toEqual({ ok: true })
  })

  it('holds the read lock after one service fails until its slow sibling settles', async () => {
    const fast = remote('fast').adapter
    const slow = remote('slow').adapter
    let fail!: (error: Error) => void
    let release!: (value: []) => void
    vi.mocked(fast.listOpenAsks).mockReturnValue(new Promise((_resolve, reject) => { fail = reject }))
    vi.mocked(slow.listOpenAsks).mockReturnValue(new Promise((resolve) => { release = resolve }))
    const first = inboxService.list(USER)
    await vi.waitFor(() => expect(slow.listOpenAsks).toHaveBeenCalledTimes(1))
    fail(new Error('offline'))
    await new Promise<void>((resolve) => setImmediate(resolve))
    const retry = inboxService.list(USER)
    await new Promise<void>((resolve) => setImmediate(resolve))
    const readCount = vi.mocked(slow.listOpenAsks).mock.calls.length
    release([])
    // The failure no longer ends the read, and it still must not end the
    // *lock*: the retry joins the same operation and waits for the slow
    // sibling, rather than starting a second round of its network work.
    expect((await first).unreadable).toEqual([{ adapter: 'fast', reason: 'offline' }])
    expect((await retry).unreadable).toEqual([{ adapter: 'fast', reason: 'offline' }])
    expect(readCount).toBe(1)
  })

  it('answers a service that never replies as a hole, without ending the read it is waiting on', async () => {
    // The deadline is the one place `unreadable` is *synthesised* rather than
    // observed, and it used to reject — which is what took the local rows down
    // with it. Nothing pinned it: there are no fake timers anywhere else in
    // this file, so the ten-second path ran in no test at all.
    vi.useFakeTimers()
    try {
      const { adapter } = remote('sluggish')
      let release!: (value: []) => void
      vi.mocked(adapter.listOpenAsks).mockReturnValue(new Promise((resolve) => { release = resolve }))
      const pending = inboxService.list(USER)
      await vi.advanceTimersByTimeAsync(10_000)
      const snapshot = await pending
      expect(snapshot.unreadable).toEqual([
        { adapter: 'sluggish', reason: 'The service did not answer in time.' }
      ])
      // Nothing from that service is in the list — which is exactly why naming
      // it is honest rather than an over-claim. Whatever is local still is.
      expect(snapshot.entries.every((entry) => entry.source === 'local')).toBe(true)
      // And the read it gave up waiting on is still the one in flight: a caller
      // that tries again joins it instead of paying for its network work twice.
      void inboxService.list(USER)
      await vi.advanceTimersByTimeAsync(10_000)
      expect(adapter.listOpenAsks).toHaveBeenCalledTimes(1)
      // Settle it, or the coalesced read outlives this test and the next call
      // to `list` in this file joins a promise that never resolves.
      release([])
      await vi.advanceTimersByTimeAsync(0)
    } finally {
      vi.useRealTimers()
    }
  })
})


describe('next-message continuation', () => {
  const ask = { type: 'needs_input' as const, requestId: 'remote-task-1', resume: 'next_message' as const,
    request: { kind: 'question' as const, questions: [{ question: 'Which branch?', multiSelect: false, options: [] }] } }

  it('preserves a next-message ask over boot while expiring process-owned reply asks', async () => {
    makeTask()
    inboxService.recordRunEvent(ctx({ turnId: 'one' }), ask)
    inboxService.recordRunEvent(ctx(), permission)
    expect(taskInputRequestRepo.expireOpen()).toBe(1)
    const entries = await listEntries(USER)
    expect(entries).toHaveLength(1)
    expect(entries[0].resume).toBe('next_message')
  })

  it('deduplicates a repeated frame but gives the next occurrence its own address', async () => {
    makeTask()
    inboxService.recordRunEvent(ctx({ turnId: 'one' }), ask)
    inboxService.recordRunEvent(ctx({ turnId: 'one' }), ask)
    const [first] = await listEntries(USER)
    expect(await listEntries(USER)).toHaveLength(1)
    inboxService.resumeChat(ctx(), 'main')
    inboxService.recordRunEvent(ctx({ turnId: 'two' }), ask)
    const [second] = await listEntries(USER)
    expect(second.requestId).not.toBe(first.requestId)
    expect(await inboxService.answer(USER, first.requestId, { kind: 'question', answers: [['old answer']] }))
      .toMatchObject({ ok: false, code: 'already_answered' })
  })

  it('answers through the headless executor and resumes the same task', async () => {
    const task = makeTask()
    inboxService.recordRunEvent(ctx({ turnId: 'one' }), ask)
    inboxService.recordRunEvent(ctx(), { type: 'done', stopReason: 'end_turn' })
    const [entry] = await listEntries(USER)
    expect(await inboxService.answer(USER, entry.requestId, { kind: 'question', answers: [['main']] })).toEqual({ ok: true })
    expect(runStart).toHaveBeenCalledWith(
      { profileUserId: USER, settingsUserId: USER },
      { chatId: CHAT, content: 'main', addressedAgentId: AGENT },
      expect.objectContaining({ preserveOnRefusal: true })
    )
    expect(await listEntries(USER)).toHaveLength(0)
    expect(taskService.getById(USER, task.id).status).toBe('in_progress')
  })

  it('resumes a nested specialist with its original tool identity and keeps repeated questions durable', async () => {
    const task = makeTask()
    const root = ctx({ agentId: null, rootRunId: 'original-run', turnId: 'original-run' })
    inboxService.recordRunEvent(root, { type: 'child', agentId: AGENT, toolCallId: 'original-call', event: ask })
    inboxService.recordRunEvent(root, { type: 'done', stopReason: 'end_turn' })
    const [entry] = await listEntries(USER)
    runStart.mockImplementationOnce((scope, payload, options) => {
      const resumed = { userId: scope.profileUserId, chatId: payload.chatId, agentId: AGENT, rootRunId: 'resumed-run', turnId: 'resumed-run' }
      options.onAccepted(resumed)
      options.observe(resumed, { ...ask, requestId: 'follow-on-question' })
      options.observe(resumed, { type: 'done', stopReason: 'end_turn' })
      return { accepted: Promise.resolve(), completed: Promise.resolve({ state: 'needs_input', text: '' }) }
    })
    expect(await inboxService.answer(USER, entry.requestId, { kind: 'question', answers: [['main']] })).toEqual({ ok: true })
    expect(runStart).toHaveBeenCalledWith(expect.anything(), expect.anything(), expect.objectContaining({ agentId: AGENT, nested: { toolCallId: 'original-call' } }))
    const [repeated] = taskInputRequestRepo.listOpenForChat(CHAT)
    expect(repeated).toMatchObject({ agentId: AGENT, rootRunId: 'resumed-run', invocationId: 'resumed-run:original-call', resume: 'next_message' })
    expect(taskService.getById(USER, task.id).status).toBe('blocked')
  })

  it('retains the waiting ask and answer when dispatch is busy or refuses before acceptance', async () => {
    makeTask()
    inboxService.recordRunEvent(ctx({ turnId: 'one' }), ask)
    const [entry] = await listEntries(USER)
    runBusy.mockReturnValue(true)
    expect(await inboxService.answer(USER, entry.requestId, { kind: 'question', answers: [['main']] }))
      .toMatchObject({ ok: false, code: 'unavailable' })
    runBusy.mockReturnValue(false)
    runStart.mockImplementationOnce(() => { throw new Error('Could not save the message') })
    expect(await inboxService.answer(USER, entry.requestId, { kind: 'question', answers: [['main']] }))
      .toMatchObject({ ok: false, code: 'unavailable' })
    expect(taskInputRequestRepo.getById(entry.requestId)?.status).toBe('open')
  })

  it.each(['end_turn', 'canceled', 'error'] as const)('keeps another agent’s question blocked after this agent ends with %s', async (stopReason) => {
    const task = makeTask()
    inboxService.recordRunEvent(ctx({ turnId: 'one' }), ask)
    inboxService.recordRunEvent(ctx({ turnId: 'two', agentId: 'folder:beta' }), ask)
    inboxService.resumeChat(ctx(), 'main')
    inboxService.recordRunEvent(ctx(), { type: 'done', stopReason })
    const remaining = await listEntries(USER)
    expect(remaining).toHaveLength(1)
    expect(remaining[0].agentId).toBe('folder:beta')
    expect(taskService.getById(USER, task.id).status).toBe('blocked')
  })

  it.each(['cancelled', 'archived'] as const)('does not restart a %s task from a retained Inbox card', async (status) => {
    const task = makeTask()
    inboxService.recordRunEvent(ctx({ turnId: 'one' }), ask)
    const [entry] = await listEntries(USER)
    taskService.setStatus(USER, task.id, status)
    expect(await listEntries(USER)).toHaveLength(0)
    expect(await inboxService.answer(USER, entry.requestId, { kind: 'question', answers: [['main']] }))
      .toMatchObject({ ok: false, code: 'no_longer_waiting' })
    expect(runStart).not.toHaveBeenCalled()
    expect(taskService.getById(USER, task.id).status).toBe(status)
  })

  it('refuses a typed continuation when the task has moved to a remote executor', () => {
    const task = makeTask()
    inboxService.recordRunEvent(ctx({ turnId: 'one' }), ask)
    taskService.bindRemote(USER, task.id, { adapter: 'fake', id: 'remote-one', key: null, url: null, state: {} })
    taskService.handOffToRemote(USER, task.id)
    expect(() => inboxService.resumeChat(ctx(), 'main')).toThrow('running elsewhere')
    expect(taskInputRequestRepo.listOpenForChat(CHAT)).toHaveLength(1)
  })

  it('prevents coordinator re-entry while this agent is waiting for a human answer', async () => {
    const { A2AAsMcpProvider } = await import('./a2aAsMcpProvider')
    makeTask()
    inboxService.recordRunEvent(ctx({ turnId: 'parent:tool-one' }), ask)
    const provider = new A2AAsMcpProvider(CHAT, { id: AGENT, name: 'Alpha', driver: 'a2a' } as AgentRow, USER, 'alpha')
    expect(await provider.callTool('alpha', { message: 'Keep going' })).toMatchObject({ isError: true })
    expect(toolRun).not.toHaveBeenCalled()
    inboxService.resumeChat(ctx(), 'main')
    expect(await provider.callTool('alpha', { message: 'Keep going' })).toMatchObject({ content: 'Done' })
    expect(toolRun).toHaveBeenCalledTimes(1)
  })

  it('uses child invocation identity when one parent turn calls the same agent again', async () => {
    makeTask()
    const parent = ctx({ turnId: 'parent', agentId: null })
    inboxService.recordRunEvent(parent, { type: 'child', toolCallId: 'tool-one', agentId: AGENT, event: ask })
    const [first] = await listEntries(USER)
    inboxService.resumeChat(ctx(), 'main')
    inboxService.recordRunEvent(parent, { type: 'child', toolCallId: 'tool-two', agentId: AGENT, event: ask })
    const [second] = await listEntries(USER)
    expect(second.requestId).not.toBe(first.requestId)
  })

  it('rolls back the user message and request settlement together if acceptance fails', async () => {
    const { messageRepo } = await import('../db/messages')
    makeTask()
    inboxService.recordRunEvent(ctx({ turnId: 'one' }), ask)
    const [entry] = await listEntries(USER)
    expect(() => messageRepo.saveUser({ chatId: CHAT, content: 'Answer that was not accepted' }, () => {
      taskInputRequestRepo.settle(entry.requestId, 'answered', { kind: 'question', answers: [['main']] })
      throw new Error('acceptance failed')
    })).toThrow('acceptance failed')
    expect(messageRepo.firstByRole(CHAT, 'user')).toBeUndefined()
    expect(taskInputRequestRepo.getById(entry.requestId)?.status).toBe('open')
  })
})

describe('run and invocation ownership', () => {
  const root = ctx({ rootRunId: 'run-1', turnId: 'run-1', completionOwner: 'runner' })
  const child = (toolCallId: string, event: RunEvent): RunEvent =>
    ({ type: 'child', toolCallId, agentId: AGENT, event })
  const answer = { kind: 'permission' as const, reply: 'once' as const }

  it('keeps sibling requests blocked when the actual Inbox answer settles first', async () => {
    const task = makeChatTask()
    inboxService.recordRunEvent(root, child('a', permission))
    inboxService.recordRunEvent(root, child('b', { ...permission, requestId: 'per_2' }))
    expect(await inboxService.answer(USER, 'per_1', answer)).toEqual({ ok: true })
    inboxService.recordRunEvent(root, child('a', { type: 'input_resolved', requestId: 'per_1', resolution: answer }))
    expect(taskInputRequestRepo.getById('per_1')?.status).toBe('answered')
    expect(taskInputRequestRepo.getById('per_2')?.status).toBe('open')
    expect(taskService.getById(USER, task.id).status).toBe('blocked')
    expect(await inboxService.answer(USER, 'per_2', answer)).toEqual({ ok: true })
    expect(taskService.getById(USER, task.id).status).toBe('in_progress')
  })

  it('aggregates surviving asks after an expired Inbox reply', async () => {
    const task = makeChatTask()
    inboxService.recordRunEvent(root, permission)
    inboxService.recordRunEvent(root, { ...permission, requestId: 'per_2' })
    holder.deliver = () => ({ ok: false, code: 'no_longer_waiting', reason: ASK_NO_LONGER_WAITING })
    await inboxService.answer(USER, 'per_1', answer)
    expect(taskService.getById(USER, task.id).status).toBe('blocked')
    await inboxService.answer(USER, 'per_2', answer)
    expect(taskService.getById(USER, task.id).status).toBe('in_progress')
    expect(taskInputRequestRepo.listOpenForRun(CHAT, 'run-1')).toEqual([])
  })

  it('expires only the ending child, then its root, leaving other roots and legacy asks intact', () => {
    const task = makeChatTask()
    inboxService.recordRunEvent(root, child('a', permission))
    inboxService.recordRunEvent(root, child('b', { ...permission, requestId: 'per_2' }))
    inboxService.recordRunEvent(ctx({ rootRunId: 'run-2', turnId: 'run-2' }), { ...permission, requestId: 'other' })
    inboxService.recordRunEvent(ctx(), { ...permission, requestId: 'legacy' })
    inboxService.recordRunEvent(root, child('a', { type: 'done', stopReason: 'canceled' }))
    expect(taskInputRequestRepo.getById('per_1')?.status).toBe('expired')
    expect(taskInputRequestRepo.getById('per_2')?.status).toBe('open')
    expect(taskService.getById(USER, task.id).status).toBe('blocked')
    inboxService.recordRunEvent(root, { type: 'done', stopReason: 'canceled' })
    expect(taskInputRequestRepo.getById('per_2')?.status).toBe('expired')
    expect(taskInputRequestRepo.listOpenForTask(task.id).map((row) => row.id).sort()).toEqual(['legacy', 'other'])
  })

  it('ignores a late resolution for a replaced request from another invocation', () => {
    const task = makeChatTask()
    inboxService.recordRunEvent(root, child('a', permission))
    inboxService.recordRunEvent(root, child('b', permission))
    inboxService.recordRunEvent(root, child('a', { type: 'input_resolved', requestId: 'per_1', resolution: answer }))
    expect(taskInputRequestRepo.getById('per_1')).toMatchObject({ status: 'open', rootRunId: 'run-1', invocationId: 'run-1:b' })
    expect(taskService.getById(USER, task.id).status).toBe('blocked')
    inboxService.recordRunEvent(root, child('b', { type: 'input_resolved', requestId: 'per_1', resolution: answer }))
    expect(taskInputRequestRepo.getById('per_1')?.status).toBe('answered')
  })

  it('does not finish a runner-owned task when its turn finishes', () => {
    const task = makeChatTask()
    inboxService.recordRunEvent(root, permission)
    inboxService.recordRunEvent(root, { type: 'done', stopReason: 'end_turn' })
    expect(taskInputRequestRepo.getById('per_1')?.status).toBe('expired')
    expect(taskService.getById(USER, task.id).status).toBe('in_progress')
  })

  it('keeps another agent blocked after typed continuation and preserves next-message asks at normal end', () => {
    const task = makeChatTask()
    const ask = { type: 'needs_input' as const, requestId: 'question', resume: 'next_message' as const,
      request: { kind: 'question' as const, questions: [{ question: 'Which branch?', multiSelect: false, options: [] }] } }
    inboxService.recordRunEvent(root, ask)
    inboxService.recordRunEvent({ ...root, agentId: 'other-agent', turnId: 'run-1:other' }, ask)
    inboxService.recordRunEvent(root, { type: 'done', stopReason: 'end_turn' })
    expect(taskInputRequestRepo.listOpenForRun(CHAT, 'run-1')).toHaveLength(2)
    inboxService.resumeChat(root, 'main')
    expect(taskInputRequestRepo.listOpenForTask(task.id)).toHaveLength(1)
    expect(taskInputRequestRepo.listOpenForTask(task.id)[0].agentId).toBe('other-agent')
    expect(taskService.getById(USER, task.id).status).toBe('blocked')
  })
})

describe('runtime child completion integration', () => {
  it.each([false, true])('cleans up a driver that silently drops a reply before the next tool call (failure=%s)', async (isError) => {
    const { A2AAsMcpProvider } = await import('./a2aAsMcpProvider')
    const task = makeChatTask()
    const root = ctx({ agentId: null, rootRunId: 'model-run', turnId: 'model-run', completionOwner: 'runner' })
    const sibling = ctx({ rootRunId: 'sibling-run', turnId: 'sibling-run' })
    inboxService.recordRunEvent(sibling, { ...permission, requestId: 'sibling' })
    const provider = new A2AAsMcpProvider(CHAT, { id: AGENT, name: 'Alpha', driver: 'a2a' } as AgentRow, USER, 'alpha')
    toolRun.mockImplementationOnce(async (_owner, _agent, io) => {
      io.onEvent?.(permission)
      expect(taskInputRequestRepo.getById('per_1')).toMatchObject({ rootRunId: 'model-run', invocationId: 'model-run:tool-1', status: 'open' })
      return { text: 'child output', parts: [], notices: [], ...(isError ? { error: { message: 'child failed', raw: 'failed' } } : {}) }
    })
    const result = await provider.callTool('alpha', { message: 'Build' }, {
      toolCallId: 'tool-1', onEvent: provider.eventSink('tool-1', (event) => inboxService.recordRunEvent(root, event))
    })
    // The runtime MCP bridge emits the parent result before another call starts.
    inboxService.recordRunEvent(root, result.isError
      ? { type: 'tool_error', id: 'tool-1', error: String(result.content) }
      : { type: 'tool_result', id: 'tool-1', result: result.content })
    expect(taskInputRequestRepo.getById('per_1')?.status).toBe('expired')
    expect(taskInputRequestRepo.getById('sibling')?.status).toBe('open')
    expect(taskService.getById(USER, task.id).status).toBe('blocked')
    expect(toolRun).toHaveBeenCalledTimes(1)
    expect(result.content).toBe(isError ? 'child failed' : 'child output')
  })
})


describe('permissions in accepted follow-up chat turns', () => {
  it.each(['completed', 'cancelled', 'error'] as const)('reactivates a %s local chat task only on a new accepted message', async (status) => {
    const task = makeChatTask()
    taskService.setStatus(USER, task.id, status)
    // A stray status/update must not revive a finished task.
    taskService.applyRunState(USER, task.id, 'needs_input')
    expect(taskService.getById(USER, task.id).status).toBe(status)
    const current = ctx({ rootRunId: 'follow-up', turnId: 'follow-up', completionOwner: 'turn' })
    inboxService.resumeChat(current, 'Continue')
    expect(taskService.getById(USER, task.id)).toMatchObject({ status: 'in_progress', finishedAt: null })
    inboxService.recordRunEvent(current, { ...permission, requestId: 'per_follow_up' })
    expect(taskService.getById(USER, task.id).status).toBe('blocked')
    expect(await inboxService.answerFromTranscript(USER, 'per_follow_up', { kind: 'permission', reply: 'once' })).toMatchObject({ ok: true })
    expect(taskService.getById(USER, task.id).status).toBe('in_progress')
  })
  it('does not reactivate completed jobs or archived chats', () => {
    const job = makeTask()
    taskService.setStatus(USER, job.id, 'completed')
    inboxService.resumeChat(ctx(), 'Continue')
    expect(taskService.getById(USER, job.id).status).toBe('completed')
    expect(() => taskService.resumeFinishedChat(USER, job.id, CHAT)).toThrow()
    makeChat('chat-other')
    const task = makeChatTask('chat-other')
    taskService.setStatus(USER, task.id, 'archived')
    expect(() => taskService.resumeFinishedChat(USER, task.id, 'chat-other')).toThrow()
  })
})
