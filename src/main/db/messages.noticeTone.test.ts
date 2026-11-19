import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createTestDatabase, type TestDatabase } from './testSupport/nodeSqlite'

/**
 * A warning notice keeps its tone on the `agent_transition` row it is saved
 * as — in the existing `parts` column, no migration — through SQLite and
 * through a vault chat's transcript journal (written, closed, read back). An
 * info notice keeps the row exactly as before: no parts.
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
vi.mock('../logger/logger', () => ({
  createLogger: () => ({ debug: () => {}, info: () => {}, warn: () => {}, error: () => {} }),
  setLogValueRedactor: () => {}
}))
vi.mock('../services/jobService', () => ({ jobService: { reportRunCompletion: () => {} } }))

const { chatRepo } = await import('./chats')
const { messageRepo } = await import('./messages')
const { agentRepo } = await import('./agents')
const { vaultTranscripts, memoryTranscriptSink } = await import('../vault/transcriptStore')
const { resetVaultAgentsForTest } = await import('../vault/isVaultAgent')
const { vaultService } = await import('../vault/vaultService')

const USER = '__default__'
const AGENT = 'folder:11111111-2222-3333-4444-555555555555'
const WARNING = 'Gemini answered an error (503): The model is currently unreachable.'

beforeEach(() => {
  holder.current = createTestDatabase()
  vaultTranscripts.resetForTest()
  vaultService.resetForTest()
  resetVaultAgentsForTest()
})

afterEach(() => {
  vaultTranscripts.resetForTest()
  resetVaultAgentsForTest()
  holder.current?.close()
  holder.current = null
})

describe('saveTransition tone', () => {
  it('keeps a warning in parts and leaves an info row as it was (SQLite)', () => {
    const chatId = chatRepo.create(USER, {}).id
    messageRepo.saveTransition({ chatId, content: 'Starting up.', sourceAgentId: AGENT })
    messageRepo.saveTransition({ chatId, content: WARNING, sourceAgentId: AGENT, tone: 'warning' })

    const rows = chatRepo.listMessages(chatId)
    expect(rows.map((row) => row.role)).toEqual(['agent_transition', 'agent_transition'])
    expect(rows[0]).toMatchObject({ content: 'Starting up.', parts: null })
    expect(rows[1]).toMatchObject({ content: WARNING, parts: [{ kind: 'notice', text: WARNING, tone: 'warning' }] })
  })

  it('keeps a warning through a vault transcript written, locked and read back', () => {
    agentRepo.replaceFolderIndex(USER, 'root-1', [{
      id: AGENT, name: 'Payroll', description: null, localPath: '/agents/Local/payroll', remoteMetadata: {} as never, launcher: 'claude'
    }])
    expect(agentRepo.markVault(USER, AGENT, { vaultId: 'vault-tone', engine: 'antigravity' })).toBe(true)
    resetVaultAgentsForTest()
    const sink = memoryTranscriptSink()
    vaultTranscripts.installSink(sink)
    vaultTranscripts.openVault('vault-tone')
    const chatId = chatRepo.create(USER, { agentId: AGENT }).id
    vaultService.bindChat(USER, USER, chatId, AGENT)

    messageRepo.saveTransition({ chatId, content: 'Starting up.', sourceAgentId: AGENT })
    messageRepo.saveTransition({ chatId, content: WARNING, sourceAgentId: AGENT, tone: 'warning' })
    expect(holder.current!.sqlite.prepare('SELECT count(*) AS n FROM messages').get()).toEqual({ n: 0 })

    vaultTranscripts.closeVault('vault-tone')
    vaultTranscripts.openVault('vault-tone', sink.journals('vault-tone'))

    const rows = chatRepo.listMessages(chatId)
    expect(rows.map((row) => [row.content, row.parts])).toEqual([
      ['Starting up.', null],
      [WARNING, [{ kind: 'notice', text: WARNING, tone: 'warning' }]]
    ])
  })
})
