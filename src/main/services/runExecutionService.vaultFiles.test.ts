import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createTestDatabase, type TestDatabase } from '../db/testSupport/nodeSqlite'
import type { AgentRow } from '../db/agents'
import type { MessageAttachment } from '../../shared/attachments'

/**
 * D23 for attachments, at the turn: a vault chat's attachment copies are
 * discarded however the agent turn ends — not only after the driver ran, but
 * when it returns early (no such agent) or throws before reaching the driver
 * (the send could not be prepared).
 */

const holder = vi.hoisted(() => ({ current: null as TestDatabase | null }))
const discarded = vi.hoisted(() => ({ calls: [] as unknown[][] }))
const agentPresent = vi.hoisted(() => ({ value: false }))
const prepareThrows = vi.hoisted(() => ({ value: false }))

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
vi.mock('../index', () => ({ getMainWindow: () => null }))
vi.mock('./cinnaApiService', () => ({ getCinnaServerUrl: () => null, cinnaApiService: {} }))
vi.mock('./syncService', () => ({ syncService: { markDirty: () => undefined } }))
vi.mock('./chatTitleService', () => ({ chatTitleService: { autoGenerateForFirstMessage: async () => undefined } }))
vi.mock('../logger/logger', () => ({
  createLogger: () => ({ debug: () => {}, info: () => {}, warn: () => {}, error: () => {} })
}))
vi.mock('../vault/vaultChatFiles', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../vault/vaultChatFiles')>()),
  discardVaultChatFiles: async (...args: unknown[]) => { discarded.calls.push(args) }
}))

const AGENT = 'remote:agent-1'
const agentRow = {
  id: AGENT, userId: '__default__', name: 'Research', protocol: 'a2a', source: 'remote', driver: 'a2a',
  cardUrl: 'https://agent.test/a2a', endpointUrl: 'https://agent.test/a2a/', protocolInterfaceUrl: null,
  accessTokenEncrypted: null, driverConfig: null
} as unknown as AgentRow
vi.mock('./agentService', () => ({
  agentService: {
    findAgent: (_s: string, _p: string, id: string) => (agentPresent.value && id === 'remote:agent-1' ? { row: agentRow, userId: '__default__' } : null),
    listMerged: () => [agentRow]
  }
}))
vi.mock('./messageRoutingService', async (importOriginal) => {
  const real = await importOriginal<typeof import('./messageRoutingService')>()
  return {
    ...real,
    messageRoutingService: new Proxy(real.messageRoutingService, {
      get(target, key, receiver) {
        if (key === 'prepareAgentSend' && prepareThrows.value) return () => { throw new Error('could not prepare the send') }
        return Reflect.get(target, key, receiver)
      }
    })
  }
})

const { chatRepo } = await import('../db/chats')
const { runExecutionService } = await import('./runExecutionService')

const USER = '__default__'
const scope = { profileUserId: USER, settingsUserId: USER }
const attachments: MessageAttachment[] = [{ id: 'file-1', filename: 'notes.txt', size: 5, mimeType: 'text/plain', source: 'local' }]
let chatId = ''

beforeEach(() => {
  holder.current = createTestDatabase()
  holder.current.raw.prepare("INSERT INTO agents (id, user_id, name, protocol, source, created_at) VALUES (?, ?, 'Research', 'a2a', 'remote', 0)").run(AGENT, USER)
  chatId = chatRepo.create(USER).id
  holder.current.raw.prepare('UPDATE chats SET agent_id = ? WHERE id = ?').run(AGENT, chatId)
  discarded.calls = []
  agentPresent.value = false
  prepareThrows.value = false
})

afterEach(() => {
  holder.current?.close()
  holder.current = null
})

describe('a vault chat turn that never reaches its driver', () => {
  it('discards the attachment copies when the agent is not found', async () => {
    const handle = runExecutionService.start(scope, { chatId, content: 'Read this', addressedAgentId: AGENT, attachments }, { observe: () => {} })
    await handle.completed.catch(() => {})
    await vi.waitFor(() => expect(discarded.calls).toEqual([[USER, chatId, attachments]]))
  })

  it('discards them when the send cannot be prepared', async () => {
    agentPresent.value = true
    prepareThrows.value = true
    const handle = runExecutionService.start(scope, { chatId, content: 'Read this', addressedAgentId: AGENT, attachments }, { observe: () => {} })
    await handle.completed.catch(() => {})
    await vi.waitFor(() => expect(discarded.calls).toEqual([[USER, chatId, attachments]]))
  })
})
