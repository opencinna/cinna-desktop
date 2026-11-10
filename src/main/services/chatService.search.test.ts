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
vi.mock('./chatModeService', async (importOriginal) => {
  const real = await importOriginal<typeof import('./chatModeService')>()
  return {
    chatModeService: {
      ...real.chatModeService,
      findMerged: (id: string) => (id === 'research-mode' ? { id, name: 'Research', colorPreset: 'violet' } : null)
    }
  }
})

const DEFAULT = '__default__'
const PROFILE = 'profile-1'
const OTHER = 'profile-2'
const { chatService } = await import('./chatService')
const { chatRepo } = await import('../db/chats')
const { appSettingsRepo } = await import('../db/appSettings')
const { messages } = await import('../db/schema')
const { CHAT_SEARCH_PER_CHAT } = await import('../../shared/chatSearch')
const { messageRepo } = await import('../db/messages')
const { runAllMigrations } = await import('../db/migrations')

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

function seedAgent(id: string, name: string, userId = DEFAULT): void {
  holder.current!.raw.prepare(
    `INSERT INTO agents (id, user_id, name, protocol, enabled, source, driver, created_at)
     VALUES (?, ?, ?, 'a2a', 1, 'local', NULL, ?)`
  ).run(id, userId, name, Date.now())
}

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

  it('folds Cyrillic, Greek and accented letters, through the index and the short-query scan', () => {
    const russian = chatRepo.create(DEFAULT, { title: 'Russian' })
    say(russian.id, 'user', 'Привет, как дела?', 1)
    const greek = chatRepo.create(DEFAULT, { title: 'Greek' })
    say(greek.id, 'assistant', 'Ωραία ΜΈΡΑ σήμερα', 2)
    const french = chatRepo.create(DEFAULT, { title: 'French' })
    say(french.id, 'user', 'Une ÉCOLE à Paris', 3)

    // Three characters or more: the trigram index.
    expect(chatIds(DEFAULT, 'привет')).toEqual([russian.id])
    expect(chatIds(DEFAULT, 'ПРИВЕТ, КАК')).toEqual([russian.id])
    expect(chatIds(DEFAULT, 'ωραία μέρα')).toEqual([greek.id])
    expect(chatIds(DEFAULT, 'école')).toEqual([french.id])
    // One or two characters: the scan, folded the same way.
    expect(chatIds(DEFAULT, 'пр')).toEqual([russian.id])
    expect(chatIds(DEFAULT, 'ω')).toEqual([greek.id])
    expect(chatIds(DEFAULT, 'éc')).toEqual([french.id])
    // Diacritics are kept, as the renderer keeps them.
    expect(chatIds(DEFAULT, 'ecole')).toEqual([])
    expect(chatIds(DEFAULT, 'ec')).toEqual([])
  })

  it('takes quotes, *, %, _, ( and FTS5 operators literally in a long query', () => {
    const quoted = chatRepo.create(DEFAULT, { title: 'Quoted' })
    say(quoted.id, 'user', 'she said "hello there" twice', 1)
    const star = chatRepo.create(DEFAULT, { title: 'Star' })
    say(star.id, 'assistant', 'glob is src/*.ts here', 2)
    const percent = chatRepo.create(DEFAULT, { title: 'Percent' })
    say(percent.id, 'user', 'up 50% now', 3)
    const underscore = chatRepo.create(DEFAULT, { title: 'Underscore' })
    say(underscore.id, 'user', 'set max_id first', 4)
    const call = chatRepo.create(DEFAULT, { title: 'Call' })
    say(call.id, 'assistant', 'call f(x) AND NOT g:y', 5)
    const decoy = chatRepo.create(DEFAULT, { title: 'Decoy' })
    say(decoy.id, 'user', 'hello there src/a.ts up 50 now maxXid f x g y AND', 6)

    expect(chatIds(DEFAULT, '"hello there"')).toEqual([quoted.id])
    expect(chatIds(DEFAULT, 'said "hel')).toEqual([quoted.id])
    expect(chatIds(DEFAULT, 'src/*.ts')).toEqual([star.id])
    expect(chatIds(DEFAULT, '50% n')).toEqual([percent.id])
    expect(chatIds(DEFAULT, 'max_id')).toEqual([underscore.id])
    expect(chatIds(DEFAULT, 'f(x)')).toEqual([call.id])
    expect(chatIds(DEFAULT, 'and not g:y')).toEqual([call.id])
    expect(chatIds(DEFAULT, '(x')).toEqual([call.id])
    expect(chatIds(DEFAULT, '"')).toEqual([quoted.id])
    // A NUL (FTS5 rejects it in a phrase) finds nothing rather than throwing.
    expect(chatIds(DEFAULT, 'hello\u0000there')).toEqual([])
    expect(chatIds(DEFAULT, 'he\u0000')).toEqual([])
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

  describe('with a filter', () => {
    /** One chat per "who", each with a match: two agents, a mode, and nobody. */
    function seedWhos(): Record<'research' | 'writer' | 'mode' | 'none', string> {
      seedAgent('a-research', 'Research Agent')
      seedAgent('a-writer', 'Writer')
      const research = chatRepo.create(DEFAULT, { title: 'Research chat', agentId: 'a-research' })
      say(research.id, 'user', 'the needle for research', 1)
      const writer = chatRepo.create(DEFAULT, { title: 'Writer chat', agentId: 'a-writer' })
      say(writer.id, 'assistant', 'the needle for writing', 2)
      const mode = chatRepo.create(DEFAULT, { title: 'Mode chat', modeId: 'research-mode' })
      say(mode.id, 'user', 'the needle in a mode', 3)
      const none = chatRepo.create(DEFAULT, { title: 'Plain chat' })
      say(none.id, 'user', 'the needle with nobody', 4)
      return { research: research.id, writer: writer.id, mode: mode.id, none: none.id }
    }
    const found = (filter: unknown): string[] => chatService.search(DEFAULT, 'needle', filter).groups.map((g) => g.title)

    it('limits the results to the given agents, modes or nobody, as the Chats list groups them', () => {
      seedWhos()
      expect(found(undefined)).toEqual(['Plain chat', 'Mode chat', 'Writer chat', 'Research chat'])
      expect(found({ agentIds: ['a-writer'] })).toEqual(['Writer chat'])
      expect(found({ agentIds: ['a-writer', 'a-research'] })).toEqual(['Writer chat', 'Research chat'])
      expect(found({ modeIds: ['research-mode'] })).toEqual(['Mode chat'])
      expect(found({ none: true })).toEqual(['Plain chat'])
      expect(found({ agentIds: ['a-research'], modeIds: ['research-mode'] })).toEqual(['Mode chat', 'Research chat'])
      // An empty filter limits nothing; an agent with no chat finds nothing.
      expect(found({ agentIds: [], modeIds: [] })).toHaveLength(4)
      expect(found({ agentIds: ['a-gone'] })).toEqual([])
    })

    it('keeps the 50-chat limit within the filtered chats', () => {
      seedAgent('a-writer', 'Writer')
      for (let k = 0; k < 52; k++) {
        const chat = chatRepo.create(DEFAULT, { title: `Writer ${k}`, agentId: 'a-writer' })
        say(chat.id, 'user', 'needle', k)
      }
      const other = chatRepo.create(DEFAULT, { title: 'Other' })
      say(other.id, 'user', 'needle', 59)
      const result = chatService.search(DEFAULT, 'needle', { agentIds: ['a-writer'] })
      expect(result.truncated).toBe(true)
      expect(result.groups).toHaveLength(50)
      expect(result.groups.every((g) => g.title.startsWith('Writer'))).toBe(true)
      expect(chatService.search(DEFAULT, 'needle', { none: true })).toMatchObject({ truncated: false, groups: [{ title: 'Other' }] })
    })

    it('refuses a filter that is not one', () => {
      expect(() => chatService.search(DEFAULT, 'needle', 'agent:a')).toThrow('Invalid search filter.')
      expect(() => chatService.search(DEFAULT, 'needle', { agentIds: 'a' })).toThrow('Invalid search filter.')
      expect(() => chatService.search(DEFAULT, 'needle', { agentIds: [1] })).toThrow('Invalid search filter.')
      expect(() => chatService.search(DEFAULT, 'needle', { none: 'yes' })).toThrow('Invalid search filter.')
    })
  })
})

describe('the search index', () => {
  it('follows an insert, a draft rewritten in place, a deleted message and a deleted chat', () => {
    const chat = chatRepo.create(DEFAULT, { title: 'Draft' })
    const draft = say(chat.id, 'assistant', 'Первый черновик', 1)
    expect(chatIds(DEFAULT, 'черновик')).toEqual([chat.id])

    messageRepo.updateAssistantParts(draft, 'Окончательный ответ', [])
    expect(chatIds(DEFAULT, 'черновик')).toEqual([])
    expect(chatIds(DEFAULT, 'окончательный')).toEqual([chat.id])

    messageRepo.deleteById(draft)
    expect(chatIds(DEFAULT, 'окончательный')).toEqual([])

    const doomed = chatRepo.create(DEFAULT, { title: 'Doomed' })
    say(doomed.id, 'user', 'cascade target', 2)
    expect(chatIds(DEFAULT, 'cascade')).toEqual([doomed.id])
    expect(chatRepo.permanentDelete(DEFAULT, doomed.id)).toBe(true)
    expect(holder.current!.raw.prepare('SELECT COUNT(*) AS n FROM messages').get()).toEqual({ n: 0 })
    // Nothing left behind: the cascade fired the delete trigger.
    expect(holder.current!.raw.prepare("SELECT COUNT(*) AS n FROM messages_search WHERE messages_search MATCH '\"cascade\"'").get()).toEqual({ n: 0 })
  })

  it('never indexes tool, error or notice rows, nor a row whose role changes away from user/assistant', () => {
    const chat = chatRepo.create(DEFAULT, { title: 'Roles' })
    say(chat.id, 'tool_call', 'needle in a tool result', 1)
    say(chat.id, 'error', 'needle in an error', 2)
    const reply = say(chat.id, 'assistant', 'needle in the reply', 3)
    const indexed = (): unknown => holder.current!.raw.prepare('SELECT COUNT(*) AS n FROM messages_search').get()
    expect(indexed()).toEqual({ n: 1 })
    expect(chatService.search(DEFAULT, 'needle').groups[0].messages.map((m) => m.id)).toEqual([reply])

    holder.current!.raw.prepare("UPDATE messages SET role = 'error' WHERE id = ?").run(reply)
    expect(indexed()).toEqual({ n: 0 })
    expect(chatIds(DEFAULT, 'needle')).toEqual([])
    holder.current!.raw.prepare("UPDATE messages SET role = 'assistant' WHERE id = ?").run(reply)
    expect(chatIds(DEFAULT, 'needle')).toEqual([chat.id])
  })

  it('is filled from the messages already there when the migration creates it, and a rerun changes nothing', () => {
    const chat = chatRepo.create(DEFAULT, { title: 'Before' })
    say(chat.id, 'user', 'Старое сообщение', 1)
    say(chat.id, 'tool_call', 'старое из инструмента', 2)
    const raw = holder.current!.raw
    // An install from before the index: no table, no triggers.
    raw.exec('DROP TRIGGER messages_search_ai; DROP TRIGGER messages_search_ad; DROP TRIGGER messages_search_au; DROP TABLE messages_search')
    say(chat.id, 'assistant', 'Ещё одно старое', 3)

    runAllMigrations(holder.current!.sqlite)
    expect(chatService.search(DEFAULT, 'старое').groups[0].total).toBe(2)

    runAllMigrations(holder.current!.sqlite)
    expect(raw.prepare('SELECT COUNT(*) AS n FROM messages_search').get()).toEqual({ n: 2 })
    expect(chatService.search(DEFAULT, 'старое').groups[0].total).toBe(2)
    say(chat.id, 'user', 'и новое старое', 4)
    expect(chatService.search(DEFAULT, 'старое').groups[0].total).toBe(3)
  })
})
