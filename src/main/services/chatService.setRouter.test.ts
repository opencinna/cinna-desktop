import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createTestDatabase, type TestDatabase } from '../db/testSupport/nodeSqlite'
import { ChatError } from '../errors'

/**
 * Moving a chat from one router to another, against a real database.
 *
 * The transition that matters is `direct → human`: **it must not need a model.**
 * Before phase 4 a second agent in a chat forced the local model into the middle
 * of it, and a user with no LLM provider configured was refused outright — the
 * `not_configured` path below is the one that used to fire here and now fires
 * only where the model is genuinely the thing answering.
 *
 * The other claim is what the switch costs an agent: nothing. Its session row
 * survives every transition, because a chat changing shape must not cost an
 * agent the context it has built up in it.
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

/** What `resolveProviderModelFromChatMode` answers. Null means "no model here". */
const resolvedModel = vi.hoisted(
  () => ({ current: { providerId: 'p-1', modelId: 'm-1' } as { providerId: string; modelId: string } | null })
)
// The error class is declared **inside** the factory rather than imported into
// it: a `vi.mock` factory is hoisted above the file's imports, so a reference to
// one is still in its temporal dead zone when the factory runs, and the module
// under test ends up doing `instanceof undefined`.
vi.mock('./aiFunctionsService', () => {
  class AiFunctionError extends Error {
    constructor(readonly code: string, message: string) {
      super(message)
    }
  }
  return {
    AiFunctionError,
    aiFunctions: {
      resolveProviderModelFromChatMode: () => {
        if (!resolvedModel.current) throw new AiFunctionError('no_provider', 'none configured')
        return resolvedModel.current
      }
    }
  }
})
vi.mock('./agentService', () => ({ agentService: { findAgent: () => null } }))

const USER = 'profile-1'

const { chatService } = await import('./chatService')
const { activeRunsByChat } = await import('./runExecutionState')
const { taskRunnersByChat } = await import('./taskRunnerState')
const { chatRunResultRepo } = await import('../db/chatRunResults')
const { runAllMigrations } = await import('../db/migrations')

it('retains unread results across migration replay, scopes reads by owner and acknowledges only the opened run', () => {
  const chat = chatService.create(USER)
  chatRunResultRepo.record(chat.id, 'run-1', 'needs_input')
  expect(chatService.list(USER)[0].lastRunResult).toEqual({ runId: 'run-1', status: 'needs_input', unread: true })
  runAllMigrations(holder.current!.sqlite)
  expect(chatService.list(USER)[0].lastRunResult?.unread).toBe(true)
  expect(chatService.list('another-profile')).toEqual([])
  expect(() => chatService.markResultRead('another-profile', chat.id, 'run-1')).toThrow('Chat not found')
  chatService.markResultRead(USER, chat.id, 'run-1')
  expect(chatService.list(USER)[0].lastRunResult?.unread).toBe(false)

  chatRunResultRepo.record(chat.id, 'run-2', 'completed')
  chatService.markResultRead(USER, chat.id, 'run-1')
  expect(chatService.list(USER)[0].lastRunResult).toEqual({ runId: 'run-2', status: 'completed', unread: true })
  chatRunResultRepo.record(chat.id, 'run-3', 'canceled')
  expect(chatService.list(USER)[0].lastRunResult).toEqual({ runId: 'run-3', status: 'canceled', unread: false })
  chatService.permanentDelete(USER, chat.id)
  expect(chatRunResultRepo.list(USER).size).toBe(0)
})

it('exposes main-run activity only on an owned chat and clears it when the turn closes', () => {
  const chat = chatService.create(USER)
  activeRunsByChat.set(chat.id, { id: 'headless-turn' } as never)
  try {
    expect(chatService.get(USER, chat.id)?.activeRunId).toBe('headless-turn')
    expect(chatService.list(USER).find((item) => item.id === chat.id)?.activeRunId).toBe('headless-turn')
    expect(chatService.list('another-profile')).toEqual([])
    expect(() => chatService.delete(USER, chat.id)).toThrow('Interrupt the session before deleting it.')
    expect(chatService.get('another-profile', chat.id)).toBeNull()
    activeRunsByChat.delete(chat.id)
    expect(chatService.get(USER, chat.id)?.activeRunId).toBeNull()
    expect(chatService.list(USER).find((item) => item.id === chat.id)?.activeRunId).toBeNull()
    expect(() => chatService.delete(USER, chat.id)).not.toThrow()
    expect(chatService.list(USER)).toEqual([])
  } finally { activeRunsByChat.delete(chat.id) }
})

it('keeps a working autonomous session interruptible between turns', () => {
  const chat = chatService.create(USER)
  const runner = { userId: USER, taskId: 'task-1', id: 'attempt-1', working: true, cancel: vi.fn() }
  taskRunnersByChat.set(chat.id, runner)
  try {
    expect(chatService.list(USER)[0].activeRunId).toBe('attempt-1')
    expect(() => chatService.delete(USER, chat.id)).toThrow('Interrupt the session before deleting it.')
    runner.working = false
    expect(chatService.list(USER)[0].activeRunId).toBeNull()
    expect(() => chatService.delete(USER, chat.id)).not.toThrow()
  } finally { taskRunnersByChat.delete(chat.id) }
})
const { chatRepo } = await import('../db/chats')
const { chatOnDemandAgentRepo } = await import('../db/chatOnDemandAgent')
const { agentSessionRepo } = await import('../db/agents')

function seedAgent(id: string): void {
  holder
    .current!.raw.prepare(
      `INSERT INTO agents (id, user_id, name, protocol, enabled, source, created_at)
       VALUES (?, '__default__', ?, 'a2a', 1, 'local', ?)`
    )
    .run(id, id, Date.now())
}

/** A chat rooted on `a-1`, the shape `direct` means. */
function directChat(): string {
  const chat = chatRepo.create(USER, { agentId: 'a-1' })
  agentSessionRepo.upsert({
    chatId: chat.id,
    agentId: 'a-1',
    contextId: 'ctx-1',
    taskId: null,
    taskState: null
  })
  return chat.id
}

beforeEach(() => {
  holder.current = createTestDatabase()
  resolvedModel.current = { providerId: 'p-1', modelId: 'm-1' }
  seedAgent('a-1')
  seedAgent('a-2')
})

afterEach(() => {
  holder.current?.close()
  holder.current = null
})

describe('chatService.setRouter', () => {
  it('moves a direct chat to human with no model configured at all', () => {
    resolvedModel.current = null
    const chatId = directChat()

    expect(() => chatService.setRouter(USER, chatId, 'human')).not.toThrow()

    const chat = chatRepo.getOwned(USER, chatId)!
    expect(chat.router).toBe('human')
    // The former root becomes one of the attached agents — equal to the one
    // arriving, which is what "the user routes" means.
    expect(chat.agentId).toBeNull()
    expect(chatOnDemandAgentRepo.listAgentIds(chatId)).toEqual(['a-1'])
    expect(chat.providerId).toBeNull()
  })

  it('keeps the agent’s session across the switch', () => {
    const chatId = directChat()
    chatService.setRouter(USER, chatId, 'human')
    expect(agentSessionRepo.getByChat(chatId)?.contextId).toBe('ctx-1')
  })

  it('refuses a move to coordinator when no model can be resolved', () => {
    resolvedModel.current = null
    const chatId = directChat()

    expect(() => chatService.setRouter(USER, chatId, 'coordinator')).toThrow(ChatError)
    // And changes nothing: the chat is still talking to its agent.
    const chat = chatRepo.getOwned(USER, chatId)!
    expect(chat.router).toBe('direct')
    expect(chat.agentId).toBe('a-1')
    expect(chatOnDemandAgentRepo.listAgentIds(chatId)).toEqual([])
  })

  it('resolves and stores a model when the coordinator takes over', () => {
    const chatId = directChat()
    chatService.setRouter(USER, chatId, 'coordinator')

    const chat = chatRepo.getOwned(USER, chatId)!
    expect(chat.router).toBe('coordinator')
    expect(chat.providerId).toBe('p-1')
    expect(chat.modelId).toBe('m-1')
    expect(chatOnDemandAgentRepo.listAgentIds(chatId)).toEqual(['a-1'])
  })

  it('turns coordination off onto human, keeping the attached agents', () => {
    const chatId = directChat()
    chatService.setRouter(USER, chatId, 'coordinator')
    chatOnDemandAgentRepo.add(chatId, 'a-2')

    chatService.setRouter(USER, chatId, 'human')
    expect(chatRepo.getOwned(USER, chatId)!.router).toBe('human')
    expect(chatOnDemandAgentRepo.listAgentIds(chatId).sort()).toEqual(['a-1', 'a-2'])
  })

  it('binds the single attached agent as the root on the way back to direct', () => {
    const chatId = directChat()
    chatService.setRouter(USER, chatId, 'human')
    chatService.setRouter(USER, chatId, 'direct')

    const chat = chatRepo.getOwned(USER, chatId)!
    expect(chat.agentId).toBe('a-1')
    // …and it stops being one of the attached, or the chat would carry its own
    // root twice.
    expect(chatOnDemandAgentRepo.listAgentIds(chatId)).toEqual([])
  })

  it('refuses to make a chat with several agents direct', () => {
    const chatId = directChat()
    chatService.setRouter(USER, chatId, 'human')
    chatOnDemandAgentRepo.add(chatId, 'a-2')

    expect(() => chatService.setRouter(USER, chatId, 'direct')).toThrow(ChatError)
    expect(chatRepo.getOwned(USER, chatId)!.router).toBe('human')
  })

  it('is a no-op on the router a chat is already on', () => {
    const chatId = directChat()
    chatService.setRouter(USER, chatId, 'direct')
    const chat = chatRepo.getOwned(USER, chatId)!
    expect(chat.agentId).toBe('a-1')
    expect(chatOnDemandAgentRepo.listAgentIds(chatId)).toEqual([])
  })

  it('refuses a chat the caller does not own', () => {
    const chatId = directChat()
    expect(() => chatService.setRouter('somebody-else', chatId, 'human')).toThrow(ChatError)
  })
})

describe('the order a chat’s agents come back in', () => {
  /**
   * `human` routing falls back to "the first attached agent" when nobody has
   * been addressed yet, so the order this list comes back in is load-bearing.
   *
   * Without an `ORDER BY`, SQLite returns composite-primary-key order — by
   * `agent_id`, which is a nanoid — so "the first attached" was alphabetical by
   * a random string, and could differ from what the composer's ring showed.
   */
  function attachAt(chatId: string, agentId: string, seconds: number): void {
    holder
      .current!.raw.prepare(
        `INSERT INTO chat_on_demand_agents (chat_id, agent_id, pending_announce, created_at)
         VALUES (?, ?, 1, ?)`
      )
      .run(chatId, agentId, seconds)
  }

  it('is oldest attachment first, whatever the ids sort like', () => {
    const chat = chatRepo.create(USER, {})
    // `a-2` attached first, and `a-1` sorts before it — so PK order and attach
    // order disagree, which is the whole point of the fixture.
    attachAt(chat.id, 'a-2', 1_000)
    attachAt(chat.id, 'a-1', 2_000)
    expect(chatOnDemandAgentRepo.listAgentIds(chat.id)).toEqual(['a-2', 'a-1'])
  })

  it('breaks a same-second tie the same way every time', () => {
    // `created_at` is whole seconds, so two agents attached in one gesture tie.
    // The tie-break is arbitrary but fixed: the answer must not depend on how
    // SQLite happened to scan the table this run.
    const chat = chatRepo.create(USER, {})
    attachAt(chat.id, 'a-2', 5_000)
    attachAt(chat.id, 'a-1', 5_000)
    expect(chatOnDemandAgentRepo.listAgentIds(chat.id)).toEqual(['a-1', 'a-2'])
  })
})
