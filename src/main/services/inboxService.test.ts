import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createTestDatabase, type TestDatabase } from '../db/testSupport/nodeSqlite'
import { ASK_NO_LONGER_WAITING, type InboxAnswerResult } from '../../shared/inbox'
import type { RunEvent } from '../../shared/runEvents'

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
  deliver: null as ((requestId: string) => InboxAnswerResult) | null
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
    deliverAnswer(args[0] as string, args[1] as string)
}))

const { inboxService } = await import('./inboxService')
const { taskService } = await import('./taskService')
const { taskInputRequestRepo } = await import('../db/taskInputRequests')

const USER = '__default__'
const CHAT = 'chat-1'
const AGENT = 'folder:alpha'

const permission: Extract<RunEvent, { type: 'needs_input' }> = {
  type: 'needs_input',
  requestId: 'per_1',
  request: { kind: 'permission', action: 'bash', resources: ['rm -rf build'] },
  resume: 'reply'
}

function ctx(overrides: { chatId?: string; agentId?: string | null } = {}) {
  return { userId: USER, chatId: CHAT, agentId: AGENT, ...overrides }
}

/** A chat row, because `tasks.chat_id` is a real foreign key and tests run with FKs on. */
function makeChat(id: string): void {
  holder.current?.raw.exec(
    `INSERT INTO chats (id, user_id, title, created_at, updated_at)
     VALUES ('${id}', '${USER}', 'Run', 0, 0)`
  )
}

/** A task in the state a job run leaves it in: started, running in its chat. */
function makeTask(chatId: string | null = CHAT) {
  const task = taskService.create(USER, {
    title: 'Ship the thing',
    goal: 'Ship the thing by Friday',
    chatId
  })
  return taskService.start(USER, task.id, { chatId })
}

beforeEach(() => {
  holder.current = createTestDatabase()
  holder.deliver = null
  deliverAnswer.mockClear()
  makeChat(CHAT)
})

afterEach(() => {
  holder.current?.close()
  holder.current = null
})

describe('recording an ask', () => {
  it('opens a row and blocks the task when a run parks', () => {
    const task = makeTask()
    inboxService.recordRunEvent(ctx(), permission)

    const entries = inboxService.list(USER)
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

  it('blocks the task but writes no row for an ask the next message answers', () => {
    // A2A ends the turn to ask, so there is no address to post an answer to —
    // a row would be a button in the inbox with nothing behind it.
    const task = makeTask()
    inboxService.recordRunEvent(ctx(), { ...permission, resume: 'next_message' })

    expect(inboxService.list(USER)).toEqual([])
    expect(taskService.getById(USER, task.id).status).toBe('blocked')
  })

  it('records nothing for an ask in a chat that has no task', () => {
    makeChat('chat-2')
    inboxService.recordRunEvent(ctx({ chatId: 'chat-2' }), permission)
    expect(inboxService.list(USER)).toEqual([])
    expect(taskInputRequestRepo.getById('per_1')).toBeUndefined()
  })

  it('attributes a nested agent’s ask to the agent that raised it', () => {
    // The orchestrator's own turn is the model's, so the outer context names no
    // agent; only the `child` wrapper knows who asked.
    makeTask()
    inboxService.recordRunEvent(ctx({ agentId: null }), {
      type: 'child',
      toolCallId: 'call-1',
      agentId: 'folder:beta',
      event: permission
    })
    expect(inboxService.list(USER)[0].agentId).toBe('folder:beta')
  })

  it('drops a parked ask nobody can be said to have raised', () => {
    makeTask()
    inboxService.recordRunEvent(ctx({ agentId: null }), permission)
    expect(inboxService.list(USER)).toEqual([])
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

  it('supersedes an ask re-raised under the same id', () => {
    const task = makeTask()
    inboxService.recordRunEvent(ctx(), permission)
    inboxService.closeAsk(ctx(), 'per_1', { kind: 'permission', reply: 'once' })
    inboxService.recordRunEvent(ctx(), permission)

    // A driver that re-asks under an id it has used before (a reconnect
    // replaying the ask) is describing the same ask again; the answered row
    // must not be what the user is left looking at.
    expect(inboxService.list(USER)).toHaveLength(1)
    expect(taskService.getById(USER, task.id).status).toBe('blocked')
  })
})

describe('settling an ask from the stream', () => {
  it('closes the row and returns the task to in_progress', () => {
    const task = makeTask()
    inboxService.recordRunEvent(ctx(), permission)
    inboxService.recordRunEvent(ctx(), {
      type: 'input_resolved',
      requestId: 'per_1',
      resolution: { kind: 'permission', reply: 'once' }
    })

    expect(inboxService.list(USER)).toEqual([])
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

  it('expires the ask and takes the task off blocked', () => {
    // The ACP driver closes the turn *before* releasing its parks, and
    // `input_resolved` is gated on the turn being open — so a Stop, the turn
    // ceiling and a crash all settle the registry in silence. Without this the
    // row sits open until the next restart: an inbox entry whose only possible
    // outcome is "no longer waiting for an answer".
    const task = makeTask()
    inboxService.recordRunEvent(ctx(), permission)
    inboxService.recordRunEvent(ctx(), done)

    expect(taskInputRequestRepo.getById('per_1')?.status).toBe('expired')
    expect(inboxService.list(USER)).toEqual([])
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

  it('leaves an ask alone when a nested agent finishes', () => {
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

    expect(inboxService.list(USER)).toHaveLength(1)
  })

  it('leaves a task blocked by an ask the next message answers', () => {
    // An A2A ask *is* the turn ending, so `done` says nothing about whether the
    // user still owes an answer. Nothing was expired, so nothing is unblocked
    // here — `reportRunCompletion` is what writes the run's own outcome.
    const task = makeTask()
    inboxService.recordRunEvent(ctx(), { ...permission, resume: 'next_message' })
    inboxService.recordRunEvent(ctx(), done)

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

describe('the list', () => {
  it('shows the newest ask first', () => {
    makeTask()
    inboxService.recordRunEvent(ctx(), permission)
    inboxService.recordRunEvent(ctx(), { ...permission, requestId: 'per_2' })
    // Both rows are written in the same millisecond here; the older one is aged
    // by hand so the ordering under test is the column's, not the insert order.
    holder.current?.raw.exec(
      `UPDATE task_input_requests SET created_at = created_at - 1000 WHERE id = 'per_1'`
    )

    expect(inboxService.list(USER).map((e) => e.requestId)).toEqual(['per_2', 'per_1'])
  })

  it('drops the asks of a task the user deleted', () => {
    // `taskService.remove` is a *soft* delete, so the `ON DELETE CASCADE` on
    // `task_input_requests` never fires and the rows outlive the task. The list
    // has to exclude them itself rather than trust the foreign key.
    const task = makeTask()
    inboxService.recordRunEvent(ctx(), permission)
    taskService.remove(USER, task.id)
    expect(inboxService.list(USER)).toEqual([])
  })

  it('shows nothing to another profile', () => {
    makeTask()
    inboxService.recordRunEvent(ctx(), permission)
    expect(inboxService.list('someone-else')).toEqual([])
  })
})

describe('answering from the inbox', () => {
  it('delivers the answer, closes the row and unblocks the task', () => {
    const task = makeTask()
    inboxService.recordRunEvent(ctx(), permission)

    const result = inboxService.answer(USER, 'per_1', { kind: 'permission', reply: 'once' })

    expect(result.ok).toBe(true)
    expect(deliverAnswer).toHaveBeenCalledWith(USER, 'per_1')
    expect(taskInputRequestRepo.getById('per_1')?.status).toBe('answered')
    expect(inboxService.list(USER)).toEqual([])
    expect(taskService.getById(USER, task.id).status).toBe('in_progress')
  })

  it('settles the row here rather than waiting for the stream to say so', () => {
    // The whole point of the inbox is that it is answered when nobody is
    // watching the turn's port. If the row only closed on the `input_resolved`
    // the driver posts there, an answer given with the chat closed would leave
    // the entry sitting in the list.
    makeTask()
    inboxService.recordRunEvent(ctx(), permission)
    inboxService.answer(USER, 'per_1', { kind: 'permission', reply: 'once' })
    expect(taskInputRequestRepo.getById('per_1')?.resolvedAt).not.toBeNull()
  })

  it('expires an ask whose driver is gone, and does not throw', () => {
    const task = makeTask()
    inboxService.recordRunEvent(ctx(), permission)
    holder.deliver = () => ({
      ok: false,
      reason: ASK_NO_LONGER_WAITING,
      code: 'no_longer_waiting'
    })

    const result = inboxService.answer(USER, 'per_1', { kind: 'permission', reply: 'once' })

    expect(result).toEqual({
      ok: false,
      reason: ASK_NO_LONGER_WAITING,
      code: 'no_longer_waiting'
    })
    // The entry stops offering a button whose only outcome is that message.
    expect(taskInputRequestRepo.getById('per_1')?.status).toBe('expired')
    expect(inboxService.list(USER)).toEqual([])
    // Still blocked: nothing answered it, so the task has not moved on.
    expect(taskService.getById(USER, task.id).status).toBe('blocked')
  })

  it('keeps the ask open when the answer was merely the wrong shape', () => {
    makeTask()
    inboxService.recordRunEvent(ctx(), permission)
    holder.deliver = () => ({ ok: false, reason: 'Malformed answer', code: 'malformed' })

    expect(inboxService.answer(USER, 'per_1', { kind: 'rejected' }).ok).toBe(false)
    expect(taskInputRequestRepo.getById('per_1')?.status).toBe('open')
  })

  it('refuses a second answer to the same ask', () => {
    makeTask()
    inboxService.recordRunEvent(ctx(), permission)
    inboxService.answer(USER, 'per_1', { kind: 'permission', reply: 'once' })

    const again = inboxService.answer(USER, 'per_1', { kind: 'permission', reply: 'once' })
    expect(again).toMatchObject({ ok: false, code: 'already_answered' })
    expect(deliverAnswer).toHaveBeenCalledTimes(1)
  })

  it('does not call an expired ask answered', () => {
    // Mutation: fold the `expired` arm back into `row.status !== 'open'` and
    // this fails — an ask the turn abandoned comes back "already answered",
    // which over `rm -rf build` tells the user somebody allowed it. Nobody
    // decided anything; the address simply died.
    makeTask()
    inboxService.recordRunEvent(ctx(), permission)
    // The turn ends under the parked ask — a Stop, the ceiling, a crash.
    inboxService.recordRunEvent(ctx(), { type: 'done', stopReason: 'canceled' })
    expect(taskInputRequestRepo.getById('per_1')?.status).toBe('expired')

    const result = inboxService.answer(USER, 'per_1', { kind: 'permission', reply: 'once' })

    expect(result).toMatchObject({ ok: false, code: 'no_longer_waiting' })
    expect(result.reason).toBe(ASK_NO_LONGER_WAITING)
    expect(deliverAnswer).not.toHaveBeenCalled()
  })

  it('refuses an ask that belongs to another profile, without delivering it', () => {
    makeTask()
    inboxService.recordRunEvent(ctx(), permission)

    const result = inboxService.answer('someone-else', 'per_1', {
      kind: 'permission',
      reply: 'once'
    })

    expect(result).toMatchObject({ ok: false, code: 'no_longer_waiting' })
    expect(deliverAnswer).not.toHaveBeenCalled()
    expect(taskInputRequestRepo.getById('per_1')?.status).toBe('open')
  })

  it('refuses an ask nobody recorded', () => {
    expect(inboxService.answer(USER, 'per_missing', { kind: 'permission', reply: 'once' })).toMatchObject({
      ok: false,
      code: 'no_longer_waiting'
    })
    expect(deliverAnswer).not.toHaveBeenCalled()
  })
})

describe('the boot sweep', () => {
  it('expires every open ask, because no driver process survived the restart', () => {
    makeTask()
    inboxService.recordRunEvent(ctx(), permission)

    expect(taskInputRequestRepo.expireOpen()).toBe(1)
    expect(taskInputRequestRepo.getById('per_1')?.status).toBe('expired')
    expect(inboxService.list(USER)).toEqual([])
    // Idempotent: a second boot finds nothing left to expire.
    expect(taskInputRequestRepo.expireOpen()).toBe(0)
  })
})
