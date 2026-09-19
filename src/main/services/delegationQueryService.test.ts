import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createTestDatabase, type TestDatabase } from '../db/testSupport/nodeSqlite'
const holder = vi.hoisted(() => ({ current: null as TestDatabase | null }))
vi.mock('../db/client', () => ({ getDb: () => holder.current!.db, getRawSqlite: () => holder.current!.sqlite }))
const { taskRepo } = await import('../db/tasks')
const { delegationRepo } = await import('../db/delegations')
const { delegationQueryService } = await import('./delegationQueryService')
beforeEach(() => { holder.current = createTestDatabase() })
afterEach(() => holder.current?.close())

describe('task delegation links', () => {
  it('reads both directions across channels without using the task parent hierarchy', () => {
    for (const id of ['root', 'middle', 'leaf', 'another', 'other-leaf']) taskRepo.create('__default__', { id, title: id, goal: id })
    const make = (requesterKey: string, originTaskId: string, taskId: string) => delegationRepo.insert({ userId: '__default__', requesterKey, originKind: 'local_task', originTaskId, taskId, targetKind: 'kit', targetAgentId: 'worker', channel: 'local', depth: 1 })
    const from = make('first', 'root', 'middle')
    const to = make('second', 'middle', 'leaf')
    make('unrelated', 'another', 'other-leaf')
    delegationRepo.update('__default__', to.id, { targetKind: 'cloud', channel: 'cloud', resultStatus: 'blocked', questionAudience: 'user', state: 'waiting_user' })
    const result = delegationQueryService.forTask('__default__', 'middle')
    expect(result.from).toMatchObject({ id: from.id, originTaskId: 'root', taskId: 'middle' })
    expect(result.to).toHaveLength(1)
    expect(result.to[0]).toMatchObject({ id: to.id, taskId: 'leaf', channel: 'cloud', waitingOnUser: true })
    expect(delegationQueryService.forTask('another-profile', 'middle')).toEqual({ from: null, to: [] })
    expect(delegationQueryService.forTask('__default__', 'deleted-task')).toEqual({ from: null, to: [] })
    taskRepo.softDelete('__default__', 'middle')
    expect(delegationQueryService.forTask('__default__', 'middle')).toEqual({ from: null, to: [] })
  })
})
