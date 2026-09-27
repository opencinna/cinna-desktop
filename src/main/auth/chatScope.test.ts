import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createTestDatabase, type TestDatabase } from '../db/testSupport/nodeSqlite'

/**
 * Which chats a profile sees, and who owns one — against a real database.
 *
 * The default (signed-out) profile's chats are shared with every profile while
 * `showLocalDataInAllProfiles` is on (the default); the default profile only
 * ever sees its own, and with the setting off every profile sees only its own.
 */

const holder = vi.hoisted(() => ({ current: null as TestDatabase | null, profile: '__default__' }))

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
vi.mock('./scope', () => ({ getProfileScopeUserId: () => holder.profile }))

const { chatOwnerFor, chatScopesFor, getChatScopes, resolveChatOwner, visibleChat, visibleChatFile } = await import('./chatScope')
const { appSettingsRepo } = await import('../db/appSettings')

const DEFAULT = '__default__'
const PROFILE = 'profile-1'
const OTHER = 'profile-2'

beforeEach(() => {
  holder.current = createTestDatabase()
  holder.profile = DEFAULT
  const insert = holder.current.raw.prepare(
    'INSERT INTO chats (id, user_id, title, deleted_at, created_at, updated_at) VALUES (?, ?, ?, ?, 1, 1)'
  )
  insert.run('local-chat', DEFAULT, 'Signed out', null)
  insert.run('local-trashed', DEFAULT, 'Signed out, trashed', 5)
  insert.run('profile-chat', PROFILE, 'Signed in', null)
  insert.run('other-chat', OTHER, 'Someone else', null)
  holder.current.raw.prepare(
    `INSERT INTO chat_files (id, user_id, chat_id, storage_path, mime_type, size, filename, created_at)
     VALUES (?, ?, ?, '/x', 'text/plain', 1, 'a.txt', 1)`
  ).run('local-file', DEFAULT, 'local-chat')
})

afterEach(() => {
  holder.current?.close()
  holder.current = null
})

describe('with local data shown in all profiles (the default)', () => {
  it('lets a signed-in profile see the default profile\'s chats, live or trashed, as the default profile\'s', () => {
    holder.profile = PROFILE
    expect(getChatScopes()).toEqual([PROFILE, DEFAULT])
    expect(resolveChatOwner('local-chat')).toBe(DEFAULT)
    expect(resolveChatOwner('local-trashed')).toBe(DEFAULT)
    expect(visibleChat(PROFILE, 'local-chat')?.userId).toBe(DEFAULT)
    expect(resolveChatOwner('profile-chat')).toBe(PROFILE)
    expect(visibleChatFile(PROFILE, 'local-file')?.chatId).toBe('local-chat')
  })

  it('keeps another profile\'s chats out of sight, and resolves an unknown chat to the profile', () => {
    expect(visibleChat(PROFILE, 'other-chat')).toBeUndefined()
    expect(chatOwnerFor(PROFILE, 'other-chat')).toBe(PROFILE)
    expect(chatOwnerFor(PROFILE, 'no-such-chat')).toBe(PROFILE)
  })

  it('never shows a profile\'s chats in the default profile', () => {
    expect(getChatScopes()).toEqual([DEFAULT])
    expect(visibleChat(DEFAULT, 'profile-chat')).toBeUndefined()
    expect(chatOwnerFor(DEFAULT, 'profile-chat')).toBe(DEFAULT)
    expect(visibleChat(DEFAULT, 'local-chat')?.id).toBe('local-chat')
  })
})

describe('with local data kept in its own profile', () => {
  beforeEach(() => appSettingsRepo.set('showLocalDataInAllProfiles', false))

  it('leaves each profile with exactly its own chats', () => {
    expect(chatScopesFor(PROFILE)).toEqual([PROFILE])
    expect(visibleChat(PROFILE, 'local-chat')).toBeUndefined()
    expect(chatOwnerFor(PROFILE, 'local-chat')).toBe(PROFILE)
    expect(chatOwnerFor(PROFILE, 'local-trashed')).toBe(PROFILE)
    expect(visibleChatFile(PROFILE, 'local-file')).toBeUndefined()
    expect(visibleChat(PROFILE, 'profile-chat')?.id).toBe('profile-chat')
    expect(chatScopesFor(DEFAULT)).toEqual([DEFAULT])
    expect(visibleChat(DEFAULT, 'local-chat')?.id).toBe('local-chat')
  })
})
