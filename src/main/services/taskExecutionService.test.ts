import { beforeEach, afterEach, describe, it, expect, vi } from 'vitest'
import { createTestDatabase, type TestDatabase } from '../db/testSupport/nodeSqlite'
import type { RunScope, RunObserver } from './runExecutionService'
import type { RunEventContext } from './inboxService'
import type { RunSendPayload } from '../../shared/ipcPayloads'

const state = vi.hoisted(() => ({ db: null as TestDatabase | null, profile: 'profile', enabled: true }))
vi.mock('../db/client', () => ({ getDb: () => state.db!.db, getRawSqlite: () => state.db!.sqlite }))
vi.mock('../auth/scope', () => ({ getProfileScopeUserId: () => state.profile }))
vi.mock('../auth/activation', () => ({ userActivation: { requireActivated: () => {} } }))
vi.mock('../logger/logger', () => ({ createLogger: () => ({ info() {}, warn() {}, debug() {}, error() {} }) }))
const exportHandoff = vi.hoisted(() => vi.fn())
vi.mock('./taskFileService', () => ({ taskFileService: { exportHandoff } }))
const readiness = vi.hoisted(() => vi.fn(async () => ({ state: 'ok', reason: null })))
vi.mock('../agents/drivers', () => ({ driverFor: () => ({ readiness }) }))
vi.mock('./agentService', () => ({ agentService: {
  findAgent: (settings: string, _profile: string, id: string) => id === 'agent-one'
    ? { row: { id, name: 'One', enabled: state.enabled, driver: 'a2a' }, userId: settings } : null
} }))
vi.mock('./inboxService', () => ({ inboxService: { recordRunEvent: vi.fn() } }))
const modelConfig = vi.hoisted(() => vi.fn())
vi.mock('./taskModelConfig', () => ({ resolveTaskModelConfig: modelConfig }))
type StartOptions = { observe: RunObserver; onAccepted: (ctx: RunEventContext) => void }
const dispatch = vi.hoisted(() => vi.fn<(scope: RunScope, payload: RunSendPayload, options: StartOptions) => unknown>())
const isRunning = vi.hoisted(() => vi.fn(() => false))
vi.mock('./runExecutionService', () => ({ runExecutionService: { start: dispatch, isRunning } }))

const { taskExecutionService, taskContinuationPrompt } = await import('./taskExecutionService')
const { taskService } = await import('./taskService')
const { taskRepo } = await import('../db/tasks')
const { chatRepo } = await import('../db/chats')
const { messageRepo } = await import('../db/messages')
const { agentOverrideRepo } = await import('../db/agents')
const SCOPE = { profileUserId: 'profile', settingsUserId: '__default__' }
const TARGET = { kind: 'agent' as const, agentId: 'agent-one' }

function makeTask() {
  const task = taskService.create('profile', {
    title: 'Continue the release', goal: 'Ship version two', description: 'Only the desktop build remains',
    handoffNote: 'Verified tests. Next: build and inspect.', origin: 'remote', executor: 'desktop'
  })
  taskService.start('profile', task.id)
  taskService.setStatus('profile', task.id, 'blocked')
  return taskService.getById('profile', task.id)
}

beforeEach(() => {
  state.db = createTestDatabase()
  state.profile = 'profile'
  state.enabled = true
  vi.clearAllMocks()
  readiness.mockResolvedValue({ state: 'ok', reason: null })
  modelConfig.mockResolvedValue({ modeId: 'mode-one', providerId: 'p1', modelId: 'model-one', mcpIds: [], assertCurrent() {} })
  dispatch.mockImplementation((scope, payload, options) => {
    const ctx = { userId: scope.profileUserId, chatId: payload.chatId, agentId: TARGET.agentId }
    // Real message + task transaction. The fake transport begins only after it.
    const accepted = new Promise<void>((resolve, reject) => {
      try {
        messageRepo.saveUser({ chatId: payload.chatId, content: payload.content }, () => options.onAccepted(ctx))
        resolve()
      } catch (error) { reject(error) }
    })
    return { id: 'turn-one', accepted, completed: new Promise(() => {}) }
  })
})
afterEach(() => { vi.restoreAllMocks(); state.db?.close(); state.db = null })

describe('desktop task start', () => {
  it('refuses a future script router before model resolution or ordinary agent dispatch', async () => {
    const task = makeTask()
    state.db!.raw.prepare('UPDATE tasks SET router = ?, script = ? WHERE id = ?')
      .run('future-script-router', JSON.stringify({ version: 5, steps: [] }), task.id)
    await expect(taskExecutionService.start(SCOPE, task.id, TARGET)).rejects.toThrow('script runner')
    expect(readiness).not.toHaveBeenCalled()
    expect(modelConfig).not.toHaveBeenCalled()
    expect(dispatch).not.toHaveBeenCalled()
    expect(chatRepo.list('profile')).toEqual([])
    expect(taskRepo.getById('profile', task.id)?.chatId).toBeNull()
  })

  it('sends goal, description and handoff once in a new chat, retaining the task and provenance', async () => {
    const task = makeTask()
    const result = await taskExecutionService.start(SCOPE, task.id, TARGET)
    expect(result.task).toMatchObject({ id: task.id, origin: 'remote', status: 'in_progress', assignee: { kind: 'agent', agentId: TARGET.agentId } })
    expect(result.task.chatId).toBe(result.chatId)
    expect(chatRepo.getOwned('profile', result.chatId)).toMatchObject({ agentId: TARGET.agentId, router: 'direct' })
    const messages = chatRepo.listMessages(result.chatId)
    expect(messages).toHaveLength(1)
    expect(messages[0].content).toBe('Continue this task.\n\nGoal:\nShip version two\n\nCurrent description:\nOnly the desktop build remains\n\nHandoff note:\nVerified tests. Next: build and inspect.')
    expect(dispatch).toHaveBeenCalledTimes(1)
    expect(taskService.list('profile')).toHaveLength(1)
    expect(state.db!.raw.prepare('SELECT COUNT(*) AS n FROM job_runs').get()).toMatchObject({ n: 0 })
    await expect(taskExecutionService.start(SCOPE, task.id, TARGET)).rejects.toThrow('already has a conversation')
    expect(dispatch).toHaveBeenCalledTimes(1)
  })

  it('resolves the model in captured scopes without requiring an agent', async () => {
    const task = makeTask()
    const result = await taskExecutionService.start(SCOPE, task.id, { kind: 'model', modeId: 'mode-one' })
    expect(modelConfig).toHaveBeenCalledWith(SCOPE, 'mode-one')
    expect(readiness).not.toHaveBeenCalled()
    expect(chatRepo.getOwned('profile', result.chatId)).toMatchObject({ agentId: null, modeId: 'mode-one', providerId: 'p1', modelId: 'model-one' })
  })

  it('refuses a duplicate start while readiness is pending', async () => {
    const task = makeTask()
    let ready!: (value: { state: string; reason: null }) => void
    readiness.mockReturnValueOnce(new Promise((resolve) => { ready = resolve }))
    const first = taskExecutionService.start(SCOPE, task.id, TARGET)
    await expect(taskExecutionService.start(SCOPE, task.id, TARGET)).rejects.toThrow('already starting')
    expect(chatRepo.list('profile')).toHaveLength(0)
    ready({ state: 'ok', reason: null })
    await first
    expect(dispatch).toHaveBeenCalledTimes(1)
  })

  it.each(['profile', 'claim', 'agent', 'terminal'] as const)('rechecks %s after asynchronous readiness', async (change) => {
    const task = makeTask()
    readiness.mockImplementationOnce(async () => {
      if (change === 'profile') state.profile = 'another-profile'
      if (change === 'claim') taskRepo.update('profile', task.id, { executor: 'remote' })
      if (change === 'agent') state.enabled = false
      if (change === 'terminal') taskService.setStatus('profile', task.id, 'cancelled')
      return { state: 'ok', reason: null }
    })
    await expect(taskExecutionService.start(SCOPE, task.id, TARGET)).rejects.toThrow()
    expect(dispatch).not.toHaveBeenCalled()
    expect(chatRepo.list('profile')).toHaveLength(0)
    expect(taskService.getById('profile', task.id).chatId).toBeNull()
  })

  it('rolls back a rejected acceptance and deletes only its new empty chat', async () => {
    const task = makeTask()
    exportHandoff.mockClear()
    const prior = chatRepo.create('profile', { title: 'Keep this chat' })
    const begin = taskService.beginDesktopChat.bind(taskService)
    vi.spyOn(taskService, 'beginDesktopChat').mockImplementationOnce((...args) => {
      begin(...args)
      throw new Error('Could not accept task')
    })
    await expect(taskExecutionService.start(SCOPE, task.id, TARGET)).rejects.toThrow('Could not accept task')
    expect(taskService.getById('profile', task.id)).toMatchObject({ chatId: null, status: 'blocked' })
    expect(chatRepo.list('profile').map((chat) => chat.id)).toEqual([prior.id])
    expect(state.db!.raw.prepare('SELECT COUNT(*) AS n FROM messages').get()).toMatchObject({ n: 0 })
    expect(exportHandoff).not.toHaveBeenCalled()
    // The reservation is released and the original task is retryable.
    await expect(taskExecutionService.start(SCOPE, task.id, TARGET)).resolves.toMatchObject({ task: { id: task.id } })
    expect(exportHandoff).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ id: task.id, status: 'in_progress' }))
  })

  it('respects a disabled profile override before readiness or dispatch', async () => {
    const task = makeTask()
    agentOverrideRepo.set('profile', TARGET.agentId, false)
    await expect(taskExecutionService.start(SCOPE, task.id, TARGET)).rejects.toThrow('unavailable')
    expect(readiness).not.toHaveBeenCalled()
    expect(dispatch).not.toHaveBeenCalled()
  })

  it('does not read or start a task owned by another profile', async () => {
    const task = makeTask()
    state.profile = 'other'
    await expect(taskExecutionService.start({ ...SCOPE, profileUserId: 'other' }, task.id, TARGET)).rejects.toThrow('Task not found')
    expect(readiness).not.toHaveBeenCalled()
    expect(dispatch).not.toHaveBeenCalled()
  })

  it('does not replace a soft-deleted chat whose main-owned turn is still active', async () => {
    const task = makeTask()
    const chat = chatRepo.create('profile')
    taskRepo.update('profile', task.id, { chatId: chat.id })
    chatRepo.softDelete('profile', chat.id)
    isRunning.mockReturnValueOnce(true)
    await expect(taskExecutionService.start(SCOPE, task.id, TARGET)).rejects.toThrow('already has a turn running')
    expect(dispatch).not.toHaveBeenCalled()
    expect(taskService.getById('profile', task.id).chatId).toBe(chat.id)
  })

  it('keeps the goal once when the description repeats it', () => {
    expect(taskContinuationPrompt({ goal: 'Ship it', description: 'Ship it', handoffNote: null })).toBe('Continue this task.\n\nGoal:\nShip it')
  })
})
