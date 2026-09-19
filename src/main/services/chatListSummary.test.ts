import { it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createTestDatabase, type TestDatabase } from '../db/testSupport/nodeSqlite'

/**
 * Who a listed chat is with, against a real database.
 *
 * The claim that cannot be made in the renderer: a chat bound to its own hidden
 * runtime (a conductor) is a plain chat, and names its chat mode — never the
 * "Claude"/"Codex" row that runs it.
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
vi.mock('./chatModeService', () => ({
  chatModeService: {
    findMerged: (id: string) => (id === 'research-mode' ? { id, name: 'Research', colorPreset: 'violet' } : null)
  }
}))

const DEFAULT = '__default__'
const USER = 'profile-1'

const { buildChatListSummaries } = await import('./chatListSummary')
const { chatRepo } = await import('../db/chats')
const { agentRepo } = await import('../db/agents')
const { chatOnDemandAgentRepo } = await import('../db/chatOnDemandAgent')
const { messages } = await import('../db/schema')

function seedAgent(id: string, name: string, userId = DEFAULT, source = 'local', protocol = 'a2a', driver: string | null = null): void {
  holder
    .current!.raw.prepare(
      `INSERT INTO agents (id, user_id, name, protocol, enabled, source, driver, created_at)
       VALUES (?, ?, ?, ?, 1, ?, ?, ?)`
    )
    .run(id, userId, name, protocol, source, driver, Date.now())
}

let order = 0
function say(
  chatId: string,
  role: string,
  at: string,
  agent: { sourceAgentId?: string; toolAgentId?: string } = {}
): void {
  holder.current!.db.insert(messages)
    .values({ id: `m-${++order}`, chatId, role, content: 'x', sortOrder: order, createdAt: new Date(at), ...agent })
    .run()
}

function summaryOf(chatId: string) {
  const summary = buildChatListSummaries(DEFAULT, USER, chatRepo.list(USER)).get(chatId)
  if (!summary) throw new Error('no summary for a listed chat')
  return summary
}

beforeEach(() => {
  holder.current = createTestDatabase()
  order = 0
  seedAgent('a-research', 'Research Agent')
  seedAgent('a-writer', 'Writer')
  seedAgent('remote:a-reviewer', 'Reviewer', USER)
})

afterEach(() => {
  holder.current?.close()
  holder.current = null
})

it('names the bound agent, and sends its id rather than a colour', () => {
  const chat = chatRepo.create(USER, { agentId: 'a-research', modeId: 'research-mode' })
  expect(summaryOf(chat.id).with).toEqual({
    kind: 'agent', name: 'Research Agent', color: null, agentId: 'a-research', source: 'local', driver: null, protocol: 'a2a'
  })
})

it('sends the type the agent icon is drawn from: a folder agent, a remote agent, a custom ACP agent over a socket', () => {
  seedAgent('folder:a-cli', 'CLI Agent', DEFAULT, 'folder', 'acp', 'acp')
  seedAgent('remote:a-cloud', 'Cloud Agent', USER, 'remote', 'a2a', 'a2a')
  const socket = agentRepo.createRuntime(DEFAULT, { name: 'Socket Agent', driver: 'acp', config: { launcher: 'custom', transport: 'websocket' } })
  const stdio = agentRepo.createRuntime(DEFAULT, { name: 'Pipe Agent', driver: 'acp', config: { launcher: 'custom' } })
  const withOf = (agentId: string) => summaryOf(chatRepo.create(USER, { agentId }).id).with

  expect(withOf('folder:a-cli')).toMatchObject({ kind: 'agent', source: 'folder', driver: 'acp', protocol: 'acp' })
  expect(withOf('folder:a-cli')).not.toHaveProperty('acpTransport')
  expect(withOf('remote:a-cloud')).toMatchObject({ kind: 'agent', source: 'remote', driver: 'a2a', protocol: 'a2a' })
  expect(withOf(socket.id)).toMatchObject({ source: 'local', driver: 'acp', acpTransport: 'websocket' })
  expect(withOf(stdio.id).acpTransport).toBe('stdio')
})

it('resolves a bound agent that lives in the profile scope', () => {
  const chat = chatRepo.create(USER, { agentId: 'remote:a-reviewer' })
  expect(summaryOf(chat.id).with.name).toBe('Reviewer')
})

it('names the chat mode of a plain chat, with its colour preset', () => {
  const chat = chatRepo.create(USER, { modeId: 'research-mode' })
  expect(summaryOf(chat.id).with).toEqual({ kind: 'mode', name: 'Research', color: 'violet' })
})

it('names the mode of a conductor-bound chat, never the hidden runtime', () => {
  const chat = chatRepo.create(USER, { modeId: 'research-mode' })
  const conductor = agentRepo.createRuntime(USER, { name: 'Claude', driver: 'acp', config: { launcher: 'claude', conductorChatId: chat.id } })
  chatRepo.updateMeta(USER, chat.id, { agentId: conductor.id })
  say(chat.id, 'assistant', '2026-09-19T10:00:00Z', { sourceAgentId: conductor.id })
  say(chat.id, 'tool_call', '2026-09-19T10:01:00Z', { toolAgentId: 'a-writer' })

  const summary = summaryOf(chat.id)
  expect(summary.with).toEqual({ kind: 'mode', name: 'Research', color: 'violet' })
  expect(summary.others).toEqual(['Writer'])
})

it('names the model when there is neither an agent nor a mode, and nothing at all when there is no model either', () => {
  const chat = chatRepo.create(USER)
  expect(summaryOf(chat.id).with).toEqual({ kind: 'none', name: '', color: null })
  const stale = chatRepo.create(USER, { modeId: 'deleted-mode', modelId: 'claude-sonnet' })
  expect(summaryOf(stale.id).with).toEqual({ kind: 'none', name: 'claude-sonnet', color: null })
})

it('takes the first attached agent as the primary of a human-routed chat with nothing bound', () => {
  const chat = chatRepo.create(USER, { router: 'human' })
  holder.current!.raw.prepare(
    `INSERT INTO chat_on_demand_agents (chat_id, agent_id, pending_announce, created_at) VALUES (?, ?, 0, ?), (?, ?, 0, ?)`
  ).run(chat.id, 'a-writer', 100, chat.id, 'a-research', 200)

  const summary = summaryOf(chat.id)
  expect(summary.with).toMatchObject({ kind: 'agent', name: 'Writer', agentId: 'a-writer' })
  expect(summary.others).toEqual(['Research Agent'])
})

it('lists the other participants once each, without the primary or an agent that no longer exists', () => {
  const chat = chatRepo.create(USER, { agentId: 'a-research' })
  chatOnDemandAgentRepo.add(chat.id, 'a-writer')
  say(chat.id, 'user', '2026-09-19T10:00:00Z')
  say(chat.id, 'assistant', '2026-09-19T10:01:00Z', { sourceAgentId: 'a-research' })
  say(chat.id, 'assistant', '2026-09-19T10:02:00Z', { sourceAgentId: 'a-writer' })
  say(chat.id, 'tool_call', '2026-09-19T10:03:00Z', { toolAgentId: 'remote:a-reviewer' })
  say(chat.id, 'tool_call', '2026-09-19T10:04:00Z', { toolAgentId: 'remote:a-reviewer' })
  say(chat.id, 'assistant', '2026-09-19T10:05:00Z', { sourceAgentId: 'a-gone' })

  expect(summaryOf(chat.id).others).toEqual(['Writer', 'Reviewer'])
})

it('counts only user and assistant rows, and spans the first to the last row', () => {
  const chat = chatRepo.create(USER)
  say(chat.id, 'user', '2026-09-19T10:00:00Z')
  say(chat.id, 'tool_call', '2026-09-19T10:10:00Z')
  say(chat.id, 'assistant', '2026-09-19T10:25:00Z')

  const summary = summaryOf(chat.id)
  expect(summary.messageCount).toBe(2)
  expect(summary.firstMessageAt).toEqual(new Date('2026-09-19T10:00:00Z'))
  expect(summary.lastMessageAt).toEqual(new Date('2026-09-19T10:25:00Z'))
})

it('has no dates and no count for a chat with no messages, and never reads another profile\'s chats', () => {
  const chat = chatRepo.create(USER)
  const foreign = chatRepo.create('profile-2')
  say(foreign.id, 'user', '2026-09-19T10:00:00Z')

  expect(summaryOf(chat.id)).toMatchObject({ others: [], firstMessageAt: null, lastMessageAt: null, messageCount: 0 })
  expect(chatRepo.listMessageStats(USER)).toEqual([])
})
