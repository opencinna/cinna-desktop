import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createTestDatabase, type TestDatabase } from '../db/testSupport/nodeSqlite'
import type { ChatOrigin } from '../../shared/chatOrigin'
import type { ChatRunResultStatus } from '../../shared/chatRunResult'
import type { TurnSettledNotice } from './turnNotices'

/**
 * The core half of desktop notifications: which settled turns are the user's
 * to hear about. Against a real database, so `chats.origin` and
 * `tasks.started_by_user` are read as the app reads them.
 */

const holder = vi.hoisted(() => ({ current: null as TestDatabase | null, profile: 'profile-1' }))
vi.mock('../db/client', () => ({
  getDb: () => holder.current!.db,
  getRawSqlite: () => holder.current!.sqlite
}))
vi.mock('../auth/scope', () => ({
  getSettingsScopeUserId: () => '__default__',
  getProfileScopeUserId: () => holder.profile
}))
// `recordTurnResult`'s other write: the job/task projection, not under test here.
vi.mock('./turnCompletion', () => ({ reportStandaloneTurn: vi.fn() }))

const { turnNotices, turnNoticeFor, shouldNotify } = await import('./turnNotices')
const { recordTurnResult } = await import('./turnRecord')
const { chatRepo } = await import('../db/chats')
const { taskRepo } = await import('../db/tasks')
const { chatRunResultRepo } = await import('../db/chatRunResults')

const USER = 'profile-1'
let seen: TurnSettledNotice[] = []
let off: (() => void) | null = null

beforeEach(() => {
  holder.current = createTestDatabase()
  holder.profile = USER
  seen = []
  off = turnNotices.onSettled((notice) => seen.push(notice))
})

afterEach(() => {
  off?.()
  holder.current?.close()
  holder.current = null
})

function chat(origin: ChatOrigin, init: { title?: string; agentId?: string; owner?: string } = {}): string {
  return chatRepo.create(init.owner ?? USER, { title: init.title ?? 'Plan the launch', agentId: init.agentId ?? null, origin }).id
}

function taskFor(chatId: string, startedByUser: boolean): void {
  const task = taskRepo.create(USER, { title: 'Work', goal: 'Do it', chatId })
  taskRepo.setStartedByUser(USER, task.id, startedByUser)
}

describe('shouldNotify', () => {
  it.each([
    ['completed', 'user', false, true],
    ['needs_input', 'user', false, true],
    ['failed', 'user', false, true],
    // The user's own Stop is never news to them.
    ['canceled', 'user', false, false],
    ['canceled', 'task', true, false],
    ['completed', 'task', false, false],
    ['completed', 'task', true, true],
    ['needs_input', 'task', true, true],
    ['completed', 'job', false, false],
    ['completed', 'delegation', false, false],
    ['completed', 'handover', false, false]
  ] as [ChatRunResultStatus, ChatOrigin, boolean, boolean][])('%s in a %s chat (task started by user: %s) → %s', (status, origin, taskStartedByUser, expected) => {
    expect(shouldNotify({ status, origin, taskStartedByUser })).toBe(expected)
  })
})

describe('turnNoticeFor', () => {
  it('names the chat and its agent, and nothing the turn said', () => {
    holder.current!.raw.prepare(`INSERT INTO agents (id, user_id, name, protocol, enabled, source, driver, created_at)
      VALUES ('agent-1', '__default__', 'Researcher', 'a2a', 1, 'local', 'a2a', 1)`).run()
    const id = chat('user', { agentId: 'agent-1' })
    expect(turnNoticeFor(id, 'run-1', 'completed')).toEqual({
      chatId: id, runId: 'run-1', status: 'completed', notify: true, title: 'Plan the launch', agentName: 'Researcher'
    })
  })

  it('notifies for a task’s chat only when the user started the task', () => {
    const started = chat('task')
    taskFor(started, true)
    const automatic = chat('task')
    taskFor(automatic, false)
    expect(turnNoticeFor(started, 'r1', 'completed').notify).toBe(true)
    expect(turnNoticeFor(automatic, 'r2', 'completed').notify).toBe(false)
  })

  it('keeps a hand-opened chat the user’s when an ask attached a task to it', () => {
    const id = chat('user')
    taskFor(id, false)
    expect(turnNoticeFor(id, 'r1', 'needs_input').notify).toBe(true)
  })

  it.each(['job', 'delegation', 'handover'] as const)('never notifies for a %s chat', (origin) => {
    expect(turnNoticeFor(chat(origin), 'r1', 'completed').notify).toBe(false)
  })

  it('never notifies for a chat outside the active profile, or in the trash', () => {
    const foreign = chat('user', { owner: 'profile-2' })
    expect(turnNoticeFor(foreign, 'r1', 'completed')).toMatchObject({ notify: false, title: '' })
    const trashed = chat('user')
    chatRepo.softDelete(USER, trashed)
    expect(turnNoticeFor(trashed, 'r2', 'completed').notify).toBe(false)
  })
})

describe('recordTurnResult', () => {
  const COMPLETED = { state: 'completed' as const, text: 'the reply', parts: [], notices: [] }

  it('offers a live or follow-up result to the host after the sidebar has it', () => {
    const id = chat('user')
    // The sidebar's result is written before anyone is told.
    const sidebarAtNotice: (string | undefined)[] = []
    const stop = turnNotices.onSettled(() => sidebarAtNotice.push(chatRunResultRepo.get(USER, id)?.runId))
    recordTurnResult(id, 'run-1', COMPLETED as never, { canceled: false, source: 'live' })
    recordTurnResult(id, 'run-2', COMPLETED as never, { canceled: false, source: 'follow-up' })
    stop()
    expect(sidebarAtNotice).toEqual(['run-1', 'run-2'])
    expect(seen.map((notice) => [notice.runId, notice.notify])).toEqual([['run-1', true], ['run-2', true]])
    // No message text crosses into the notice.
    expect(JSON.stringify(seen)).not.toContain('the reply')
  })

  it('says a Stop is not news, and stays silent about a turn the boot pass recorded', () => {
    // Mutation: drop the `recovery` check in `turnNotices.settled` → a relaunch notifies for every killed turn.
    const id = chat('user')
    recordTurnResult(id, 'run-1', COMPLETED as never, { canceled: true, source: 'live' })
    expect(seen).toEqual([expect.objectContaining({ runId: 'run-1', status: 'canceled', notify: false })])
    recordTurnResult(id, 'run-2', COMPLETED as never, { canceled: false, source: 'recovery' })
    expect(seen).toHaveLength(1)
    expect(chatRunResultRepo.get(USER, id)).toMatchObject({ runId: 'run-2', status: 'completed' })
  })

  it('tells result-read listeners which run was read', () => {
    const reads: unknown[] = []
    const stop = turnNotices.onResultRead((event) => reads.push(event))
    turnNotices.resultRead('chat-1', 'run-1')
    stop()
    turnNotices.resultRead('chat-1', 'run-2')
    expect(reads).toEqual([{ chatId: 'chat-1', runId: 'run-1' }])
  })
})
