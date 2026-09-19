import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { DelegationRow } from '../db/delegations'
import type { DelegationLifecycleDeps } from './delegationLifecycle'
import type { TaskDto } from '../../shared/tasks'
vi.mock('../auth/activation', () => ({ userActivation: { isActivated: () => true } }))
vi.mock('../auth/scope', () => ({ getProfileScopeUserId: () => 'user' }))
vi.mock('../db/client', () => ({ getDb: () => ({}) }))
vi.mock('../db/handovers', () => ({ handoverRepo: {} }))
vi.mock('../db/taskInputRequests', () => ({ taskInputRequestRepo: {} }))
vi.mock('../logger/logger', () => ({ createLogger: () => ({ warn() {}, debug() {}, info() {} }) }))
vi.mock('./handoverWake', () => ({ createHandoverWake: () => ({}) }))
vi.mock('./chatRouting', () => ({ chatAnswersToAgent: () => null }))
vi.mock('./inboxService', () => ({ inboxService: {} }))
vi.mock('./runExecutionService', () => ({ runExecutionService: {} }))
vi.mock('./taskService', () => ({ taskService: {} }))
const { createDelegationLifecycle } = await import('./delegationLifecycle')
const scope = { profileUserId: 'user', settingsUserId: 'settings' }
let rows: Map<string, DelegationRow>
let deps: DelegationLifecycleDeps
let service: ReturnType<typeof createDelegationLifecycle>
function row(id: string, patch: Partial<DelegationRow> = {}): DelegationRow {
  const value = { id, userId: 'user', requesterKey: id, originChatId: 'origin', originAgentId: 'source', channel: 'local', targetKind: 'kit', targetAgentId: 'target', taskId: `task-${id}`, state: 'running', resultStatus: null, resultDigest: null, summary: null, groupId: null, wokeAt: null, wakeDigest: null, questionAudience: null, artifacts: [], updatedAt: new Date(0), ...patch } as DelegationRow
  rows.set(id, value)
  return value
}
beforeEach(() => {
  rows = new Map()
  deps = {
    repo: {
      getById: (userId, id) => rows.get(id)?.userId === userId ? rows.get(id) : undefined,
      update: (userId, id, patch) => { const old = rows.get(id); if (!old || old.userId !== userId) return undefined; const next = { ...old, ...patch }; rows.set(id, next); return next },
      list: (userId) => [...rows.values()].filter((row) => row.userId === userId),
      listForGroup: (userId, chatId, groupId) => [...rows.values()].filter((row) => row.userId === userId && row.originChatId === chatId && row.groupId === groupId)
    },
    tasks: {
      getById: vi.fn((_userId, taskId) => ({ id: taskId, chatId: `chat-${taskId}`, status: 'in_progress' }) as TaskDto),
      setStatus: vi.fn(), setHandoffNote: vi.fn(), setArtifacts: vi.fn(), acceptRemoteResult: vi.fn()
    },
    hasOpenAsk: () => false, isRunning: () => false, wake: vi.fn(), now: () => 180_000, logger: { warn() {} }
  }
  service = createDelegationLifecycle(deps)
})
describe('channel-neutral delegation lifecycle', () => {
  it('applies each semantic result once even before the busy origin receives its wake', () => {
    const a = row('a')
    service.applyResult(scope, a, { status: 'done', summary: 'Finished' })
    service.applyResult(scope, a, { status: 'done', summary: 'Finished' })
    expect(deps.wake).toHaveBeenCalledTimes(1)
    expect(deps.tasks.setHandoffNote).toHaveBeenCalledTimes(1)
    service.applyResult(scope, a, { status: 'done', summary: 'New answer' })
    expect(deps.wake).toHaveBeenCalledTimes(2)
  })
  it('never opens a turn for a settled row that has no result, or whose wake was refused', () => {
    row('historic', { channel: 'file', state: 'skipped' })
    row('refused', { state: 'done', resultStatus: 'done', resultDigest: 'digest', warning: 'wake_refused:chat_gone' })
    service.sweepLostRuns(scope)
    expect(deps.wake).not.toHaveBeenCalled()
    row('undelivered', { state: 'done', resultStatus: 'done', resultDigest: 'digest', warning: 'wake_timed_out' })
    service.sweepLostRuns(scope)
    expect(deps.wake).toHaveBeenCalledTimes(1)
  })
  it('leaves a stale running file row to the file channel’s own sweep', () => {
    row('file', { channel: 'file', targetKind: 'bare' })
    service.sweepLostRuns(scope)
    expect(rows.get('file')!.state).toBe('running')
    expect(deps.wake).not.toHaveBeenCalled()
  })
  it('fans in file, kit and cloud results and names the whole completed group', () => {
    const a = row('a', { channel: 'file', groupId: 'release', runId: 'run' })
    const b = row('b', { channel: 'cloud', groupId: 'release' })
    service.applyResult(scope, a, { status: 'blocked', summary: 'Need an answer', question: 'Which version?' })
    expect(deps.wake).toHaveBeenCalledTimes(1)
    service.applyResult(scope, a, { status: 'done', summary: 'Local done' })
    expect(deps.wake).toHaveBeenCalledTimes(1)
    service.applyResult(scope, b, { status: 'done', summary: 'Cloud done' })
    expect(deps.wake).toHaveBeenLastCalledWith(scope, expect.arrayContaining([expect.objectContaining({ id: 'a' }), expect.objectContaining({ id: 'b' })]), 'release', expect.any(Function))
    expect(deps.tasks.acceptRemoteResult).toHaveBeenCalledTimes(1)
  })
  it('keeps a user question out of the requester chat and holds the group', () => {
    const a = row('a', { channel: 'cloud', groupId: 'release' })
    const b = row('b', { groupId: 'release' })
    service.applyResult(scope, a, { status: 'blocked', summary: 'Approval needed', audience: 'user' })
    service.applyResult(scope, b, { status: 'done', summary: 'Finished' })
    expect(rows.get('a')?.state).toBe('waiting_user')
    expect(deps.wake).not.toHaveBeenCalled()
  })
  it('wakes on terminal cloud results even when their fallback audience is user', () => {
    const a = row('a', { channel: 'cloud' })
    service.applyResult(scope, a, { status: 'done', summary: 'Cloud completed', audience: 'user' })
    expect(deps.wake).toHaveBeenCalledTimes(1)
  })
  it('recovers a queued wake after restart while a live process does not enqueue twice', () => {
    const a = row('a')
    service.applyResult(scope, a, { status: 'done', summary: 'Finished' })
    service.sweepLostRuns(scope)
    expect(deps.wake).toHaveBeenCalledTimes(1)
    createDelegationLifecycle(deps).sweepLostRuns(scope)
    expect(deps.wake).toHaveBeenCalledTimes(2)
    rows.get('a')!.wokeAt = new Date()
    createDelegationLifecycle(deps).sweepLostRuns(scope)
    expect(deps.wake).toHaveBeenCalledTimes(2)
  })
  it('does not sweep remote or externally claimed execution or open user asks as lost', () => {
    row('cloud', { channel: 'cloud' })
    row('external', { channel: 'file', state: 'waiting_external' })
    row('parked')
    deps.hasOpenAsk = (id) => id === 'task-parked'
    service.sweepLostRuns(scope)
    expect(deps.wake).not.toHaveBeenCalled()
    row('lost')
    service.sweepLostRuns(scope)
    expect(rows.get('lost')).toMatchObject({ state: 'failed', warning: 'run_lost' })
  })
  it('retires a removed local task without stopping recovery of later tasks', () => {
    row('removed')
    row('live')
    vi.mocked(deps.tasks.getById).mockImplementation((_userId, taskId) => {
      if (taskId === 'task-removed') throw new Error('Task not found')
      return { id: taskId, chatId: `chat-${taskId}`, status: 'in_progress' } as TaskDto
    })
    expect(() => service.sweepLostRuns(scope)).not.toThrow()
    expect(rows.get('removed')?.state).toBe('skipped')
    expect(rows.get('live')?.state).toBe('failed')
  })
  it('settles a revision without a new report instead of retaining its historical blocked result', () => {
    const a = row('a')
    service.applyResult(scope, a, { status: 'blocked', summary: 'Need clarification' })
    rows.get('a')!.state = 'running'
    service.applyOutcome(scope, 'a', { state: 'completed', text: 'Answered the revision' })
    expect(rows.get('a')).toMatchObject({ state: 'done', warning: 'report_missing' })
  })
  it('restores an identical blocked report after revision without waking the requester twice', () => {
    const a = row('a')
    service.applyResult(scope, a, { status: 'blocked', summary: 'Need clarification' })
    rows.get('a')!.state = 'running'
    service.applyResult(scope, a, { status: 'blocked', summary: 'Need clarification' })
    service.applyOutcome(scope, 'a', { state: 'completed', text: '' })
    expect(rows.get('a')?.state).toBe('blocked')
    expect(deps.wake).toHaveBeenCalledTimes(1)
  })
  it('cancels a skipped task and completes its group without inventing a failed result', () => {
    const a = row('a', { groupId: 'group' })
    const b = row('b', { groupId: 'group' })
    service.applyResult(scope, b, { status: 'done', summary: 'Done' })
    service.skip(scope, a, 'The user skipped this delegation.')
    expect(deps.tasks.setStatus).toHaveBeenLastCalledWith('user', 'task-a', 'cancelled')
    expect(rows.get('a')).toMatchObject({ state: 'skipped', resultStatus: null })
    expect(deps.wake).toHaveBeenCalledWith(scope, expect.arrayContaining([expect.objectContaining({ id: 'a', state: 'skipped' })]), 'group', expect.any(Function))
  })
  it('holds outcome fallback and lost-run sweep while a durable reply is pending', () => {
    row('a', { pendingReplies: [{ id: 'reply', message: 'Follow up', state: 'pending' }] })
    service.applyOutcome(scope, 'a', { state: 'completed', text: '' })
    service.sweepLostRuns(scope)
    expect(rows.get('a')?.state).toBe('running')
    expect(deps.wake).not.toHaveBeenCalled()
  })
  it('keeps a tool report authoritative when its execution turn later finishes', () => {
    const a = row('a')
    service.applyResult(scope, a, { status: 'blocked', summary: 'Need clarification', question: 'Which version?' })
    service.applyOutcome(scope, 'a', { state: 'completed', text: 'Asking a question' })
    expect(rows.get('a')?.state).toBe('blocked')
    service.applyResult(scope, a, { status: 'done', summary: 'Finished' })
    service.applyOutcome(scope, 'a', { state: 'failed', text: 'Late transport failure' })
    expect(rows.get('a')?.state).toBe('done')
  })
})

it('distinguishes repeated identical remote questions by stable result identity', () => {
  const a = row('a', { channel: 'cloud' })
  service.applyResult(scope, a, { status: 'blocked', summary: 'Approve?', resultId: 'first' })
  service.applyResult(scope, a, { status: 'blocked', summary: 'Approve?', resultId: 'first' })
  service.applyResult(scope, a, { status: 'blocked', summary: 'Approve?', resultId: 'second' })
  expect(deps.wake).toHaveBeenCalledTimes(2)
})
it('retries an undelivered wake once its queued delivery settles', () => {
  const a = row('a')
  service.applyResult(scope, a, { status: 'done', summary: 'Done' })
  const settled = vi.mocked(deps.wake).mock.calls[0][3]!
  settled()
  service.sweepLostRuns(scope)
  expect(deps.wake).toHaveBeenCalledTimes(2)
})
it('clears historical blocked wake metadata when a revision is cancelled', () => {
  const a = row('a')
  service.applyResult(scope, a, { status: 'blocked', summary: 'Approve?' })
  rows.get('a')!.wokeAt = new Date()
  rows.get('a')!.state = 'running'
  service.applyOutcome(scope, 'a', { state: 'canceled', text: '' })
  expect(rows.get('a')).toMatchObject({ state: 'skipped', resultStatus: null, resultDigest: null, wokeAt: null })
  expect(deps.wake).toHaveBeenCalledTimes(2)
})
