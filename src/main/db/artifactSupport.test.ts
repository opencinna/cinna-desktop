import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createTestDatabase, type TestDatabase } from './testSupport/nodeSqlite'
const holder = vi.hoisted(() => ({ current: null as TestDatabase | null }))
vi.mock('./client', () => ({ getDb: () => holder.current!.db, getRawSqlite: () => holder.current!.sqlite }))
const { artifactSupportRepo } = await import('./artifactSupport')

const LIMITS = { maxRevisionBytes: 1000, maxRevisionFiles: 10, maxFileBytes: 500 }

beforeEach(() => {
  holder.current = createTestDatabase()
  holder.current.raw.exec(`INSERT INTO users (id, type, username, display_name, created_at) VALUES ('p1', 'cinna_user', 'p1', 'P1', 1), ('p2', 'cinna_user', 'p2', 'P2', 1);`)
})
afterEach(() => {
  holder.current?.close()
})

describe('kept artifacts support', () => {
  it('keeps one answer per profile and server, overwrites it, and forgets it', () => {
    expect(artifactSupportRepo.get('p1', 'https://a')).toBeNull()
    artifactSupportRepo.set('p1', 'https://a', { instanceName: 'Acme', limits: LIMITS })
    artifactSupportRepo.set('p1', 'https://a', { limits: { ...LIMITS, maxFileBytes: 7 } })
    artifactSupportRepo.set('p2', 'https://a', { instanceName: 'Other', limits: LIMITS })
    expect(artifactSupportRepo.get('p1', 'https://a')).toEqual({ limits: { ...LIMITS, maxFileBytes: 7 } })
    expect(artifactSupportRepo.get('p1', 'https://b')).toBeNull()
    expect(artifactSupportRepo.get('p2', 'https://a')).toEqual({ instanceName: 'Other', limits: LIMITS })
    expect(holder.current!.raw.prepare('SELECT COUNT(*) AS n FROM artifact_support').get()).toEqual({ n: 2 })
    artifactSupportRepo.forget('p1', 'https://a')
    expect(artifactSupportRepo.get('p1', 'https://a')).toBeNull()
    expect(artifactSupportRepo.get('p2', 'https://a')).not.toBeNull()
  })

  it('goes with its profile', () => {
    artifactSupportRepo.set('p1', 'https://a', { instanceName: 'Acme', limits: LIMITS })
    holder.current!.raw.exec("PRAGMA foreign_keys = ON; DELETE FROM users WHERE id = 'p1'")
    expect(artifactSupportRepo.get('p1', 'https://a')).toBeNull()
  })
})
