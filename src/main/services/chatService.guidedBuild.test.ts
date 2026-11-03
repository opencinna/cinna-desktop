import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createTestDatabase, type TestDatabase } from '../db/testSupport/nodeSqlite'

/**
 * A new chat becomes a guided first build only through `chat:update`'s
 * request, and only when main agrees: the setting is on, the chat is still
 * empty and direct, and its one agent is a local kit agent that is unbuilt
 * right now. Against a real database; the agent itself is stubbed.
 */

const holder = vi.hoisted(() => ({ current: null as TestDatabase | null }))
const agents = vi.hoisted(() => ({ byId: new Map<string, { kind: 'kit' | 'bare'; unbuilt: boolean }>() }))

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
vi.mock('./localAgents/localAgentService', () => ({
  localAgentService: {
    get: (_user: string, agentId: string) => {
      const agent = agents.byId.get(agentId)
      if (!agent) throw new Error('That agent is no longer in your agents folder.')
      return { id: agentId, ...agent }
    }
  }
}))

const USER = '__default__'
const { chatService } = await import('./chatService')
const { chatRepo } = await import('../db/chats')
const { appSettingsRepo } = await import('../db/appSettings')
const { messageRepo } = await import('../db/messages')

const guided = (chatId: string): boolean => chatRepo.getOwned(USER, chatId)!.guidedBuild

beforeEach(() => {
  holder.current = createTestDatabase()
  agents.byId = new Map([
    ['folder:blank', { kind: 'kit', unbuilt: true }],
    ['folder:built', { kind: 'kit', unbuilt: false }]
  ])
})
afterEach(() => {
  holder.current?.close()
  holder.current = null
})

describe('chats.guided_build', () => {
  it('is set when a new chat is bound to one unbuilt kit agent and asks for it', () => {
    const chat = chatService.create(USER)
    expect(chat.guidedBuild).toBe(false)
    chatService.update(USER, chat.id, { title: 'Hi', router: 'direct', agentId: 'folder:blank', guidedBuild: true })
    expect(guided(chat.id)).toBe(true)
  })

  it('is never set when not asked for, whatever the agent', () => {
    const chat = chatService.create(USER)
    chatService.update(USER, chat.id, { title: 'Hi', router: 'direct', agentId: 'folder:blank' })
    expect(guided(chat.id)).toBe(false)
  })

  it('is refused for a built agent, a non-folder agent, or with the setting off', () => {
    const built = chatService.create(USER)
    chatService.update(USER, built.id, { router: 'direct', agentId: 'folder:built', guidedBuild: true })
    expect(guided(built.id)).toBe(false)

    const remote = chatService.create(USER)
    chatService.update(USER, remote.id, { router: 'direct', agentId: 'remote:x', guidedBuild: true })
    expect(guided(remote.id)).toBe(false)

    appSettingsRepo.set('guidedFirstBuild', false)
    const off = chatService.create(USER)
    chatService.update(USER, off.id, { router: 'direct', agentId: 'folder:blank', guidedBuild: true })
    expect(guided(off.id)).toBe(false)
  })

  it('is refused once the chat has a message: the flag is fixed at creation', () => {
    const chat = chatService.create(USER)
    chatService.update(USER, chat.id, { router: 'direct', agentId: 'folder:blank' })
    messageRepo.saveUser({ chatId: chat.id, content: 'check my Gmail' } as never)
    chatService.update(USER, chat.id, { guidedBuild: true })
    expect(guided(chat.id)).toBe(false)
  })

  it('is never written from the request as a value', () => {
    const chat = chatService.create(USER)
    chatService.update(USER, chat.id, { router: 'direct', agentId: 'folder:blank', guidedBuild: true })
    // A later `false` (or anything) does not clear it, and does not reach the column.
    chatService.update(USER, chat.id, { title: 'Renamed', guidedBuild: false })
    expect(guided(chat.id)).toBe(true)
  })
})
