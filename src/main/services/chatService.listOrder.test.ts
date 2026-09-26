import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createTestDatabase, type TestDatabase } from '../db/testSupport/nodeSqlite'

/**
 * The sidebar's rename, Pinned block and drag order, against a real database.
 * None of them is activity: each leaves `updatedAt` alone, or the chat would
 * jump to the top of a list sorted by recency.
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
  getProfileScopeUserId: () => USER,
  getAgentLookupScope: () => ['__default__', USER]
}))
vi.mock('./chatModeService', () => ({ chatModeService: { findMerged: () => null } }))
vi.mock('./agentService', () => ({ agentService: { findAgent: () => null } }))
vi.mock('./chatConductorService', async (original) => {
  const actual = await original<typeof import('./chatConductorService')>()
  return { ...actual, chatConductorService: { remove: vi.fn(), ensure: vi.fn() } }
})
vi.mock('./conductorBridge', () => ({ conductorBridge: { refresh: async () => {} } }))

const USER = 'profile-1'

const { chatService } = await import('./chatService')

beforeEach(() => {
  holder.current = createTestDatabase()
})

afterEach(() => {
  holder.current?.close()
  holder.current = null
})

/** A chat last touched `ago` ms before now, so a bump would be visible. */
function chatAt(ago: number): string {
  const chat = chatService.create(USER)
  holder.current!.raw.prepare('UPDATE chats SET updated_at = ? WHERE id = ?').run(Math.floor((Date.now() - ago) / 1000), chat.id)
  return chat.id
}
const row = (id: string) => chatService.list(USER).find((chat) => chat.id === id)!

describe('rename', () => {
  it('trims the title and leaves updatedAt alone', () => {
    const id = chatAt(3_600_000)
    const before = row(id).updatedAt.getTime()
    chatService.rename(USER, id, '  Quarterly plan  ')
    expect(row(id).title).toBe('Quarterly plan')
    expect(row(id).updatedAt.getTime()).toBe(before)
  })

  it('refuses an empty title and another profile\'s chat', () => {
    const id = chatAt(0)
    expect(() => chatService.rename(USER, id, '   ')).toThrow('A chat needs a title.')
    expect(row(id).title).toBe('New Chat')
    expect(() => chatService.rename('another-profile', id, 'Mine')).toThrow('Chat not found')
  })
})

describe('pinning', () => {
  it('puts a newly pinned chat on top of Pinned, and unpins without touching updatedAt', () => {
    const first = chatAt(3_600_000)
    const second = chatAt(7_200_000)
    const before = row(second).updatedAt.getTime()
    expect(row(first).pinnedRank).toBeNull()
    const a = chatService.setPinned(USER, first, true)
    const b = chatService.setPinned(USER, second, true)
    expect(a).not.toBeNull()
    expect(b!).toBeGreaterThan(a!)
    expect(row(second).pinnedRank).toBe(b)
    expect(row(second).updatedAt.getTime()).toBe(before)

    // Pinned again after being dragged below: back on top.
    chatService.move(USER, first, { list: 'pinned', rank: b! - 10 })
    expect(chatService.setPinned(USER, first, true)!).toBeGreaterThan(b!)

    expect(chatService.setPinned(USER, second, false)).toBeNull()
    expect(row(second).pinnedRank).toBeNull()
    expect(row(second).updatedAt.getTime()).toBe(before)
  })

  it('ranks against the owner\'s own pins only', () => {
    const theirs = chatService.create('another-profile')
    chatService.move('another-profile', theirs.id, { list: 'chats', rank: 1 })
    chatService.setPinned('another-profile', theirs.id, true)
    chatService.move('another-profile', theirs.id, { list: 'pinned', rank: 1_000 })
    const mine = chatAt(0)
    expect(chatService.setPinned(USER, mine, true)).toBe(1)
    expect(() => chatService.setPinned('another-profile', mine, true)).toThrow('Chat not found')
  })
})

describe('move', () => {
  it('writes the sort key for the Chats list without touching updatedAt', () => {
    const id = chatAt(3_600_000)
    const before = row(id).updatedAt.getTime()
    chatService.move(USER, id, { list: 'chats', rank: 12.5 })
    expect(row(id).sortKey).toBe(12.5)
    expect(row(id).pinnedRank).toBeNull()
    expect(row(id).updatedAt.getTime()).toBe(before)
  })

  it('refuses a rank that is not a finite number', () => {
    const id = chatAt(0)
    for (const rank of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, '5', null]) {
      expect(() => chatService.move(USER, id, { list: 'chats', rank })).toThrow('A chat moves to a finite rank.')
    }
    expect(row(id).sortKey).toBeNull()
  })

  it('moves inside Pinned only a pinned chat, and never pins one', () => {
    const id = chatAt(0)
    expect(() => chatService.move(USER, id, { list: 'pinned', rank: 3 })).toThrow('Only a pinned chat moves inside Pinned.')
    expect(row(id).pinnedRank).toBeNull()
    chatService.setPinned(USER, id, true)
    chatService.move(USER, id, { list: 'pinned', rank: 0.5 })
    expect(row(id).pinnedRank).toBe(0.5)
    expect(row(id).sortKey).toBeNull()
  })

  it('refuses an unknown list and another profile\'s chat', () => {
    const id = chatAt(0)
    expect(() => chatService.move(USER, id, { list: 'jobs', rank: 1 })).toThrow('Unknown chat list: jobs')
    expect(() => chatService.move('another-profile', id, { list: 'chats', rank: 1 })).toThrow('Chat not found')
  })
})
