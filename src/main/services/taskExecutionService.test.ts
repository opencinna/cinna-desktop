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
const inFolder = vi.hoisted(() => ({ cwd: true }))
vi.mock('../agents/drivers', () => ({ driverFor: () => ({ readiness, capabilities: () => inFolder }) }))
vi.mock('./agentService', () => ({ agentService: {
  findAgent: (settings: string, _profile: string, id: string) => id === 'agent-one'
    ? { row: { id, name: 'One', enabled: state.enabled, driver: 'a2a' }, userId: settings } : null
} }))
vi.mock('./inboxService', () => ({ inboxService: { recordRunEvent: vi.fn() } }))
const modelConfig = vi.hoisted(() => vi.fn())
vi.mock('./taskModelConfig', () => ({ resolveTaskModelConfig: modelConfig }))
type StartOptions = { observe: RunObserver; onAccepted: (ctx: RunEventContext) => void }
const dispatch = vi.hoisted(() => vi.fn<(scope: RunScope, payload: RunSendPayload, options: StartOptions) => unknown>())
const isRunning = vi.hoisted(() => vi.fn((_chatId: string) => false))
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

  it('names the accepted run to onRunAccepted inside its acceptance, by chat and turn id', async () => {
    dispatch.mockImplementationOnce((scope, payload, options) => {
      // As the real service: acceptance carries the run's own id as turnId.
      const ctx = { userId: scope.profileUserId, chatId: payload.chatId, agentId: TARGET.agentId, turnId: 'turn-one', rootRunId: 'turn-one' }
      messageRepo.saveUser({ chatId: payload.chatId, content: payload.content }, () => options.onAccepted(ctx))
      return { id: 'turn-one', accepted: Promise.resolve(), completed: new Promise(() => {}) }
    })
    const seen: { chatId: string; runId: string }[] = []
    const result = await taskExecutionService.start(SCOPE, makeTask().id, TARGET, { onRunAccepted: (run) => seen.push(run) })
    expect(seen).toEqual([{ chatId: result.chatId, runId: 'turn-one' }])
    expect(result.runId).toBe('turn-one')
  })

  it('opens the task’s new chat as a task’s chat, never as the user’s own', async () => {
    const result = await taskExecutionService.start(SCOPE, makeTask().id, TARGET)
    expect(chatRepo.getOwned('profile', result.chatId)).toMatchObject({ origin: 'task' })
  })

  it('marks the task started by the user only for the user’s own start, and an automatic start clears it', async () => {
    const own = makeTask()
    await taskExecutionService.start(SCOPE, own.id, TARGET, { startedBy: 'user' })
    expect(taskRepo.getById('profile', own.id)?.startedByUser).toBe(true)

    const automatic = makeTask()
    // As if a run the user started earlier had left it set: a start nobody pressed clears it.
    taskRepo.setStartedByUser('profile', automatic.id, true)
    await taskExecutionService.start(SCOPE, automatic.id, TARGET)
    expect(taskRepo.getById('profile', automatic.id)?.startedByUser).toBe(false)
  })

  it('leaves started_by_user alone when the start is refused before acceptance', async () => {
    const task = makeTask()
    taskRepo.setStartedByUser('profile', task.id, true)
    readiness.mockResolvedValueOnce({ state: 'invalid', reason: 'Broken folder.' } as never)
    await expect(taskExecutionService.start(SCOPE, task.id, TARGET)).rejects.toThrow('Broken folder.')
    expect(taskRepo.getById('profile', task.id)?.startedByUser).toBe(true)
  })

  it('resolves the model in captured scopes without requiring an agent', async () => {
    const task = makeTask()
    const result = await taskExecutionService.start(SCOPE, task.id, { kind: 'model', modeId: 'mode-one' })
    expect(modelConfig).toHaveBeenCalledWith(SCOPE, 'mode-one')
    expect(readiness).not.toHaveBeenCalled()
    expect(chatRepo.getOwned('profile', result.chatId)).toMatchObject({ agentId: null, modeId: 'mode-one', providerId: 'p1', modelId: 'model-one' })
  })

  it('starts an agent whose credentials are missing, and refuses one that cannot run', async () => {
    readiness.mockResolvedValueOnce({ state: 'credentials_needed', reason: 'Add credentials.' } as never)
    await taskExecutionService.start(SCOPE, makeTask().id, TARGET)
    expect(dispatch).toHaveBeenCalledTimes(1)
    readiness.mockResolvedValueOnce({ state: 'invalid', reason: 'Broken folder.' } as never)
    await expect(taskExecutionService.start(SCOPE, makeTask().id, TARGET)).rejects.toThrow('Broken folder.')
    expect(dispatch).toHaveBeenCalledTimes(1)
  })

  it('refuses missing credentials on an agent that has no folder', async () => {
    inFolder.cwd = false
    try {
      readiness.mockResolvedValueOnce({ state: 'credentials_needed', reason: 'Choose a credential.' } as never)
      await expect(taskExecutionService.start(SCOPE, makeTask().id, TARGET)).rejects.toThrow('Choose a credential.')
      expect(dispatch).not.toHaveBeenCalled()
    } finally {
      inFolder.cwd = true
    }
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

/**
 * `reuseChatId` — a caller *inside* main handing over a chat it created for
 * this very start. Today that is the handover gate, whose Inbox row needs a
 * `chat_id` before the task has one (`task_input_requests.chat_id` is NOT NULL).
 *
 * Every refusal below is a way the option could point a task at somebody else's
 * conversation, which is exactly why it is not on the IPC payload.
 */
describe('starting in a chat somebody else created', () => {
  const emptyChat = () => chatRepo.create('profile', { title: 'Gate', router: 'direct', agentId: 'agent-one' })

  it('adopts the chat instead of creating a second one', async () => {
    const task = makeTask()
    const chat = emptyChat()
    const before = chatRepo.list('profile').length

    const result = await taskExecutionService.start(SCOPE, task.id, TARGET, { reuseChatId: chat.id })

    expect(result.chatId).toBe(chat.id)
    expect(chatRepo.list('profile').length).toBe(before)
    expect(taskService.getById('profile', task.id).chatId).toBe(chat.id)
  })

  it('refuses a chat that has already been used', async () => {
    const task = makeTask()
    const chat = emptyChat()
    messageRepo.saveUser({ chatId: chat.id, content: 'Somebody else’s conversation' })

    await expect(taskExecutionService.start(SCOPE, task.id, TARGET, { reuseChatId: chat.id }))
      .rejects.toThrow('already been used')
    expect(dispatch).not.toHaveBeenCalled()
  })

  it('refuses a chat bound to another agent', async () => {
    const task = makeTask()
    const other = chatRepo.create('profile', { title: 'Gate', router: 'direct' as const, agentId: 'agent-two' })

    await expect(taskExecutionService.start(SCOPE, task.id, TARGET, { reuseChatId: other.id }))
      .rejects.toThrow('belongs to another agent')
    expect(dispatch).not.toHaveBeenCalled()
  })

  it('refuses a chat this profile does not own, and one that is in the trash', async () => {
    const task = makeTask()
    const foreign = chatRepo.create('someone-else', { title: 'Gate', router: 'direct', agentId: 'agent-one' })
    await expect(taskExecutionService.start(SCOPE, task.id, TARGET, { reuseChatId: foreign.id }))
      .rejects.toThrow('no longer available')

    const trashed = emptyChat()
    chatRepo.softDelete('profile', trashed.id)
    await expect(taskExecutionService.start(SCOPE, task.id, TARGET, { reuseChatId: trashed.id }))
      .rejects.toThrow('no longer available')
    expect(dispatch).not.toHaveBeenCalled()
  })

  it('keeps the reused chat when the start is refused — it belongs to its caller', async () => {
    const task = makeTask()
    const chat = emptyChat()
    state.enabled = false

    await expect(taskExecutionService.start(SCOPE, task.id, TARGET, { reuseChatId: chat.id }))
      .rejects.toThrow('That agent is unavailable')
    expect(chatRepo.getOwned('profile', chat.id)).toBeDefined()
  })
})

describe('continuing a task in its own conversation', () => {
  /** A Ready task that ran before in a chat with the agent. */
  function readyWithChat(agentId = 'agent-one') {
    const task = makeTask()
    const chat = chatRepo.create('profile', { title: 'Earlier', router: 'direct', agentId })
    messageRepo.saveUser({ chatId: chat.id, content: 'Earlier work' })
    taskRepo.update('profile', task.id, { chatId: chat.id, status: 'open' })
    return { task, chat }
  }

  it('sends the continuation prompt into the task’s chat instead of a new one', async () => {
    const { task, chat } = readyWithChat()
    const before = chatRepo.list('profile').length
    const result = await taskExecutionService.start(SCOPE, task.id, TARGET, { continueInChat: true })
    expect(result.chatId).toBe(chat.id)
    expect(chatRepo.list('profile').length).toBe(before)
    const messages = chatRepo.listMessages(chat.id)
    expect(messages.at(-1)?.content).toBe(taskContinuationPrompt(task))
    expect(taskService.getById('profile', task.id)).toMatchObject({ status: 'in_progress', chatId: chat.id })
  })

  it('still refuses without the option, and refuses a chat bound to another agent or running', async () => {
    const { task } = readyWithChat()
    await expect(taskExecutionService.start(SCOPE, task.id, TARGET)).rejects.toThrow('already has a conversation')
    const other = readyWithChat('agent-two')
    await expect(taskExecutionService.start(SCOPE, other.task.id, TARGET, { continueInChat: true })).rejects.toThrow('belongs to another agent')
    isRunning.mockReturnValue(true)
    try {
      await expect(taskExecutionService.start(SCOPE, task.id, TARGET, { continueInChat: true })).rejects.toThrow('turn running')
    } finally {
      isRunning.mockReturnValue(false)
    }
    expect(dispatch).not.toHaveBeenCalled()
  })

  it('continues in the task’s chat when its own run is registered on that chat before acceptance', async () => {
    const { task, chat } = readyWithChat()
    // As the real service: the run is in activeChats before onAccepted fires.
    const running = new Set<string>()
    isRunning.mockImplementation((chatId: string) => running.has(chatId))
    dispatch.mockImplementationOnce((scope, payload, options) => {
      running.add(payload.chatId)
      const ctx = { userId: scope.profileUserId, chatId: payload.chatId, agentId: TARGET.agentId, turnId: 'turn-one', rootRunId: 'turn-one' }
      const accepted = new Promise<void>((resolve, reject) => {
        try {
          messageRepo.saveUser({ chatId: payload.chatId, content: payload.content }, () => options.onAccepted(ctx))
          resolve()
        } catch (error) { running.delete(payload.chatId); reject(error) }
      })
      return { id: 'turn-one', accepted, completed: new Promise(() => {}) }
    })
    try {
      const result = await taskExecutionService.start(SCOPE, task.id, TARGET, { continueInChat: true })
      expect(result.chatId).toBe(chat.id)
      expect(taskService.getById('profile', task.id)).toMatchObject({ status: 'in_progress', chatId: chat.id })
    } finally {
      isRunning.mockImplementation(() => false)
    }
  })

  it('still refuses at acceptance when the task’s other chat started running meanwhile', async () => {
    const { task, chat } = readyWithChat()
    chatRepo.softDelete('profile', chat.id)
    const running = new Set<string>()
    isRunning.mockImplementation((chatId: string) => running.has(chatId))
    dispatch.mockImplementationOnce((scope, payload, options) => {
      running.add(payload.chatId)
      running.add(chat.id)
      const ctx = { userId: scope.profileUserId, chatId: payload.chatId, agentId: TARGET.agentId }
      const accepted = new Promise<void>((resolve, reject) => {
        try {
          messageRepo.saveUser({ chatId: payload.chatId, content: payload.content }, () => options.onAccepted(ctx))
          resolve()
        } catch (error) { reject(error) }
      })
      return { id: 'turn-one', accepted, completed: new Promise(() => {}) }
    })
    try {
      await expect(taskExecutionService.start(SCOPE, task.id, TARGET, { continueInChat: true })).rejects.toThrow('turn running')
      expect(taskService.getById('profile', task.id)).toMatchObject({ status: 'open', chatId: chat.id })
    } finally {
      isRunning.mockImplementation(() => false)
    }
  })

  it('starts a new chat when the task’s chat was deleted', async () => {
    const { task, chat } = readyWithChat()
    chatRepo.softDelete('profile', chat.id)
    const result = await taskExecutionService.start(SCOPE, task.id, TARGET, { continueInChat: true })
    expect(result.chatId).not.toBe(chat.id)
  })
})
