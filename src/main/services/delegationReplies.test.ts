import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { DelegationRow } from '../db/delegations'
import type { DelegationReply } from '../../shared/delegations'
import type { DelegationRepliesDeps } from './delegationReplies'
vi.mock('../db/delegations', () => ({ delegationRepo: {} }))
vi.mock('../logger/logger', () => ({ createLogger: () => ({ warn() {} }) }))
vi.mock('../auth/activation', () => ({ userActivation: {} }))
vi.mock('../auth/scope', () => ({ getProfileScopeUserId: () => 'profile' }))
vi.mock('./chatRouting', () => ({ chatAnswersToAgent: () => null }))
vi.mock('./delegationLifecycle', () => ({ delegationLifecycle: {} }))
vi.mock('./inboxService', () => ({ inboxService: {} }))
vi.mock('./runExecutionService', () => ({ runExecutionService: {} }))
vi.mock('./taskService', () => ({ taskService: {} }))
const { createDelegationReplies } = await import('./delegationReplies')
const scope = { profileUserId: 'profile', settingsUserId: 'settings' }
let row: DelegationRow
let deps: DelegationRepliesDeps
let sequence = 0
beforeEach(() => {
  sequence = 0
  row = { id: 'delegation', userId: 'profile', channel: 'local', taskId: 'task', requesterKey: 'work', originAgentId: 'source', originChatId: 'origin', targetAgentId: 'target', state: 'blocked', pendingReplies: [] } as unknown as DelegationRow
  deps = {
    repo: {
      getById: (userId, id) => userId === row.userId && id === row.id ? row : undefined,
      list: () => [row],
      update: (_userId, _id, patch) => { row = { ...row, ...patch }; return row },
      appendReply: (_userId, _id, message) => { const reply: DelegationReply = { id: `reply-${++sequence}`, message, state: 'pending' }; row.pendingReplies = [...row.pendingReplies, reply]; return reply },
      changeReply: (_userId, _id, replyId, state) => { row.pendingReplies = state === 'remove' ? row.pendingReplies.filter((reply) => reply.id !== replyId) : row.pendingReplies.map((reply) => reply.id === replyId ? { ...reply, state } : reply); return row }
    },
    executorChat: () => 'executor', chatAnswersToAgent: () => null, isActive: () => true, isRunning: () => false,
    start: vi.fn(() => ({ id: `run-${sequence}`, accepted: Promise.resolve(), completed: new Promise<never>(() => {}) })),
    watchTurn: vi.fn(), now: () => Date.now(), delay: async () => {}, logger: { warn() {} }
  }
})
describe('durable local delegation replies', () => {
  it('persists before returning queued and removes only after admission', async () => {
    let accept!: () => void
    deps.start = vi.fn(() => ({ id: 'run', accepted: new Promise<void>((resolve) => { accept = resolve }), completed: new Promise<never>(() => {}) }))
    const replies = createDelegationReplies(deps)
    expect(replies.enqueue(scope, row, 'Use option A')).toMatchObject({ state: 'queued', replyId: 'reply-1' })
    expect(row.pendingReplies).toEqual([{ id: 'reply-1', message: 'Use option A', state: 'pending' }])
    expect(deps.start).not.toHaveBeenCalled()
    await Promise.resolve()
    await Promise.resolve()
    expect(row.pendingReplies[0].state).toBe('sending')
    accept()
    await replies.idle()
    expect(row.pendingReplies).toEqual([])
    expect(row).toMatchObject({ state: 'running', runId: 'run' })
    expect(deps.watchTurn).toHaveBeenCalledTimes(1)
  })
  it('replays pending replies in order after restart and deduplicates reconciliation', async () => {
    row.pendingReplies = [{ id: 'first', message: 'First', state: 'pending' }, { id: 'second', message: 'Second', state: 'pending' }]
    const replies = createDelegationReplies(deps)
    replies.reconcile(scope)
    replies.reconcile(scope)
    await replies.idle()
    expect(deps.start).toHaveBeenCalledTimes(2)
    expect(vi.mocked(deps.start).mock.calls.map((call) => call[2])).toEqual([expect.stringContaining('First'), expect.stringContaining('Second')])
    expect(row.pendingReplies).toEqual([])
  })
  it('never repeats a sending item whose admission was interrupted by a crash', async () => {
    row.pendingReplies = [{ id: 'uncertain', message: 'May already have been accepted', state: 'sending' }]
    const replies = createDelegationReplies(deps)
    replies.reconcile(scope)
    await replies.idle()
    expect(deps.start).not.toHaveBeenCalled()
    expect(row.warning).toContain('reply_uncertain:uncertain')
    expect(row.pendingReplies).toHaveLength(1)
  })
  it('does not call a live sending item uncertain during ordinary reconciliation', async () => {
    let accept!: () => void
    deps.start = vi.fn(() => ({ id: 'run', accepted: new Promise<void>((resolve) => { accept = resolve }), completed: new Promise<never>(() => {}) }))
    const replies = createDelegationReplies(deps)
    replies.enqueue(scope, row, 'Message')
    await Promise.resolve(); await Promise.resolve()
    replies.reconcile(scope)
    expect(row.warning).toBeUndefined()
    accept()
    await replies.idle()
  })
  it('keeps a known refused admission pending and retries after recovery', async () => {
    deps.start = vi.fn(() => { throw new Error('Not ready') })
    const replies = createDelegationReplies(deps)
    replies.enqueue(scope, row, 'Message')
    await replies.idle()
    expect(row.pendingReplies[0].state).toBe('pending')
    deps.start = vi.fn(() => ({ id: 'run', accepted: Promise.resolve(), completed: new Promise<never>(() => {}) }))
    replies.reconcile(scope)
    await replies.idle()
    expect(row.pendingReplies).toEqual([])
  })
  it('retains pending work while its profile is inactive', async () => {
    const replies = createDelegationReplies(deps)
    replies.enqueue(scope, row, 'Message')
    deps.isActive = () => false
    await replies.idle()
    expect(row.pendingReplies[0].state).toBe('pending')
    expect(deps.start).not.toHaveBeenCalled()
    deps.isActive = () => true
    replies.reconcile(scope)
    await replies.idle()
    expect(deps.start).toHaveBeenCalledTimes(1)
  })
})
