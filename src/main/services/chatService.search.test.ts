import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createTestDatabase, type TestDatabase } from '../db/testSupport/nodeSqlite'

/**
 * All-chats search (`chat:search`), against a real database: exactly the
 * chats the Chats list shows the profile, in their user and assistant words,
 * with the pattern characters taken literally.
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
vi.mock('./agentService', () => ({ agentService: { findAgent: () => null } }))
vi.mock('./conductorBridge', () => ({ conductorBridge: { refresh: async () => {} } }))

const DEFAULT = '__default__'
const PROFILE = 'profile-1'
const OTHER = 'profile-2'
const { chatService } = await import('./chatService')
const { chatRepo } = await import('../db/chats')
const { appSettingsRepo } = await import('../db/appSettings')
const { messages } = await import('../db/schema')
const { CHAT_SEARCH_PER_CHAT } = await import('../../shared/chatSearch')

let order = 0
/** A message at `minute` minutes past a fixed hour: later minute, newer message. */
function say(chatId: string, role: string, content: string, minute: number): string {
  const id = `m-${++order}`
  holder.current!.db.insert(messages)
    .values({ id, chatId, role, content, sortOrder: order, createdAt: new Date(2026, 9, 1, 9, minute) })
    .run()
  return id
}

const chatIds = (userId: string, query: string): string[] =>
  chatService.search(userId, query).groups.map((group) => group.chatId)

beforeEach(() => {
  holder.current = createTestDatabase()
  order = 0
})
afterEach(() => {
  holder.current?.close()
  holder.current = null
})

describe('chatService.search', () => {
  it('finds a word whatever its case, and nothing for a blank query', () => {
    const chat = chatRepo.create(DEFAULT, { title: 'Billing' })
    say(chat.id, 'user', 'Please RECONCILE the invoices', 1)
    expect(chatIds(DEFAULT, 'reconcile')).toEqual([chat.id])
    expect(chatIds(DEFAULT, 'Reconcile')).toEqual([chat.id])
    expect(chatIds(DEFAULT, '   ')).toEqual([])
  })

  it('takes %, _ and \\ literally', () => {
    const percent = chatRepo.create(DEFAULT, { title: 'Percent' })
    say(percent.id, 'user', 'growth was 50% this year', 1)
    const underscore = chatRepo.create(DEFAULT, { title: 'Underscore' })
    say(underscore.id, 'assistant', 'the column is last_id', 2)
    const backslash = chatRepo.create(DEFAULT, { title: 'Backslash' })
    say(backslash.id, 'assistant', 'the path is C:\\temp', 3)
    // Would match everything (or "lastXid", "C:temp") if the pattern were not escaped.
    const decoy = chatRepo.create(DEFAULT, { title: 'Decoy' })
    say(decoy.id, 'user', 'growth was 50 this year, lastXid, C:temp', 4)

    expect(chatIds(DEFAULT, '50%')).toEqual([percent.id])
    expect(chatIds(DEFAULT, '%')).toEqual([percent.id])
    expect(chatIds(DEFAULT, 'last_id')).toEqual([underscore.id])
    expect(chatIds(DEFAULT, '_')).toEqual([underscore.id])
    expect(chatIds(DEFAULT, 'C:\\temp')).toEqual([backslash.id])
  })

  it('reads only user and assistant messages', () => {
    const chat = chatRepo.create(DEFAULT, { title: 'Tools' })
    say(chat.id, 'tool_call', 'needle in a tool result', 1)
    say(chat.id, 'error', 'needle in an error', 2)
    say(chat.id, 'system', 'needle in a system turn', 3)
    say(chat.id, 'agent_transition', 'needle in a notice', 4)
    expect(chatIds(DEFAULT, 'needle')).toEqual([])
    const reply = say(chat.id, 'assistant', 'a needle in the reply', 5)
    const result = chatService.search(DEFAULT, 'needle')
    expect(result.groups.map((group) => group.messages.map((message) => message.id))).toEqual([[reply]])
    expect(result.groups[0].total).toBe(1)
  })

  it('searches only the chats the Chats list shows', () => {
    const listed = chatRepo.create(DEFAULT, { title: 'Listed' })
    say(listed.id, 'user', 'deploy the thing', 1)
    const trashed = chatRepo.create(DEFAULT, { title: 'Trashed' })
    say(trashed.id, 'user', 'deploy from the trash', 2)
    chatRepo.softDelete(DEFAULT, trashed.id)
    const hidden = chatRepo.create(DEFAULT, { title: 'Task chat', hiddenFromList: true })
    say(hidden.id, 'user', 'deploy from a task', 3)

    expect(chatIds(DEFAULT, 'deploy')).toEqual([listed.id])
    expect(chatService.list(DEFAULT).map((chat) => chat.id)).toEqual([listed.id])
  })

  it("keeps to the profile's scope, as the list does", () => {
    const own = chatRepo.create(PROFILE, { title: 'Own' })
    say(own.id, 'user', 'shared word', 1)
    const computer = chatRepo.create(DEFAULT, { title: "The computer's" })
    say(computer.id, 'user', 'shared word', 2)
    const stranger = chatRepo.create(OTHER, { title: "Another profile's" })
    say(stranger.id, 'user', 'shared word', 3)

    // Local data shown in every profile (the default): the profile's own and the computer's.
    expect(chatIds(PROFILE, 'shared').sort()).toEqual([own.id, computer.id].sort())
    appSettingsRepo.set('showLocalDataInAllProfiles', false)
    expect(chatIds(PROFILE, 'shared')).toEqual([own.id])
    expect(chatIds(DEFAULT, 'shared')).toEqual([computer.id])
    for (const userId of [PROFILE, DEFAULT, OTHER]) {
      const listedIds = new Set(chatService.list(userId).map((chat) => chat.id))
      expect(chatIds(userId, 'shared').every((id) => listedIds.has(id))).toBe(true)
    }
  })

  it('orders chats by their newest match, not by their last message', () => {
    const early = chatRepo.create(DEFAULT, { title: 'Early match, busy since' })
    say(early.id, 'user', 'retry the batch', 1)
    say(early.id, 'assistant', 'unrelated and recent', 50)
    const late = chatRepo.create(DEFAULT, { title: 'Late match' })
    say(late.id, 'assistant', 'retry later', 20)
    const middle = chatRepo.create(DEFAULT, { title: 'Middle match' })
    say(middle.id, 'user', 'a retry policy', 10)

    const groups = chatService.search(DEFAULT, 'retry').groups
    expect(groups.map((group) => group.title)).toEqual(['Late match', 'Middle match', 'Early match, busy since'])
    expect(groups[0].latestAt).toEqual(new Date(2026, 9, 1, 9, 20))
  })

  it(`returns at most ${CHAT_SEARCH_PER_CHAT} messages per chat, newest first, with the true total`, () => {
    const chat = chatRepo.create(DEFAULT, { title: 'Long' })
    const ids = [1, 2, 3, 4, 5].map((minute) => say(chat.id, minute % 2 ? 'user' : 'assistant', `invoice number ${minute}`, minute))
    say(chat.id, 'user', 'nothing to see', 6)

    const [group] = chatService.search(DEFAULT, 'invoice').groups
    expect(group.total).toBe(5)
    expect(group.messages.map((message) => message.id)).toEqual([ids[4], ids[3], ids[2]])
    expect(group.messages.map((message) => message.role)).toEqual(['user', 'assistant', 'user'])
    expect(group.messages[0].content).toBe('invoice number 5')
  })

  it('refuses a query that is not text', () => {
    expect(() => chatService.search(DEFAULT, 42)).toThrow('Search needs some text.')
  })
})
