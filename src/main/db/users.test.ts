import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createTestDatabase, type TestDatabase } from './testSupport/nodeSqlite'

/**
 * `userRepo.deleteWithCascade` enumerates the user-scoped tables by hand —
 * `tasks.user_id` has no foreign key, so nothing removes a row the list forgets.
 * A profile delete that leaves content behind is not a bug anyone sees: the
 * rows are simply still there, under a dead user id, holding whatever the user
 * believed they had erased.
 *
 * A table added to the schema without a line in that transaction is the failure
 * this file exists to catch, so **a new user-scoped table gets a case here**.
 */

const holder = vi.hoisted(() => ({ current: null as TestDatabase | null }))

vi.mock('./client', () => ({
  getDb: () => {
    if (!holder.current) throw new Error('test database not initialised')
    return holder.current.db
  },
  getRawSqlite: () => {
    if (!holder.current) throw new Error('test database not initialised')
    return holder.current.sqlite
  }
}))

const { userRepo } = await import('./users')

const USER = 'u-1'
const KEEPER = 'u-2'

beforeEach(() => {
  holder.current = createTestDatabase()
  const now = Date.now()
  for (const id of [USER, KEEPER]) {
    holder.current.raw
      .prepare(
        `INSERT INTO users (id, type, username, display_name, created_at)
         VALUES (?, 'local_user', ?, ?, ?)`
      )
      .run(id, id, id, now)
  }
})

afterEach(() => {
  holder.current?.close()
  holder.current = null
})

function seedTask(userId: string, taskId: string): void {
  const raw = holder.current!.raw
  const now = Date.now()
  raw
    .prepare(
      `INSERT INTO tasks (id, user_id, title, goal, status, priority, router, origin, executor,
                          assignee_kind, handoff_note, error_message, created_at, updated_at)
       VALUES (?, ?, 'Ship it', 'Ship the thing', 'blocked', 'normal', 'direct', 'local',
               'desktop', 'model', 'the note', 'the error', ?, ?)`
    )
    .run(taskId, userId, now, now)
  raw
    .prepare(
      `INSERT INTO task_input_requests (id, task_id, chat_id, agent_id, request, resume, status, created_at)
       VALUES (?, ?, 'c-1', 'a-1', '{"kind":"permission","action":"bash","resources":[]}',
               'reply', 'open', ?)`
    )
    .run(`per_${taskId}`, taskId, now)
}

function count(table: string): number {
  const row = holder.current!.raw.prepare(`SELECT COUNT(*) AS c FROM ${table}`).get() as {
    c: number
  }
  return row.c
}

describe('deleteWithCascade', () => {
  it('deletes handoff receipts and prevents a late response from recreating them', async () => {
    const { taskHandoffRepo } = await import('./taskHandoffs')
    const receipt = { taskId: 'deleted-task', chatId: 'chat', state: 'uncertain' as const,
      adapterId: 'service', bindingPending: true, assignee: { ref: 'agent', name: 'Agent' },
      remote: null, message: 'May have started', updatedAt: Date.now() }
    taskHandoffRepo.put(USER, receipt)
    taskHandoffRepo.put(KEEPER, { ...receipt, taskId: 'keeper-task' })
    userRepo.deleteWithCascade(USER)
    expect(taskHandoffRepo.get(USER, receipt.taskId)).toBeNull()
    expect(taskHandoffRepo.get(KEEPER, 'keeper-task')).not.toBeNull()
    expect(() => taskHandoffRepo.put(USER, receipt)).toThrow('deleted')
    expect(count('task_handoffs')).toBe(1)
  })

  it('takes the profile’s tasks and their open asks with it', () => {
    seedTask(USER, 't-1')
    expect(count('tasks')).toBe(1)
    expect(count('task_input_requests')).toBe(1)

    userRepo.deleteWithCascade(USER)

    // The goal, the handoff note and the error text are all on the task row.
    expect(count('tasks')).toBe(0)
    // …and the asks go with it, by the foreign key, because this is a hard delete.
    expect(count('task_input_requests')).toBe(0)
  })

  it('leaves another profile’s tasks alone', () => {
    seedTask(USER, 't-1')
    seedTask(KEEPER, 't-2')

    userRepo.deleteWithCascade(USER)

    expect(count('tasks')).toBe(1)
    expect(count('task_input_requests')).toBe(1)
    const row = holder.current!.raw.prepare('SELECT user_id FROM tasks').get()
    expect(row).toEqual({ user_id: KEEPER })
  })

  it('leaves referential integrity intact afterwards', () => {
    seedTask(USER, 't-1')
    userRepo.deleteWithCascade(USER)
    expect(holder.current!.raw.prepare('PRAGMA foreign_key_check').all()).toEqual([])
  })
})
