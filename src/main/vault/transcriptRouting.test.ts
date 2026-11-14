import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createTestDatabase, type TestDatabase } from '../db/testSupport/nodeSqlite'
import type { MessagePart } from '../../shared/messageParts'
import type { RunEvent } from '../../shared/runEvents'

/**
 * D23 / D30: a vault chat leaves no content on the host. Driven through the
 * real repository entry points (and one real turn through the direct-chat
 * wrapper) against a real database: the `messages`, `messages_search` and
 * `inflight_turns` tables stay empty while every read returns the rows, the
 * journal gets them (drafts excepted), a lock drops them and an unlock
 * rebuilds them. No title is generated, no Inbox task is made, and no log
 * line carries a word of the chat.
 */

const holder = vi.hoisted(() => ({ current: null as TestDatabase | null }))
const logged = vi.hoisted(() => [] as string[])

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
vi.mock('../logger/logger', () => {
  const record = (...args: unknown[]): void => { logged.push(JSON.stringify(args)) }
  return {
    createLogger: () => ({ debug: record, info: record, warn: record, error: record }),
    setLogValueRedactor: () => {}
  }
})
vi.mock('../services/jobService', () => ({ jobService: { reportRunCompletion: () => {} } }))

const { chatRepo } = await import('../db/chats')
const { messageRepo } = await import('../db/messages')
const { inflightTurnRepo } = await import('../db/inflightTurns')
const { agentRepo } = await import('../db/agents')
const { appSettingsRepo } = await import('../db/appSettings')
const { taskRepo } = await import('../db/tasks')
const { vaultTranscripts, memoryTranscriptSink, VaultTranscriptLocked } = await import('./transcriptStore')
const { resetVaultAgentsForTest, isVaultAgent } = await import('./isVaultAgent')
const { vaultService, stubTitle } = await import('./vaultService')
const { chatTitleService, ChatTitleError } = await import('../services/chatTitleService')
const { inboxService } = await import('../services/inboxService')
const { a2aStreamingService } = await import('../services/a2aStreamingService')

const USER = '__default__'
const AGENT = 'folder:11111111-2222-3333-4444-555555555555'
const VAULT = 'vault-d23'
/** Appears in every piece of content written; must never reach SQLite or a log line. */
const SECRET = 'ZEBRA-7731-SECRET'

let chatId = ''
let sink: ReturnType<typeof memoryTranscriptSink>

const text = (value: string): MessagePart => ({ kind: 'text', text: value }) as MessagePart

function count(sql: string, ...params: unknown[]): number {
  return (holder.current!.sqlite.prepare(sql).get(...(params as never[])) as { n: number }).n
}

function hostTablesEmpty(): void {
  expect(count('SELECT count(*) AS n FROM messages')).toBe(0)
  expect(count('SELECT count(*) AS n FROM messages_search')).toBe(0)
  expect(count('SELECT count(*) AS n FROM inflight_turns')).toBe(0)
  // Nothing anywhere in the database carries the content.
  const dump = JSON.stringify(holder.current!.sqlite.prepare(
    "SELECT group_concat(name) AS names FROM sqlite_master WHERE type = 'table'").get())
  expect(dump).not.toContain(SECRET)
  for (const table of ['chats', 'tasks', 'task_input_requests', 'agents']) {
    expect(JSON.stringify(holder.current!.sqlite.prepare(`SELECT * FROM ${table}`).all())).not.toContain(SECRET)
  }
}

beforeEach(() => {
  holder.current = createTestDatabase()
  logged.length = 0
  vaultTranscripts.resetForTest()
  vaultService.resetForTest()
  sink = memoryTranscriptSink()
  vaultTranscripts.installSink(sink)
  // A folder agent, moved into a vault.
  agentRepo.replaceFolderIndex(USER, 'root-1', [{
    id: AGENT, name: 'Payroll', description: null, localPath: '/agents/Local/payroll', remoteMetadata: {} as never, launcher: 'claude'
  }])
  expect(agentRepo.markVault(USER, AGENT, { vaultId: VAULT, engine: 'claude' })).toBe(true)
  resetVaultAgentsForTest()
  expect(isVaultAgent(AGENT)).toBe(true)
  vaultTranscripts.openVault(VAULT)
  chatId = chatRepo.create(USER, { agentId: AGENT }).id
  vaultService.bindChat(USER, USER, chatId, AGENT)
})

afterEach(() => {
  vaultTranscripts.resetForTest()
  resetVaultAgentsForTest()
  holder.current?.close()
  holder.current = null
})

describe('a vault chat (D23, D30)', () => {
  it('is a stub on the host titled "<agent> · <date>"', () => {
    const chat = chatRepo.getOwned(USER, chatId)!
    expect(chat.vaultId).toBe(VAULT)
    expect(chat.title).toBe(stubTitle('Payroll'))
    expect(chat.title).toMatch(/^Payroll · \d{1,2} \w{3} \d{4}$/)
  })

  it('keeps every row off SQLite through the repository entry points, and reads them back', () => {
    const userId = messageRepo.saveUser({ chatId, content: `user ${SECRET}`, addressedAgentId: AGENT })
    messageRepo.saveSystem({ chatId, content: `system ${SECRET}` })
    const assistantId = messageRepo.saveAssistant({ chatId, content: `answer ${SECRET}`, parts: [text(SECRET)], sourceAgentId: AGENT })
    messageRepo.updateAssistantParts(assistantId, `edited ${SECRET}`, [text(`edited ${SECRET}`)])
    messageRepo.updateAssistantTelemetry(assistantId, { tokens: { input: 1, output: 2 } } as never)
    messageRepo.saveToolCall({ chatId, content: SECRET, toolCallId: 't1', toolName: 'read', toolInput: { path: SECRET }, toolError: false })
    messageRepo.saveTransition({ chatId, content: `transition ${SECRET}`, sourceAgentId: AGENT })
    messageRepo.saveError({ chatId, short: `error ${SECRET}` })
    messageRepo.insertRaw({ id: 'raw-1', chatId, role: 'assistant', content: SECRET, toolCallId: null, toolName: null, toolInput: null })
    messageRepo.deleteById('raw-1')
    messageRepo.touchChat(chatId)

    hostTablesEmpty()

    const rows = chatRepo.listMessages(chatId)
    expect(rows.map((row) => row.role)).toEqual(['user', 'system', 'assistant', 'tool_call', 'agent_transition', 'error'])
    expect(rows.map((row) => row.sortOrder)).toEqual([0, 1, 2, 3, 4, 5])
    expect(rows[2]).toMatchObject({ id: assistantId, content: `edited ${SECRET}`, telemetry: { tokens: { input: 1, output: 2 } } })
    expect(chatRepo.listMessageIds(chatId)).toEqual(rows.map((row) => row.id))
    expect(chatRepo.hasContent(chatId)).toBe(true)
    expect(messageRepo.getById(userId)?.content).toBe(`user ${SECRET}`)
    expect(messageRepo.countByRole(chatId, 'user')).toBe(1)
    expect(messageRepo.firstByRole(chatId, 'user')?.id).toBe(userId)
    expect(messageRepo.lastByRole(chatId, 'assistant')?.id).toBe(assistantId)
    expect(messageRepo.lastId(chatId)).toBe(rows.at(-1)!.id)
    expect(messageRepo.lastAddressedAgentId(chatId)).toBe(AGENT)
    expect(messageRepo.lastInboundIdBefore(chatId, Date.now() + 5000)).toBe(rows[1].id)

    // The journal has what the vault keeps.
    const journaled = JSON.stringify(sink.ops(VAULT, chatId))
    expect(journaled).toContain(`edited ${SECRET}`)
    expect(sink.ops(VAULT, chatId)).toContainEqual({ op: 'delete', table: 'messages', id: 'raw-1' })
  })

  it('keeps a turn\'s marker and draft in memory only, never journaling the draft', () => {
    const userId = messageRepo.saveUser({ chatId, content: `question ${SECRET}` })
    inflightTurnRepo.open({ id: 'turn-1', profileId: USER, chatId, agentId: AGENT, driver: 'acp', userMessageId: userId })
    let draft = inflightTurnRepo.writeDraft({ markerId: 'turn-1', draftId: null, chatId, agentId: AGENT, content: 'DRAFT-ONLY', parts: [text('DRAFT-ONLY')] })
    draft = inflightTurnRepo.writeDraft({ markerId: 'turn-1', draftId: draft, chatId, agentId: AGENT, content: 'DRAFT-ONLY 2', parts: [text('DRAFT-ONLY 2')] })
    expect(inflightTurnRepo.get('turn-1')).toMatchObject({ chatId, draftMessageId: draft })
    expect(inflightTurnRepo.listChatIds().has(chatId)).toBe(true)
    // No recovery for vault turns: the boot pass never sees the marker.
    expect(inflightTurnRepo.list()).toEqual([])
    hostTablesEmpty()

    inflightTurnRepo.replaceDraft('turn-1', draft, () => {
      messageRepo.saveAssistant({ chatId, content: `final ${SECRET}`, sourceAgentId: AGENT })
    })
    expect(inflightTurnRepo.turnRowIds({ chatId, agentId: AGENT, userMessageId: userId, draftMessageId: null })).toHaveLength(1)
    const replaced = inflightTurnRepo.replaceTurnRows({ chatId, agentId: AGENT, userMessageId: userId, draftMessageId: null,
      rows: [{ role: 'assistant', content: `recovered ${SECRET}`, parts: [] }, { role: 'error', short: 'stopped' }] })
    expect(replaced).toHaveLength(2)
    messageRepo.saveUser({ chatId, content: 'later' })
    expect(inflightTurnRepo.hasLaterUserRow({ chatId, userMessageId: userId })).toBe(true)
    expect(inflightTurnRepo.insertUnderTurn({ chatId, agentId: AGENT, userMessageId: userId, draftMessageId: null }, { short: 'cut', code: 'turn_interrupted' })).toBe(true)
    inflightTurnRepo.settle({ id: 'turn-1', chatId, agentId: AGENT }, { short: 'ended', code: 'turn_interrupted' })
    expect(inflightTurnRepo.get('turn-1')).toBeNull()

    expect(chatRepo.listMessages(chatId).map((row) => [row.role, row.role === 'error' ? JSON.parse(row.content).short : row.content])).toEqual([
      ['user', `question ${SECRET}`], ['assistant', `recovered ${SECRET}`], ['error', 'cut'], ['error', 'stopped'], ['user', 'later'], ['error', 'ended']
    ])
    hostTablesEmpty()
    expect(JSON.stringify(sink.ops(VAULT, chatId))).not.toContain('DRAFT-ONLY')
  })

  it('reads back exactly what SQLite would for the same sequence of calls', () => {
    const sequence = (target: string, markerId: string): unknown[] => {
      const userId = messageRepo.saveUser({ chatId: target, content: 'q1' })
      messageRepo.saveAssistant({ chatId: target, content: 'a1', sourceAgentId: AGENT })
      messageRepo.saveError({ chatId: target, short: 'e1' })
      inflightTurnRepo.open({ id: markerId, profileId: USER, chatId: target, agentId: AGENT, driver: 'acp', userMessageId: userId })
      const draft = inflightTurnRepo.writeDraft({ markerId, draftId: null, chatId: target, agentId: AGENT, content: 'd', parts: [] })
      messageRepo.saveUser({ chatId: target, content: 'q2' })
      inflightTurnRepo.replaceDraft(markerId, draft, () => { messageRepo.saveTransition({ chatId: target, content: 't', sourceAgentId: AGENT }) })
      inflightTurnRepo.insertUnderTurn({ chatId: target, agentId: AGENT, userMessageId: userId, draftMessageId: null }, { short: 'n', code: 'x' })
      inflightTurnRepo.replaceTurnRows({ chatId: target, agentId: AGENT, userMessageId: userId, draftMessageId: null,
        rows: [{ role: 'agent_transition', content: 'r1' }, { role: 'assistant', content: 'r2', parts: [] }] })
      inflightTurnRepo.settle({ id: markerId, chatId: target, agentId: AGENT }, { short: 'end', code: 'y' }, { under: userId })
      return chatRepo.listMessages(target).map((row) => [row.role, row.content, row.sortOrder, row.sourceAgentId])
    }
    const host = chatRepo.create(USER, {}).id
    expect(sequence(chatId, 'm-vault')).toEqual(sequence(host, 'm-host'))
    expect(count('SELECT count(*) AS n FROM messages WHERE chat_id = ?', chatId)).toBe(0)
  })

  it('runs a whole turn through the direct-chat wrapper without touching the host tables', async () => {
    const userId = messageRepo.saveUser({ chatId, content: `ask ${SECRET}` })
    const posted: RunEvent[] = []
    await a2aStreamingService.streamToAgent({
      chatId,
      agentId: AGENT,
      port: { postMessage: (event) => void posted.push(event), close: () => {} },
      marker: { profileId: USER, userMessageId: userId, driver: 'acp' },
      run: async () => ({ text: `reply ${SECRET}`, parts: [text(`reply ${SECRET}`)], notices: [] })
    })
    expect(posted.at(-1)).toMatchObject({ type: 'done' })
    expect(chatRepo.listMessages(chatId).map((row) => row.content)).toEqual([`ask ${SECRET}`, `reply ${SECRET}`])
    hostTablesEmpty()
  })

  it('drops everything on lock, refuses writes while locked, and rebuilds from the journal on unlock', () => {
    messageRepo.saveUser({ chatId, content: `kept ${SECRET}` })
    const assistantId = messageRepo.saveAssistant({ chatId, content: `kept answer ${SECRET}` })
    const before = chatRepo.listMessages(chatId)

    vaultTranscripts.closeVault(VAULT)
    expect(chatRepo.listMessages(chatId)).toEqual([])
    expect(messageRepo.getById(assistantId)).toBeUndefined()
    expect(messageRepo.firstByRole(chatId, 'user')).toBeUndefined()
    expect(() => messageRepo.saveUser({ chatId, content: `lost ${SECRET}` })).toThrow(VaultTranscriptLocked)
    expect(() => inflightTurnRepo.open({ id: 't', profileId: USER, chatId, agentId: AGENT, driver: 'acp', userMessageId: null })).toThrow(VaultTranscriptLocked)
    hostTablesEmpty()

    vaultTranscripts.openVault(VAULT, sink.journals(VAULT))
    expect(chatRepo.listMessages(chatId)).toEqual(before)
  })

  it('serves nothing of a chat a running turn kept past a lock, while that turn still finishes writing', () => {
    const userId = messageRepo.saveUser({ chatId, content: `before ${SECRET}` })
    const earlierId = messageRepo.saveAssistant({ chatId, content: `earlier ${SECRET}`, sourceAgentId: AGENT })
    inflightTurnRepo.open({ id: 'turn-kept', profileId: USER, chatId, agentId: AGENT, driver: 'acp', userMessageId: userId })
    const draft = inflightTurnRepo.writeDraft({ markerId: 'turn-kept', draftId: null, chatId, agentId: AGENT, content: 'streaming', parts: [] })

    vaultTranscripts.closeVault(VAULT)
    expect(vaultTranscripts.isDetached(chatId)).toBe(true)

    // Every read that answers the renderer gives the locked answer.
    expect(chatRepo.listMessages(chatId)).toEqual([])
    expect(chatRepo.listMessageIds(chatId)).toEqual([])
    expect(chatRepo.hasContent(chatId)).toBe(true)
    expect(messageRepo.getById(earlierId)).toBeUndefined()
    expect(messageRepo.firstByRole(chatId, 'user')).toBeUndefined()
    expect(messageRepo.lastByRole(chatId, 'assistant')).toBeUndefined()

    // The finishing turn's own writes still go through, to the journal.
    inflightTurnRepo.replaceDraft('turn-kept', draft, () => {
      messageRepo.saveAssistant({ chatId, content: `after lock ${SECRET}`, sourceAgentId: AGENT })
    })
    expect(inflightTurnRepo.hasUserRow({ chatId, userMessageId: userId })).toBe(true)
    expect(inflightTurnRepo.turnRowIds({ chatId, agentId: AGENT, userMessageId: userId, draftMessageId: null })).toHaveLength(2)
    inflightTurnRepo.settle({ id: 'turn-kept', chatId, agentId: AGENT }, { short: 'ended', code: 'turn_interrupted' }, { under: userId })
    // Its catch-up cursor lands on an id, never on content.
    expect(messageRepo.lastId(chatId)).not.toBeNull()
    expect(JSON.stringify(sink.ops(VAULT, chatId))).toContain(`after lock ${SECRET}`)
    expect(chatRepo.listMessages(chatId)).toEqual([])
    hostTablesEmpty()

    vaultTranscripts.openVault(VAULT, sink.journals(VAULT))
    expect(chatRepo.listMessages(chatId).map((row) => row.content)).toContain(`after lock ${SECRET}`)
  })

  it('never generates a title, and an engine title is ignored', async () => {
    appSettingsRepo.set('autoChatTitles', true)
    messageRepo.saveUser({ chatId, content: `title me ${SECRET}` })
    await expect(chatTitleService.autoGenerateForFirstMessage({ userId: USER, chatId })).rejects.toMatchObject({ code: 'vault_chat' })
    expect(chatTitleService.applyEngineTitle({ userId: USER, chatId, agentId: AGENT, title: `Engine ${SECRET}` })).toBe(false)
    expect(chatRepo.getOwned(USER, chatId)!.title).toBe(stubTitle('Payroll'))
    expect(ChatTitleError).toBeTruthy()
  })

  it('makes no Inbox task for an ask, so no row carries the first message', () => {
    messageRepo.saveUser({ chatId, content: `please ${SECRET}` })
    inboxService.openAsk({ userId: USER, chatId, agentId: AGENT }, { type: 'needs_input', requestId: 'r1', prompt: SECRET } as never)
    expect(taskRepo.getByChatId(USER, chatId)).toBeUndefined()
    hostTablesEmpty()
  })

  it('writes no log line that carries the chat\'s words', async () => {
    const userId = messageRepo.saveUser({ chatId, content: `log ${SECRET}` })
    await a2aStreamingService.streamToAgent({
      chatId, agentId: AGENT,
      port: { postMessage: () => {}, close: () => {} },
      marker: { profileId: USER, userMessageId: userId, driver: 'acp' },
      run: async () => ({ text: SECRET, parts: [text(SECRET)], notices: [], error: { message: `boom ${SECRET}`, raw: SECRET } })
    }).catch(() => {})
    vaultTranscripts.closeVault(VAULT)
    expect(() => messageRepo.saveAssistant({ chatId, content: SECRET })).toThrow()
    expect(logged.join('\n')).not.toContain(SECRET)
  })
})
