import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createTestDatabase, type TestDatabase } from './testSupport/nodeSqlite'
import type { MessageTelemetry, SessionTelemetry } from '../../shared/sessionTelemetry'

/** Session telemetry against a real database: the per-chat row and the per-message column. */

const holder = vi.hoisted(() => ({ current: null as TestDatabase | null }))
vi.mock('./client', () => ({
  getDb: () => {
    if (!holder.current) throw new Error('test database not initialised')
    return holder.current.db
  }
}))

const { sessionTelemetryRepo } = await import('./sessionTelemetry')
const { messageRepo } = await import('./messages')
const { chatRepo } = await import('./chats')

const telemetry = (chatId: string): SessionTelemetry => ({
  chatId, engine: 'claude', auth: { kind: 'subscription', label: 'Claude Max', plan: 'max' },
  model: { selected: 'default', resolved: 'claude-sonnet-5[1m]', source: 'quota' },
  context: { used: 16_400, size: 1_000_000, sizeAuthoritative: true },
  totals: { tokens: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4 }, costUsd: 0.04, costSource: 'runtime', turns: 1,
    tokenScope: 'turn', byModel: {}, bySession: {} },
  cache: { ttlSource: 'assumed', lastRequestAt: 5 },
  updatedAt: 1_700_000_000_000
})

beforeEach(() => {
  holder.current = createTestDatabase()
  holder.current.raw.exec(`INSERT INTO chats (id,user_id,title,created_at,updated_at) VALUES ('c1','__default__','Chat',1,1)`)
})
afterEach(() => {
  holder.current?.close()
  holder.current = null
})

describe('the session telemetry row', () => {
  it('round-trips, is replaced on save, and goes on delete', () => {
    expect(sessionTelemetryRepo.get('c1')).toBeNull()
    sessionTelemetryRepo.save(telemetry('c1'))
    expect(sessionTelemetryRepo.get('c1')).toEqual(telemetry('c1'))
    sessionTelemetryRepo.save({ ...telemetry('c1'), updatedAt: 1_700_000_000_001, context: { used: 1, size: 2, sizeAuthoritative: false } })
    expect(sessionTelemetryRepo.get('c1')?.context.used).toBe(1)
    sessionTelemetryRepo.delete('c1')
    expect(sessionTelemetryRepo.get('c1')).toBeNull()
  })

  it('refuses a chat that does not exist', () => {
    expect(() => sessionTelemetryRepo.save(telemetry('gone'))).toThrow(/FOREIGN KEY/)
  })
})

describe('an assistant row’s telemetry', () => {
  it('is saved with the row and read back with the chat’s messages', () => {
    const message: MessageTelemetry = { model: 'claude-sonnet-5[1m]', tokens: { input: 15, output: 320, cacheRead: 38_000, cacheWrite: 2_400 },
      tokenScope: 'turn', costUsd: 0.04, costSource: 'runtime', durationMs: 1_500, contextUsedAfter: 16_400 }
    messageRepo.saveAssistant({ chatId: 'c1', content: 'without' })
    messageRepo.saveAssistant({ chatId: 'c1', content: 'with', telemetry: message })
    expect(chatRepo.listMessages('c1').map((row) => [row.content, row.telemetry])).toEqual([['without', null], ['with', message]])
  })
})
