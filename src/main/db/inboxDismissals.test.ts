import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createTestDatabase, type TestDatabase } from './testSupport/nodeSqlite'
const holder = vi.hoisted(() => ({ current: null as TestDatabase | null }))
vi.mock('./client', () => ({ getDb: () => holder.current!.db, getRawSqlite: () => holder.current!.sqlite }))
const { inboxDismissalRepo } = await import('./inboxDismissals')
beforeEach(() => { holder.current = createTestDatabase() })
afterEach(() => { holder.current?.close() })

describe('inbox dismissals', () => {
  it('keeps dismissals per profile and kind, idempotently, and clears only the keys named', () => {
    inboxDismissalRepo.put('p1', 'skill_disconnected', 'a')
    inboxDismissalRepo.put('p1', 'skill_disconnected', 'a')
    inboxDismissalRepo.put('p1', 'skill_disconnected', 'b')
    inboxDismissalRepo.put('p2', 'skill_disconnected', 'a')
    expect([...inboxDismissalRepo.keys('p1', 'skill_disconnected')].sort()).toEqual(['a', 'b'])
    inboxDismissalRepo.clear('p1', 'skill_disconnected', ['a'])
    inboxDismissalRepo.clear('p1', 'skill_disconnected', [])
    expect([...inboxDismissalRepo.keys('p1', 'skill_disconnected')]).toEqual(['b'])
    expect([...inboxDismissalRepo.keys('p2', 'skill_disconnected')]).toEqual(['a'])
  })
})
