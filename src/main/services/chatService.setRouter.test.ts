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

vi.mock('./chatModeService', () => ({ chatModeService: { findMerged: (id: string) => id === 'claude-mode' ? { providerId: null, modelId: 'sonnet' } : null } }))
vi.mock('./agentService', async () => {
  const { agentRepo } = await import('../db/agents')
  return { agentService: { findAgent: (settings: string, profile: string, id: string) => {
    const row = agentRepo.getOwned(settings, id) ?? agentRepo.getOwned(profile, id)
    return row ? { row, userId: row.userId } : null
  } } }
})
vi.mock('./chatConductorService', async (original) => {
  const actual = await original<typeof import('./chatConductorService')>()
  const { agentRepo } = await import('../db/agents')
  return { ...actual, chatConductorService: { remove: vi.fn(), ensure: (userId: string, chat: {id:string}) => agentRepo.createRuntime(userId,
    { name: 'Claude', driver: 'acp', config: { launcher: 'claude', conductorChatId: chat.id } }) } }
})
vi.mock('./conductorBridge', () => ({ conductorBridge: { refresh: async () => {} } }))

const USER = 'profile-1'

const { chatService } = await import('./chatService')
const { activeRunsByChat } = await import('./runExecutionState')
const { taskRunnersByChat } = await import('./taskRunnerState')
const { chatRunResultRepo } = await import('../db/chatRunResults')
const { runAllMigrations } = await import('../db/migrations')

it('keeps the summaries off the polled list rows, and serves them keyed by chat id, per owner', () => {
  const chat = chatService.create(USER)
  const other = chatService.create('another-profile')
  expect(chatService.list(USER)[0]).not.toHaveProperty('summary')
  const summaries = chatService.listSummaries(USER)
  expect(Object.keys(summaries)).toEqual([chat.id])
  expect(summaries[chat.id]).toMatchObject({ with: { kind: 'none' }, others: [], messageCount: 0 })
  expect(chatService.listSummaries('another-profile')).not.toHaveProperty(chat.id)
  expect(Object.keys(chatService.listSummaries('another-profile'))).toEqual([other.id])
})

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

it('forgets a chat\'s session activity when the chat is trashed or deleted', async () => {
  const { sessionActivityHub } = await import('./sessionActivityHub')
  const start = { type: 'upsert' as const, id: 'bg', kind: 'background' as const, title: 'watch' }
  const trashed = chatService.create(USER)
  sessionActivityHub.report(trashed.id, 'agent', start)
  chatService.delete(USER, trashed.id)
  expect(sessionActivityHub.snapshot(trashed.id).items).toEqual([])

  const removed = chatService.create(USER)
  sessionActivityHub.report(removed.id, 'agent', start)
  chatService.permanentDelete(USER, removed.id)
  expect(sessionActivityHub.snapshot(removed.id).items).toEqual([])
  expect(sessionActivityHub.hasRunning({ agentId: 'agent' })).toBe(false)
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
it('reports an autonomous task holding the chat on list and detail reads, working or idle', () => {
  const chat = chatService.create(USER)
  expect(chatService.list(USER)[0].taskHeld).toBe(false)
  expect(chatService.get(USER, chat.id)?.taskHeld).toBe(false)
  taskRunnersByChat.set(chat.id, { userId: USER, taskId: 'task-1', id: 'attempt-1', working: false, cancel: vi.fn() })
  try {
    expect(chatService.list(USER)[0].taskHeld).toBe(true)
    expect(chatService.get(USER, chat.id)?.taskHeld).toBe(true)
    expect(chatService.list(USER)[0].activeRunId).toBeNull()
  } finally { taskRunnersByChat.delete(chat.id) }
  expect(chatService.list(USER)[0].taskHeld).toBe(false)
  expect(chatService.get(USER, chat.id)?.taskHeld).toBe(false)
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

/** Make a seeded agent a local ACP agent — one that can coordinate. */
function makeLocal(id: string): void {
  holder.current!.raw.prepare("UPDATE agents SET protocol='acp', driver='acp', driver_config=? WHERE id=?").run(JSON.stringify({ launcher: 'claude' }), id)
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
  seedAgent('a-1')
  seedAgent('a-2')
})

afterEach(() => {
  holder.current?.close()
  holder.current = null
})

it('clears the previous API credential and model when switching to a CLI mode', () => {
  const chatId = directChat()
  chatRepo.updateMeta(USER, chatId, { providerId: 'old-api', modelId: 'old-api-model' })
  chatService.update(USER, chatId, { modeId: 'claude-mode' })
  expect(chatRepo.getOwned(USER, chatId)).toMatchObject({ modeId: 'claude-mode', providerId: null, modelId: 'sonnet' })
})

describe('chatService.setRouter', () => {
  it('moves a direct chat to human with no model configured at all', () => {
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

  it('uses the default runtime for a remote root with no model configured', () => {
    const chatId = directChat()
    chatService.setRouter(USER, chatId, 'coordinator')
    const chat = chatRepo.getOwned(USER, chatId)!
    expect(chat.router).toBe('coordinator')
    expect(chat.agentId).toBeTruthy()
    expect(chat.agentId).not.toBe('a-1')
    expect(chat.providerId).toBeNull()
    expect(chatOnDemandAgentRepo.listAgentIds(chatId)).toEqual(['a-1'])
    expect(agentSessionRepo.getByChatAndAgent(chatId, 'a-1')?.contextId).toBe('ctx-1')
  })

  it('keeps a plain chat’s hidden runtime conducting instead of making it a participant', () => {
    const chatId = directChat()
    holder.current!.raw.prepare("UPDATE agents SET driver='acp', driver_config=? WHERE id='a-1'").run(JSON.stringify({launcher:'claude', conductorChatId: chatId}))
    chatService.setRouter(USER, chatId, 'human')
    const chat = chatRepo.getOwned(USER, chatId)!
    expect(chat.router).toBe('coordinator')
    expect(chat.agentId).toBe('a-1')
    expect(chatOnDemandAgentRepo.listAgentIds(chatId)).toEqual([])
  })

  it('keeps a local root and its session when it starts conducting', () => {
    holder.current!.raw.prepare("UPDATE agents SET driver='acp', driver_config=? WHERE id='a-1'").run(JSON.stringify({launcher:'claude'}))
    const chatId = directChat()
    chatService.setRouter(USER, chatId, 'coordinator')
    expect(chatRepo.getOwned(USER, chatId)?.agentId).toBe('a-1')
    expect(chatOnDemandAgentRepo.listAgentIds(chatId)).toEqual([])
    expect(agentSessionRepo.getByChatAndAgent(chatId, 'a-1')?.contextId).toBe('ctx-1')
  })

  it('refuses both router and metadata paths back from AI routing', () => {
    const chatId = directChat()
    chatService.setRouter(USER, chatId, 'coordinator')
    expect(() => chatService.setRouter(USER, chatId, 'human')).toThrow('AI routing cannot be turned off')
    expect(() => chatService.update(USER, chatId, {router:'direct'})).toThrow('AI routing cannot be turned off')
    expect(chatRepo.getOwned(USER, chatId)?.router).toBe('coordinator')
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

describe('a chat that stops answering to an agent', () => {
  const start = { type: 'upsert' as const, id: 'bg', kind: 'background' as const, title: 'watch' }
  const forgotten: [string, string | undefined][] = []
  let uninstall: () => void = () => {}

  beforeEach(async () => {
    forgotten.length = 0
    const { installChatSessionForgetter } = await import('./chatSessionRelease')
    uninstall = installChatSessionForgetter((chatId, agentId) => { forgotten.push([chatId, agentId]) })
  })
  afterEach(() => uninstall())

  it('keeps a direct root’s sessions when a second agent makes the chat human — it is still in the chat', async () => {
    // The incident: releasing every agent here disposed the running root's
    // `cinna` endpoint mid-turn and its tools vanished.
    const { sessionActivityHub } = await import('./sessionActivityHub')
    makeLocal('a-1')
    const chatId = directChat()
    sessionActivityHub.report(chatId, 'a-1', start)

    chatService.setRouter(USER, chatId, 'human')

    expect(forgotten).toEqual([])
    expect(sessionActivityHub.snapshot(chatId).items.map((item) => item.state)).toEqual(['running'])
  })

  it('releases nothing when the agent that answered keeps coordinating', () => {
    makeLocal('a-1')
    const direct = directChat()
    chatService.setRouter(USER, direct, 'coordinator')
    const human = directChat()
    chatService.setRouter(USER, human, 'human')
    chatOnDemandAgentRepo.add(human, 'a-2')
    forgotten.length = 0

    chatService.setRouter(USER, human, 'coordinator')

    expect(chatRepo.getOwned(USER, human)?.agentId).toBe('a-1')
    expect(forgotten).toEqual([])
  })

  it('releases only the old root when the hidden runtime takes over coordinating', () => {
    const chatId = directChat()
    chatService.setRouter(USER, chatId, 'coordinator')
    expect(forgotten).toEqual([[chatId, 'a-1']])
  })

  it('refuses to change who answers while a turn runs, and still lets an agent join a coordinated turn', () => {
    makeLocal('a-1')
    const chatId = directChat()
    const coordinated = directChat()
    chatService.setRouter(USER, coordinated, 'coordinator')
    activeRunsByChat.set(chatId, { id: 'turn-1' } as never)
    activeRunsByChat.set(coordinated, { id: 'turn-2' } as never)
    try {
      expect(() => chatService.setRouter(USER, chatId, 'human')).toThrow('Interrupt the session before changing who answers.')
      expect(chatRepo.getOwned(USER, chatId)).toMatchObject({ router: 'direct', agentId: 'a-1' })
      expect(() => chatService.setRouter(USER, coordinated, 'coordinator')).not.toThrow()
      expect(() => chatService.addOnDemandAgent(USER, coordinated, 'a-2')).not.toThrow()
      expect(chatOnDemandAgentRepo.listAgentIds(coordinated)).toEqual(['a-2'])
    } finally {
      activeRunsByChat.delete(chatId)
      activeRunsByChat.delete(coordinated)
    }
  })

  it('does the same, for the old agent only, when the chat is rebound to another agent', async () => {
    const { sessionActivityHub } = await import('./sessionActivityHub')
    const chatId = directChat()
    sessionActivityHub.report(chatId, 'a-1', start)
    sessionActivityHub.report(chatId, 'a-2', { ...start, id: 'bg-2' })

    chatService.update(USER, chatId, { title: 'renamed' })
    expect(forgotten).toEqual([])

    chatService.update(USER, chatId, { agentId: 'a-2' })
    expect(forgotten).toEqual([[chatId, 'a-1']])
    const states = Object.fromEntries(sessionActivityHub.snapshot(chatId).items.map((item) => [item.agentId, item.state]))
    expect(states).toEqual({ 'a-1': 'lost', 'a-2': 'running' })
  })

  it('does the same for an attached agent that is removed', async () => {
    const { sessionActivityHub } = await import('./sessionActivityHub')
    const chatId = directChat()
    chatService.setRouter(USER, chatId, 'human')
    forgotten.length = 0
    chatOnDemandAgentRepo.add(chatId, 'a-2')
    sessionActivityHub.report(chatId, 'a-2', { ...start, id: 'bg-3' })

    chatService.removeOnDemandAgent(USER, chatId, 'a-2')

    expect(forgotten).toEqual([[chatId, 'a-2']])
    expect(sessionActivityHub.hasRunning({ chatId })).toBe(false)
  })

  it('stops hearing a trashed or deleted chat’s sessions', () => {
    const trashed = chatService.create(USER)
    chatService.delete(USER, trashed.id)
    const removed = chatService.create(USER)
    chatService.permanentDelete(USER, removed.id)

    expect(forgotten).toEqual([[trashed.id, undefined], [removed.id, undefined]])
  })
})

describe('chatService.setCoordinator', () => {
  const forgotten: [string, string | undefined][] = []
  let uninstall: () => void = () => {}

  beforeEach(async () => {
    forgotten.length = 0
    const { installChatSessionForgetter } = await import('./chatSessionRelease')
    uninstall = installChatSessionForgetter((chatId, agentId) => { forgotten.push([chatId, agentId]) })
  })
  afterEach(() => uninstall())

  function snapshot(chatId: string): unknown {
    const chat = chatRepo.getOwned(USER, chatId)!
    return { router: chat.router, agentId: chat.agentId, attached: chatOnDemandAgentRepo.listAgentIds(chatId) }
  }

  it('moves a direct chat to coordinator with its agent conducting, releasing nothing', () => {
    makeLocal('a-1')
    const chatId = directChat()
    chatService.setCoordinator(USER, chatId, 'a-1')
    expect(snapshot(chatId)).toEqual({ router: 'coordinator', agentId: 'a-1', attached: [] })
    expect(forgotten).toEqual([])
  })

  it('makes the chosen agent of a human chat the conductor, not the first attached', () => {
    makeLocal('a-1')
    makeLocal('a-2')
    const chatId = directChat()
    chatService.setRouter(USER, chatId, 'human')
    chatOnDemandAgentRepo.add(chatId, 'a-2')
    forgotten.length = 0

    chatService.setCoordinator(USER, chatId, 'a-2')

    expect(snapshot(chatId)).toEqual({ router: 'coordinator', agentId: 'a-2', attached: ['a-1'] })
    expect(forgotten).toEqual([])
  })

  it('gives a new conductor a fresh engine session, even one that saved a digest answering as a participant', async () => {
    const { conductorSessionRepo } = await import('../db/conductorSessions')
    makeLocal('a-1')
    makeLocal('a-2')
    const chatId = directChat()
    chatService.setRouter(USER, chatId, 'human')
    chatOnDemandAgentRepo.add(chatId, 'a-2')
    // Both answered here directly: each saved the digest of its endpoint.
    conductorSessionRepo.save(chatId, 'a-1', 'participant-digest-1')
    conductorSessionRepo.save(chatId, 'a-2', 'participant-digest-2')

    chatService.setCoordinator(USER, chatId, 'a-2')

    // No digest matches '', so the bridge's next lease is `freshSession`.
    expect(conductorSessionRepo.get(chatId, 'a-2')).toBe('')
    expect(conductorSessionRepo.get(chatId, 'a-1')).toBe('participant-digest-1')
  })

  it('keeps the session of a direct root that goes on conducting', async () => {
    const { conductorSessionRepo } = await import('../db/conductorSessions')
    makeLocal('a-1')
    const chatId = directChat()
    conductorSessionRepo.save(chatId, 'a-1', 'root-digest')
    chatService.setCoordinator(USER, chatId, 'a-1')
    expect(conductorSessionRepo.get(chatId, 'a-1')).toBe('root-digest')
  })

  it('swaps the conductor: the old one becomes a participant and only its sessions are released', () => {
    makeLocal('a-1')
    makeLocal('a-2')
    seedAgent('a-3')
    const chatId = directChat()
    chatService.setRouter(USER, chatId, 'coordinator')
    chatOnDemandAgentRepo.add(chatId, 'a-2')
    chatOnDemandAgentRepo.add(chatId, 'a-3')
    forgotten.length = 0

    chatService.setCoordinator(USER, chatId, 'a-2')

    expect(snapshot(chatId)).toMatchObject({ router: 'coordinator', agentId: 'a-2' })
    expect(chatOnDemandAgentRepo.listAgentIds(chatId).sort()).toEqual(['a-1', 'a-3'])
    // It rejoins announced, so the new conductor is told about it.
    expect(chatOnDemandAgentRepo.list(chatId).find((row) => row.agentId === 'a-1')?.pendingAnnounce).toBe(true)
    expect(forgotten).toEqual([[chatId, 'a-1']])
    // Its context survives; only what the chat listened to is dropped.
    expect(agentSessionRepo.getByChatAndAgent(chatId, 'a-1')?.contextId).toBe('ctx-1')
  })

  it('only detaches the chat’s hidden runtime, never offering it as a participant', () => {
    makeLocal('a-2')
    const chatId = directChat()
    chatService.setRouter(USER, chatId, 'coordinator')
    const hidden = chatRepo.getOwned(USER, chatId)!.agentId!
    chatOnDemandAgentRepo.add(chatId, 'a-2')
    forgotten.length = 0

    chatService.setCoordinator(USER, chatId, 'a-2')

    expect(snapshot(chatId)).toEqual({ router: 'coordinator', agentId: 'a-2', attached: ['a-1'] })
    expect(forgotten).toEqual([[chatId, hidden]])
  })

  it('is a no-op for the agent already coordinating', () => {
    makeLocal('a-1')
    const chatId = directChat()
    chatService.setCoordinator(USER, chatId, 'a-1')
    activeRunsByChat.set(chatId, { id: 'turn' } as never)
    try {
      expect(() => chatService.setCoordinator(USER, chatId, 'a-1')).not.toThrow()
    } finally { activeRunsByChat.delete(chatId) }
    expect(forgotten).toEqual([])
  })

  it('refuses an agent that is not in the chat, or cannot conduct, with a message that stands alone', () => {
    makeLocal('a-2')
    const chatId = directChat()
    expect(() => chatService.setCoordinator(USER, chatId, 'a-2')).toThrow('That agent is not in this chat. Add it to the chat first.')
    expect(() => chatService.setCoordinator(USER, chatId, 'a-1')).toThrow('Only a local agent can coordinate.')
    expect(snapshot(chatId)).toEqual({ router: 'direct', agentId: 'a-1', attached: [] })
    expect(forgotten).toEqual([])
  })

  it('refuses while a turn runs or an autonomous task holds the chat', () => {
    makeLocal('a-1')
    makeLocal('a-2')
    const chatId = directChat()
    chatService.setRouter(USER, chatId, 'coordinator')
    chatOnDemandAgentRepo.add(chatId, 'a-2')
    forgotten.length = 0
    activeRunsByChat.set(chatId, { id: 'turn' } as never)
    try {
      expect(() => chatService.setCoordinator(USER, chatId, 'a-2')).toThrow('Interrupt the session before changing who answers.')
    } finally { activeRunsByChat.delete(chatId) }
    taskRunnersByChat.set(chatId, { userId: USER, taskId: 't', id: 'r', working: false, cancel: vi.fn() })
    try {
      expect(() => chatService.setCoordinator(USER, chatId, 'a-2')).toThrow('Stop the autonomous task before changing who coordinates it.')
    } finally { taskRunnersByChat.delete(chatId) }
    expect(snapshot(chatId)).toEqual({ router: 'coordinator', agentId: 'a-1', attached: ['a-2'] })
    expect(forgotten).toEqual([])
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
