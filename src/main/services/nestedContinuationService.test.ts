import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { TaskInputRequestRow } from '../db/taskInputRequests'
import type { RunHandle } from './runExecutionService'

const state = vi.hoisted(() => ({
  start: vi.fn(),
  busy: false,
  open: [] as Partial<TaskInputRequestRow>[],
  chat: { router: 'coordinator', deletedAt: null } as { router: string; deletedAt: null | Date } | undefined,
  task: { runsHere: true, executor: 'desktop', status: 'in_progress' },
  active: new Map<string, { completed: Promise<unknown> }>()
}))
vi.mock('../db/taskInputRequests', () => ({ taskInputRequestRepo: { listOpenForChat: () => state.open } }))
vi.mock('../db/chats', () => ({ chatRepo: { getOwned: () => state.chat } }))
vi.mock('./taskService', () => ({ taskService: { getById: () => state.task } }))
vi.mock('./runExecutionState', () => ({ activeRunsByChat: state.active }))
vi.mock('./runExecutionService', () => ({ runExecutionService: { start: state.start, isRunning: () => state.busy } }))
vi.mock('./inboxService', () => ({ inboxService: { recordRunEvent: vi.fn(), resumeChat: vi.fn() } }))
const { completeNestedContinuation, nestedToolCallId } = await import('./nestedContinuationService')
const row = { chatId: 'chat', taskId: 'task', agentId: 'specialist', rootRunId: 'run', invocationId: 'run:original-call' } as TaskInputRequestRow
const scope = { profileUserId: 'profile', settingsUserId: 'settings' }
const handle = (outcome: Record<string, unknown> = {}): RunHandle => ({ completed: Promise.resolve({ state: 'completed', text: 'Evidence found.', ...outcome }) }) as RunHandle

beforeEach(() => {
  state.start.mockReset().mockReturnValue({ accepted: Promise.resolve() })
  state.busy = false
  state.open = []
  state.chat = { router: 'coordinator', deletedAt: null }
  state.task = { runsHere: true, executor: 'desktop', status: 'in_progress' }
  state.active.clear()
})

describe('durable specialist continuation', () => {
  it('recovers original tool identity from persisted invocation without mistaking root asks for children', () => {
    expect(nestedToolCallId(row)).toBe('original-call')
    expect(nestedToolCallId({ ...row, invocationId: 'run' })).toBeNull()
    expect(nestedToolCallId({ ...row, rootRunId: null })).toBeNull()
  })

  it('returns the specialist result to the conductor as a desktop-authored follow-up naming the original call', async () => {
    await completeNestedContinuation(scope, row, handle(), 'original-call')
    expect(state.start).toHaveBeenCalledWith(scope, {
      chatId: 'chat', content: expect.stringContaining('tool call "original-call"')
    }, expect.objectContaining({ inputOrigin: 'specialist' }))
    expect(state.start.mock.calls[0][1].content).toContain('Evidence found.')
    expect(state.start.mock.calls[0][2]).not.toHaveProperty('agentId')
  })

  it('keeps repeated questions waiting and never sends incomplete output to the conductor', async () => {
    state.open = [{ agentId: 'specialist', resume: 'next_message' }]
    await completeNestedContinuation(scope, row, handle(), 'original-call')
    expect(state.start).not.toHaveBeenCalled()
  })

  it.each(['canceled', 'needs_input'])('does not resume the conductor after %s', async (status) => {
    await completeNestedContinuation(scope, row, handle({ state: status }), 'original-call')
    expect(state.start).not.toHaveBeenCalled()
  })

  it('waits for a newer active turn and rechecks task ownership', async () => {
    state.busy = true
    let release!: () => void
    state.active.set('chat', { completed: new Promise<void>((resolve) => { release = resolve }) })
    const pending = completeNestedContinuation(scope, row, handle(), 'original-call')
    await Promise.resolve()
    expect(state.start).not.toHaveBeenCalled()
    state.task.runsHere = false
    state.busy = false
    release()
    await pending
    expect(state.start).not.toHaveBeenCalled()
  })

  it('does not reopen a deleted conversation', async () => {
    state.chat = undefined
    await completeNestedContinuation(scope, row, handle(), 'original-call')
    expect(state.start).not.toHaveBeenCalled()
  })
})
