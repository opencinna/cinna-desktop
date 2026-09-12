import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createTestDatabase, type TestDatabase } from '../db/testSupport/nodeSqlite'
import type { LLMAdapter, StreamParams, StreamResult } from '../llm/types'
import type { AgentDriver } from '../agents/drivers/driver'
import type { AgentRow } from '../db/agents'

const state = vi.hoisted(() => ({ database: null as TestDatabase | null, deviceId: null as string | null, agents: [] as AgentRow[] }))
const stream = vi.hoisted(() => vi.fn<(input: StreamParams) => Promise<StreamResult>>())
const resolveModel = vi.hoisted(() => vi.fn())
vi.mock('./taskModelConfig', () => ({ resolveTaskModelConfig: resolveModel }))
const driverRun = vi.hoisted(() => vi.fn<AgentDriver['run']>())
vi.mock('../db/client', () => ({ getDb: () => state.database!.db, getRawSqlite: () => state.database!.sqlite }))
vi.mock('../db/sync', () => ({ syncRepo: { getState: () => state.deviceId ? { deviceId: state.deviceId } : null } }))
vi.mock('../logger/logger', () => ({ createLogger: () => ({ info() {}, debug() {}, warn() {}, error() {} }) }))
vi.mock('../auth/scope', () => ({ getSettingsScopeUserId: () => '__default__', getAgentLookupScope: () => ['__default__'] }))
vi.mock('../mcp/manager', () => ({ mcpManager: { getConnection: () => null } }))
vi.mock('./cinnaApiService', () => ({ getCinnaServerUrl: () => null, cinnaApiService: {} }))
vi.mock('./syncService', () => ({ syncService: { markDirty() {} } }))
vi.mock('./fileStore', () => ({ attachmentToMediaPart: async () => null }))
vi.mock('./taskFileService', () => ({ taskFileService: { exportHandoff() {}, removeHandoff() {} } }))
vi.mock('./chatTitleService', () => ({ chatTitleService: { autoGenerateForFirstMessage: async () => {} }, ChatTitleError: class extends Error {} }))
vi.mock('./agentService', () => ({ agentService: {
  findAgent: (_settings: string, _user: string, id: string) => { const row = state.agents.find((agent) => agent.id === id); return row ? { row, userId: '__default__' } : null },
  listMerged: () => state.agents
} }))
vi.mock('../agents/drivers', () => ({ driverFor: () => ({ run: driverRun, capabilities: () => ({ commands: { source: 'none' } }) }) }))
vi.mock('./localAgents/commandService', () => ({ resolveCommandRunner: (_cap: unknown, _wire: string, _user: string, _agent: string, run: unknown) => run }))
vi.mock('../llm/registry', () => ({ getAdapter: (): LLMAdapter => ({ providerType: 'openai', listModels: async () => [], stream,
  modelCapability: () => ({ acceptedMimeTypes: [], nativeMimeTypes: [], maxFilesPerMessage: 0, maxFileSizeBytes: 0 }),
  parseError: (error: Error) => ({ short: error.message, detail: error.message }) }) }))

const { scriptRuntimeService } = await import('./scriptRuntimeService')
const { taskRunnerService } = await import('./taskRunnerService')
const { taskRuntimeRepo } = await import('../db/taskRuntimes')
const { runExecutionService } = await import('./runExecutionService')
const { chatService } = await import('./chatService')
const { taskService } = await import('./taskService')
const { inboxService } = await import('./inboxService')
const { scriptRuntimeRepo } = await import('../db/scriptRuntimes')
const { taskInputRequestRepo } = await import('../db/taskInputRequests')
const { taskRepo } = await import('../db/tasks')
const { jobService } = await import('./jobService')
const { jobRunsRepo } = await import('../db/jobs')
const { turnLock } = await import('./localAgents/turnLock')
const { chatRepo } = await import('../db/chats')
const { taskRunnersByChat } = await import('./taskRunnerState')
const { activeRunsByChat } = await import('./runExecutionState')
const { appSettingsRepo } = await import('../db/appSettings')
const USER = '__default__'
const scope = { profileUserId: USER, settingsUserId: USER }

beforeEach(() => {
  state.database = createTestDatabase()
  state.deviceId = null
  resolveModel.mockReset().mockResolvedValue({ modeId: 'mode', providerId: 'provider', modelId: 'model', mcpIds: [], assertCurrent() {} })
  stream.mockReset().mockRejectedValue(new Error('Scripts must not invoke a model'))
  driverRun.mockReset().mockImplementation(async (_owner, row) => ({ text: `${row.name} result`, parts: [], notices: [], taskState: 'completed' }))
  state.agents = ['Analyst', 'Writer'].map((name) => ({ id: name.toLowerCase(), name, driver: 'a2a', source: 'local',
    enabled: true, userId: USER, cardUrl: `http://localhost/${name}` } as AgentRow))
  for (const row of state.agents) state.database.raw.prepare(`INSERT INTO agents (id, user_id, name, protocol, enabled, source, driver, card_url, created_at)
    VALUES (?, ?, ?, 'a2a', 1, 'local', 'a2a', ?, 1)`).run(row.id, USER, row.name, row.cardUrl)
})
afterEach(async () => {
  for (const entry of taskRunnersByChat.values()) { try { entry.cancel() } catch { /* terminal */ } }
  await vi.waitFor(() => expect(activeRunsByChat.size).toBe(0))
  await new Promise((resolve) => setTimeout(resolve, 0))
  taskRunnersByChat.clear()
  turnLock.releaseAll()
  state.database?.close(); state.database = null
})

import type { ScriptStep, TaskScript } from '../../shared/taskScript'
import type { TaskBudget } from '../../shared/tasks'
function makeJob(steps: ScriptStep[], budget?: TaskBudget) {
  const script: TaskScript = { version: 1, agents: { analyst: { kind: 'agent', source: 'local', cardUrl: 'http://localhost/Analyst' },
    writer: { kind: 'agent', source: 'local', cardUrl: 'http://localhost/Writer' } }, steps }
  return jobService.create(USER, { type: 'local', title: 'Script work', prompt: 'Ship a guide', router: 'script', script, budget })
}
function start(steps: ScriptStep[], budget?: TaskBudget) { return scriptRuntimeService.startJob(scope, makeJob(steps, budget)) }
function child(taskId: string, stepId: string) { return scriptRuntimeRepo.get(USER, taskId)!.steps[stepId] }
function completed(text: string) { return { text, parts: [], notices: [], taskState: 'completed' } }
const decision = (answer: string) => ({ kind: 'question' as const, answers: [[answer]] })

describe('script runtime', () => {
  it('prepares inside an outer transaction without escaping its rollback', async () => {
    const job = makeJob([{ id: 'write', agent: 'writer', prompt: '{{goal}}' }])
    expect(() => state.database!.db.transaction(() => {
      const prepared = scriptRuntimeService.prepareJob(scope, job)
      expect(scriptRuntimeRepo.get(USER, prepared.taskId)?.state).toBe('queued')
      expect(() => prepared.launch()).toThrow('Commit the script admission')
      throw new Error('occurrence insert failed')
    })).toThrow('occurrence insert failed')
    expect(taskRepo.list(USER)).toEqual([])
    expect(jobRunsRepo.listByJob(USER, job.id)).toEqual([])
    expect(scriptRuntimeRepo.list(USER)).toEqual([])
    expect(taskRunnersByChat.size).toBe(0)
    expect(driverRun).not.toHaveBeenCalled()
  })
  it('launches a committed preparation exactly once and refuses its old closure after recovery', async () => {
    const prepared = scriptRuntimeService.prepareJob(scope, makeJob([{ id: 'write', agent: 'writer', prompt: '{{goal}}' }]))
    expect(driverRun).not.toHaveBeenCalled()
    expect(taskRunnersByChat.size).toBe(0)
    prepared.launch()
    await vi.waitFor(() => expect(taskService.getById(USER, prepared.taskId).status).toBe('completed'))
    expect(driverRun).toHaveBeenCalledTimes(1)
    expect(() => prepared.launch()).toThrow('no longer queued')
    const interrupted = scriptRuntimeService.prepareJob(scope, makeJob([{ id: 'write', agent: 'writer', prompt: '{{goal}}' }]))
    scriptRuntimeService.recover()
    expect(scriptRuntimeRepo.get(USER, interrupted.taskId)?.state).toBe('interrupted')
    expect(() => interrupted.launch()).toThrow('no longer queued')
    expect(driverRun).toHaveBeenCalledTimes(1)
  })
  it('dispatches an explicit coordinator job in main and settles its linked attempt', async () => {
    stream.mockResolvedValue({ content: '', toolCalls: [{ id: 'finish', name: 'finish', input: { summary: 'Verified coordinator result' } }] })
    const job = jobService.create(USER, { type: 'local', title: 'Coordinate', prompt: 'Complete work', router: 'coordinator' })
    const result = await jobService.execute(USER, job.id, USER)
    expect(result).toMatchObject({ type: 'local', execution: 'main' })
    expect(result.type).toBe('local')
    if (result.type !== 'local') throw new Error('Expected local job')
    await vi.waitFor(() => expect(taskService.getById(USER, result.taskId).status).toBe('completed'))
    expect(jobRunsRepo.getById(USER, result.runId)).toMatchObject({ status: 'succeeded', taskId: result.taskId, localChatId: result.chatId })
    expect(stream).toHaveBeenCalledTimes(1)
    expect(driverRun).not.toHaveBeenCalled()
  })

  it('refuses a coordinator job edited during model resolution before creating any attempt', async () => {
    let settle: (value: unknown) => void = () => {}
    resolveModel.mockImplementation(() => new Promise((resolve) => { settle = resolve }))
    const job = jobService.create(USER, { type: 'local', title: 'Coordinate', prompt: 'Original work', router: 'coordinator' })
    const pending = jobService.execute(USER, job.id, USER)
    await vi.waitFor(() => expect(resolveModel).toHaveBeenCalledTimes(1))
    jobService.update(USER, job.id, { prompt: 'Different work' })
    settle({ modeId: 'mode', providerId: 'provider', modelId: 'model', mcpIds: [], assertCurrent() {} })
    await expect(pending).rejects.toThrow('job changed')
    expect(jobRunsRepo.listByJob(USER, job.id)).toEqual([])
    expect(taskRepo.list(USER)).toEqual([])
    expect(stream).not.toHaveBeenCalled()
  })

  it.each(['parent', 'root-parent', 'goal'] as const)('refuses stale gate recovery after a synced %s change', async (change) => {
    const { taskId } = start([{ id: 'gate', ask_user: 'Proceed with original work?' }])
    await vi.waitFor(() => expect(scriptRuntimeRepo.get(USER, taskId)?.state).toBe('waiting'))
    await new Promise((resolve) => setTimeout(resolve, 0))
    const gate = child(taskId, 'gate')
    const [request] = taskInputRequestRepo.listOpenForTask(gate.taskId)
    const changedId = change === 'parent' ? gate.taskId : taskId
    const row = taskRepo.getById(USER, changedId)!
    taskService.applySyncedTask(USER, { ...row, ...(change !== 'goal' ? { parentTaskId: 'other-root' } : { goal: 'Different work' }) })
    expect(scriptRuntimeRepo.get(USER, taskId)?.state).toBe('interrupted')
    taskRunnersByChat.clear()
    scriptRuntimeService.recover()
    expect(scriptRuntimeRepo.get(USER, taskId)?.state).toBe('interrupted')
    expect(() => scriptRuntimeService.resume(USER, taskId)).toThrow(change === 'parent' ? 'no longer belongs' : 'definition changed')
    expect(await inboxService.answer(USER, request.id, decision('Do original work'))).toMatchObject({ ok: false, code: 'unavailable' })
    expect(taskInputRequestRepo.getById(request.id)?.status).toBe('open')
    expect(taskService.getById(USER, gate.taskId).status).toBe('blocked')
    expect(driverRun).not.toHaveBeenCalled()
    if (change === 'parent') taskInputRequestRepo.open({ requestId: 'other-execution', taskId: gate.taskId, chatId: gate.chatId,
      agentId: 'writer', deliveryOwner: 'driver', resume: 'next_message',
      request: { kind: 'question', questions: [{ question: 'Unrelated work?', multiSelect: false, options: [] }] } })
    scriptRuntimeService.cancel(USER, taskId)
    if (change === 'parent') {
      expect(taskService.getById(USER, gate.taskId).status).toBe('blocked')
      expect(taskInputRequestRepo.listOpenForTask(gate.taskId).map((ask) => ask.id)).toEqual(['other-execution'])
    }
    expect(taskInputRequestRepo.getById(request.id)?.status).toBe('expired')
  })

  it('releases local reservations when a peer takes the parent execution claim', async () => {
    state.deviceId = 'this-device'
    const { taskId } = start([{ id: 'gate', ask_user: 'Proceed?' }])
    await vi.waitFor(() => expect(scriptRuntimeRepo.get(USER, taskId)?.state).toBe('waiting'))
    await new Promise((resolve) => setTimeout(resolve, 0))
    const gate = child(taskId, 'gate')
    const [request] = taskInputRequestRepo.listOpenForTask(gate.taskId)
    taskService.applySyncedTask(USER, { ...taskRepo.getById(USER, taskId)!, executorDevice: 'other-device' })
    expect(scriptRuntimeRepo.get(USER, taskId)?.state).toBe('interrupted')
    expect(taskRunnersByChat.size).toBe(0)
    expect(await inboxService.answer(USER, request.id, decision('Wrong device'))).toMatchObject({ ok: false })
    expect(taskInputRequestRepo.getById(request.id)?.status).toBe('open')
    taskService.removeSyncedTask(USER, taskId)
  })

  it('keeps each runtime’s waiting reservations through root and child metadata edits', async () => {
    const { taskId } = start([{ id: 'gate', ask_user: 'Proceed?' }])
    await vi.waitFor(() => expect(scriptRuntimeRepo.get(USER, taskId)?.state).toBe('waiting'))
    const gate = child(taskId, 'gate')
    expect(taskService.getById(USER, taskId).assignee.kind).toBe('script')
    expect(taskService.getById(USER, gate.taskId).assignee.kind).toBe('human')
    taskService.update(USER, taskId, { title: 'Renamed script' })
    taskService.update(USER, gate.taskId, { priority: 'high' })
    expect(taskRunnersByChat.get(gate.chatId)?.controllerTaskId).toBe(taskId)
    expect(taskRunnersByChat.get(scriptRuntimeRepo.get(USER, taskId)!.chatId)?.controllerTaskId).toBe(taskId)
    expect(() => runExecutionService.start(scope, { chatId: gate.chatId, content: 'Untracked work' }, { observe() {} })).toThrow('autonomous task')
    stream.mockResolvedValue({ content: '', toolCalls: [{ id: 'gate', name: 'ask_user', input: { question: 'Coordinator question?' } }] })
    const chat = chatRepo.create(USER, { title: 'Coordinator', router: 'coordinator', providerId: 'provider', modelId: 'model' })
    const coordinated = taskRunnerService.start(scope, { chatId: chat.id, goal: 'Coordinate work' })
    await vi.waitFor(() => expect(taskRuntimeRepo.get(USER, coordinated.taskId)?.state).toBe('waiting'))
    taskService.update(USER, coordinated.taskId, { title: 'Renamed coordinator' })
    expect(taskRunnersByChat.get(chat.id)?.taskId).toBe(coordinated.taskId)
    expect(() => runExecutionService.start(scope, { chatId: chat.id, content: 'Untracked work' }, { observe() {} })).toThrow('autonomous task')
  })

  it('refuses a gate answer after Stop begins, until the held agent cancellation settles', async () => {
    let settle: (result: ReturnType<typeof completed>) => void = () => {}
    driverRun.mockImplementation(() => new Promise((resolve) => { settle = resolve }))
    const { taskId } = start([{ id: 'slow', agent: 'writer', prompt: 'Slow work' }, { id: 'gate', ask_user: 'Proceed?' }])
    await vi.waitFor(() => expect(driverRun).toHaveBeenCalledTimes(1))
    await vi.waitFor(() => expect(child(taskId, 'gate').state).toBe('waiting'))
    await new Promise((resolve) => setTimeout(resolve, 0))
    const [gate] = taskInputRequestRepo.listOpenForTask(child(taskId, 'gate').taskId)
    scriptRuntimeService.cancel(USER, taskId)
    expect(await inboxService.answer(USER, gate.id, decision('Too late'))).toMatchObject({ ok: false, code: 'unavailable' })
    expect(taskInputRequestRepo.getById(gate.id)?.status).toBe('open')
    settle(completed('The agent stopped'))
    await vi.waitFor(() => expect(taskService.getById(USER, taskId).status).toBe('cancelled'))
    expect(taskInputRequestRepo.getById(gate.id)?.status).toBe('expired')
    expect(driverRun).toHaveBeenCalledTimes(1)
  })

  it('settles all child gates when the parent is canceled through ordinary task controls', async () => {
    const { taskId, runId } = start([{ id: 'one', ask_user: 'One?' }, { id: 'two', ask_user: 'Two?' }])
    await vi.waitFor(() => expect(scriptRuntimeRepo.get(USER, taskId)?.state).toBe('waiting'))
    expect(taskInputRequestRepo.listOpen(USER)).toHaveLength(2)
    taskService.setStatus(USER, taskId, 'cancelled')
    expect(scriptRuntimeRepo.get(USER, taskId)?.state).toBe('completed')
    expect(taskInputRequestRepo.listOpen(USER)).toEqual([])
    expect(taskRepo.list(USER, { parentTaskId: taskId }).map((task) => task.status)).toEqual(['cancelled', 'cancelled'])
    expect(jobRunsRepo.getById(USER, runId)?.status).toBe('cancelled')
    expect(taskRunnersByChat.size).toBe(0)
  })

  it('deleting a waiting parent cancels its children and linked attempt', async () => {
    const { taskId, runId } = start([{ id: 'gate', ask_user: 'Proceed?' }])
    await vi.waitFor(() => expect(scriptRuntimeRepo.get(USER, taskId)?.state).toBe('waiting'))
    const gateTask = child(taskId, 'gate').taskId
    taskService.remove(USER, taskId)
    expect(taskService.getById(USER, gateTask).status).toBe('cancelled')
    expect(taskInputRequestRepo.listOpen(USER)).toEqual([])
    expect(jobRunsRepo.getById(USER, runId)?.status).toBe('cancelled')
    expect(taskRunnersByChat.size).toBe(0)
  })

  it('keeps completed step metadata edits harmless while a later gate waits', async () => {
    const { taskId } = start([{ id: 'work', agent: 'analyst', prompt: 'Work' }, { id: 'gate', after: ['work'], ask_user: 'Proceed?' }])
    await vi.waitFor(() => expect(scriptRuntimeRepo.get(USER, taskId)?.state).toBe('waiting'))
    taskService.update(USER, child(taskId, 'work').taskId, { title: 'Reviewed result' })
    expect(scriptRuntimeRepo.get(USER, taskId)?.state).toBe('waiting')
    expect(taskInputRequestRepo.listOpen(USER)).toHaveLength(1)
    expect(taskRunnersByChat.get(child(taskId, 'work').chatId)?.controllerTaskId).toBe(taskId)
  })

  it('closes waiting children and the job after a peer tombstone cascades the parent checkpoint', async () => {
    const { taskId, runId } = start([{ id: 'gate', ask_user: 'Proceed?' }])
    await vi.waitFor(() => expect(scriptRuntimeRepo.get(USER, taskId)?.state).toBe('waiting'))
    await new Promise((resolve) => setTimeout(resolve, 0))
    const gateTaskId = child(taskId, 'gate').taskId
    taskService.removeSyncedTask(USER, taskId)
    expect(scriptRuntimeRepo.get(USER, taskId)).toBeNull()
    expect(taskService.getById(USER, gateTaskId).status).toBe('cancelled')
    expect(taskInputRequestRepo.listOpen(USER)).toEqual([])
    expect(jobRunsRepo.getById(USER, runId)?.status).toBe('cancelled')
    expect(taskRunnersByChat.size).toBe(0)
  })

  it('holds surviving child conversations until agents settle after a parent tombstone', async () => {
    let settle: (result: ReturnType<typeof completed>) => void = () => {}
    driverRun.mockImplementation(() => new Promise((resolve) => { settle = resolve }))
    const { taskId, runId } = start([{ id: 'slow', agent: 'writer', prompt: 'Slow work' }, { id: 'gate', ask_user: 'Proceed?' }])
    await vi.waitFor(() => expect(driverRun).toHaveBeenCalledTimes(1))
    const gateChat = child(taskId, 'gate').chatId
    taskService.removeSyncedTask(USER, taskId)
    expect(taskInputRequestRepo.listOpen(USER)).toEqual([])
    expect(jobRunsRepo.getById(USER, runId)?.status).toBe('cancelled')
    expect(taskRunnersByChat.get(gateChat)?.controllerTaskId).toBe(taskId)
    expect(() => runExecutionService.start(scope, { chatId: gateChat, content: 'Untracked work' }, { observe() {} })).toThrow('autonomous task')
    settle(completed('Stopped'))
    await vi.waitFor(() => expect(taskRunnersByChat.size).toBe(0))
  })

  it('deleting a child conversation cancels the whole script and cannot resurrect gates on restore', async () => {
    const { taskId } = start([{ id: 'gate', ask_user: 'Proceed?' }])
    await vi.waitFor(() => expect(scriptRuntimeRepo.get(USER, taskId)?.state).toBe('waiting'))
    const chatId = child(taskId, 'gate').chatId
    chatService.delete(USER, chatId)
    expect(taskService.getById(USER, taskId).status).toBe('cancelled')
    expect(scriptRuntimeRepo.get(USER, taskId)?.state).toBe('completed')
    chatService.restore(USER, chatId)
    scriptRuntimeService.recover()
    expect(taskInputRequestRepo.listOpen(USER)).toEqual([])
    expect(taskRunnersByChat.size).toBe(0)
  })

  it('retains sibling next-message addresses across successive agent continuations', async () => {
    driverRun.mockImplementationOnce(async (_owner, _row, input) => {
      for (const question of ['First?', 'Second?']) input.onEvent?.({ type: 'needs_input', requestId: question,
        resume: 'next_message', request: { kind: 'question', questions: [{ question, multiSelect: false, options: [] }] } })
      return { ...completed('Two choices needed'), taskState: 'input-required' }
    })
    const { taskId } = start([{ id: 'ask', agent: 'analyst', prompt: 'Ask two questions' }])
    await vi.waitFor(() => expect(scriptRuntimeRepo.get(USER, taskId)?.state).toBe('waiting'))
    const [first, second] = taskInputRequestRepo.listOpenForTask(child(taskId, 'ask').taskId)
    expect(await inboxService.answer(USER, first.id, decision('one'))).toEqual({ ok: true })
    await vi.waitFor(() => expect(scriptRuntimeRepo.get(USER, taskId)?.state).toBe('waiting'))
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(child(taskId, 'ask').lastRunId).not.toBe(second.rootRunId)
    expect(child(taskId, 'ask').pendingRequestIds).toEqual([second.id])
    expect(await inboxService.answer(USER, second.id, decision('two'))).toEqual({ ok: true })
    await vi.waitFor(() => expect(taskService.getById(USER, taskId).status).toBe('completed'))
    expect(driverRun).toHaveBeenCalledTimes(3)
    expect(taskInputRequestRepo.listOpen(USER)).toEqual([])
  })

  it('runs parallel prerequisites, survives a durable gate restart and finishes the same job without a model', async () => {
    const pending = new Map<string, (result: ReturnType<typeof completed>) => void>()
    driverRun.mockImplementation((_owner, row, input) => input.wireContent.includes('FINISH')
      ? Promise.resolve(completed('Verified final output')) : new Promise((resolve) => pending.set(row.id, resolve)))
    const job = makeJob([
      { id: 'analyse', agent: 'analyst', prompt: 'ANALYSE {{goal}}' },
      { id: 'write', agent: 'writer', prompt: 'WRITE {{goal}}' },
      { id: 'gate', after: ['analyse', 'write'], ask_user: 'Accept {{analyse.text}} and {{write.text}}?' },
      { id: 'finish', after: ['gate'], agent: 'analyst', prompt: 'FINISH {{goal}} / {{analyse.text}} / {{write.text}} / {{gate.text}}' }
    ])
    const result = await jobService.execute(USER, job.id, USER)
    expect(result).toMatchObject({ type: 'local', execution: 'main' })
    const taskId = result.taskId
    await vi.waitFor(() => expect(pending.size).toBe(2))
    expect(taskService.getById(USER, taskId).status).toBe('in_progress')
    expect(new Set(Object.values(scriptRuntimeRepo.get(USER, taskId)!.steps).map((s) => s.chatId)).size).toBe(4)
    pending.get('analyst')!(completed('Analysis {{goal}}'))
    await vi.waitFor(() => expect(child(taskId, 'analyse').state).toBe('completed'))
    expect(taskInputRequestRepo.listOpen(USER)).toEqual([])
    pending.get('writer')!(completed('Written guide'))
    await vi.waitFor(() => expect(scriptRuntimeRepo.get(USER, taskId)?.state).toBe('waiting'))
    const [gate] = taskInputRequestRepo.listOpenForTask(child(taskId, 'gate').taskId)
    expect(gate.request).toMatchObject({ questions: [{ question: 'Accept Analysis {{goal}} and Written guide?' }] })
    expect(taskService.getById(USER, taskId).status).toBe('blocked')
    expect(jobRunsRepo.getById(USER, result.runId)?.status).toBe('running')
    taskRunnersByChat.clear()
    scriptRuntimeService.recover()
    expect(taskInputRequestRepo.listOpenForTask(child(taskId, 'gate').taskId)[0].id).toBe(gate.id)
    expect(driverRun).toHaveBeenCalledTimes(2)
    expect(await inboxService.answer(USER, gate.id, decision('Ship it'))).toEqual({ ok: true })
    await vi.waitFor(() => expect(taskService.getById(USER, taskId).status).toBe('completed'))
    expect(driverRun).toHaveBeenCalledTimes(3)
    expect(driverRun.mock.calls[2][2].wireContent).toContain('FINISH Ship a guide / Analysis {{goal}} / Written guide / Ship it')
    expect(jobRunsRepo.getById(USER, result.runId)).toMatchObject({ taskId, status: 'succeeded' })
    expect(taskRepo.list(USER, { parentTaskId: taskId }).every((task) => task.status === 'completed' && task.jobId === null && task.jobRunId === null)).toBe(true)
    expect(scriptRuntimeRepo.get(USER, taskId)).toMatchObject({ state: 'completed', ownerTurns: 3 })
    expect(taskInputRequestRepo.listOpen(USER)).toEqual([])
    expect(stream).not.toHaveBeenCalled()
    expect(taskRunnersByChat.size).toBe(0)
  })

  it('answers a settled gate while an unrelated agent is active and admits its dependent step immediately', async () => {
    let release: (result: ReturnType<typeof completed>) => void = () => {}
    driverRun.mockImplementation((_owner, row) => row.id === 'writer' ? new Promise((resolve) => { release = resolve }) : Promise.resolve(completed('Follow-up complete')))
    const { taskId } = start([{ id: 'slow', agent: 'writer', prompt: 'Slow work' }, { id: 'gate', ask_user: 'Pick a branch' },
      { id: 'follow', after: ['gate'], agent: 'analyst', prompt: 'Use {{gate.text}}' }])
    await vi.waitFor(() => expect(child(taskId, 'gate').state).toBe('waiting'))
    await new Promise((resolve) => setTimeout(resolve, 0))
    const [gate] = taskInputRequestRepo.listOpenForTask(child(taskId, 'gate').taskId)
    expect(await inboxService.answer(USER, gate.id, decision('main'))).toEqual({ ok: true })
    await vi.waitFor(() => expect(child(taskId, 'follow').state).toBe('completed'))
    expect(child(taskId, 'slow').state).toBe('running')
    release(completed('Slow complete'))
    await vi.waitFor(() => expect(taskService.getById(USER, taskId).status).toBe('completed'))
  })

  it('charges a global agent-turn budget atomically across parallel steps', async () => {
    const { taskId } = start([{ id: 'a', agent: 'analyst', prompt: 'A' }, { id: 'b', agent: 'writer', prompt: 'B' }], { maxRounds: 1 })
    await vi.waitFor(() => expect(taskService.getById(USER, taskId).status).toBe('error'))
    expect(driverRun).toHaveBeenCalledTimes(1)
    expect(scriptRuntimeRepo.get(USER, taskId)?.ownerTurns).toBe(1)
    expect(taskService.getById(USER, taskId).errorMessage).toContain('agent-turn limit')
  })

  it('stops a silent agent at the time limit and cancels a queued sibling before dispatch', async () => {
    appSettingsRepo.set('taskRunnerConcurrency', 1)
    driverRun.mockImplementation((_owner, _row, input) => new Promise((resolve) => input.signal?.addEventListener('abort', () => resolve({ ...completed('partial'), taskState: 'canceled' }), { once: true })))
    const { taskId } = start([{ id: 'a', agent: 'analyst', prompt: 'A' }, { id: 'b', agent: 'writer', prompt: 'B' }], { maxMinutes: 0.002 })
    await vi.waitFor(() => expect(taskService.getById(USER, taskId).status).toBe('error'))
    expect(driverRun).toHaveBeenCalledTimes(1)
    expect(taskService.getById(USER, taskId).errorMessage).toContain('time limit')
    expect(taskRunnersByChat.size).toBe(0)
  })

  it('reconciles only the interrupted step after explicit Resume and never replays a completed sibling', async () => {
    driverRun.mockImplementation((_owner, row, input) => row.id === 'analyst' ? Promise.resolve(completed('Analysis saved')) :
      new Promise((resolve) => input.signal?.addEventListener('abort', () => resolve({ ...completed('partial'), taskState: 'canceled' }), { once: true })))
    const { taskId } = start([{ id: 'a', agent: 'analyst', prompt: 'ANALYSE' }, { id: 'b', agent: 'writer', prompt: 'WRITE' }])
    await vi.waitFor(() => expect(child(taskId, 'a').state).toBe('completed'))
    await vi.waitFor(() => expect(child(taskId, 'b').state).toBe('running'))
    scriptRuntimeService.interruptAll('App closed')
    await vi.waitFor(() => expect(activeRunsByChat.size).toBe(0))
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(scriptRuntimeRepo.get(USER, taskId)?.state).toBe('interrupted')
    scriptRuntimeService.recover()
    expect(taskService.getById(USER, child(taskId, 'b').taskId).status).toBe('blocked')
    expect(taskService.getById(USER, child(taskId, 'a').taskId).status).toBe('completed')
    expect(driverRun).toHaveBeenCalledTimes(2)
    driverRun.mockResolvedValue(completed('Reconciled written output'))
    scriptRuntimeService.resume(USER, taskId)
    await vi.waitFor(() => expect(taskService.getById(USER, taskId).status).toBe('completed'))
    expect(driverRun).toHaveBeenCalledTimes(3)
    expect(driverRun.mock.calls[2][1].id).toBe('writer')
    expect(driverRun.mock.calls[2][2].wireContent).toContain('Do not repeat completed side effects')
    expect(child(taskId, 'a').text).toBe('Analysis saved')
  })

  it('refuses missing targets and unsupported token limits before creating chats or tasks', () => {
    const missing = makeJob([{ id: 'a', agent: 'analyst', prompt: 'A' }])
    state.database!.raw.prepare('DELETE FROM agents WHERE id = ?').run('analyst')
    expect(() => scriptRuntimeService.startJob(scope, missing)).toThrow('not available')
    const limited = makeJob([{ id: 'gate', ask_user: 'Proceed?' }], { maxTokens: 1 })
    expect(() => scriptRuntimeService.startJob(scope, limited)).toThrow('usage reporting')
    expect(taskRepo.list(USER)).toEqual([])
    expect(chatRepo.list(USER)).toEqual([])
    expect(jobRunsRepo.listByJob(USER, missing.id)).toEqual([])
    expect(driverRun).not.toHaveBeenCalled()
  })
})
