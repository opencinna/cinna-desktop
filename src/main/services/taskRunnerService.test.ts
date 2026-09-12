import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createTestDatabase, type TestDatabase } from '../db/testSupport/nodeSqlite'
import type { LLMAdapter, StreamParams, StreamResult } from '../llm/types'
import type { AgentDriver } from '../agents/drivers/driver'
import type { AgentRow } from '../db/agents'

const state = vi.hoisted(() => ({ database: null as TestDatabase | null, agents: [] as AgentRow[] }))
const stream = vi.hoisted(() => vi.fn<(input: StreamParams) => Promise<StreamResult>>())
const driverRun = vi.hoisted(() => vi.fn<AgentDriver['run']>())
vi.mock('../db/client', () => ({ getDb: () => state.database!.db, getRawSqlite: () => state.database!.sqlite }))
vi.mock('../db/sync', () => ({ syncRepo: { getState: () => null } }))
vi.mock('../logger/logger', () => ({ createLogger: () => ({ info() {}, debug() {}, warn() {}, error() {} }) }))
vi.mock('../auth/scope', () => ({ getSettingsScopeUserId: () => '__default__', getAgentLookupScope: () => '__default__' }))
vi.mock('../mcp/manager', () => ({ mcpManager: { getConnection: () => null } }))
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

const { taskRunnerService } = await import('./taskRunnerService')
const { taskService } = await import('./taskService')
const { inboxService } = await import('./inboxService')
const { taskRuntimeRepo } = await import('../db/taskRuntimes')
const { taskInputRequestRepo } = await import('../db/taskInputRequests')
const { turnLock } = await import('./localAgents/turnLock')
const { chatRepo } = await import('../db/chats')
const { chatOnDemandAgentRepo } = await import('../db/chatOnDemandAgent')
const { taskRunnersByChat } = await import('./taskRunnerState')
const { activeRunsByChat } = await import('./runExecutionState')
const USER = '__default__'
const scope = { profileUserId: USER, settingsUserId: USER }
let chatId: string
const tool = (name: string, input: Record<string, unknown>): StreamResult => ({ content: '', toolCalls: [{ id: `call-${name}`, name, input }] })

beforeEach(() => {
  state.database = createTestDatabase()
  stream.mockReset()
  driverRun.mockReset().mockImplementation(async (_owner, row) => ({ text: `${row.name} result`, parts: [{ kind: 'text', text: `${row.name} result` }], notices: [], taskState: 'completed' }))
  state.agents = ['Analyst', 'Writer'].map((name) => ({ id: name.toLowerCase(), name, driver: 'a2a', enabled: true, userId: USER } as AgentRow))
  for (const row of state.agents) state.database.raw.prepare(`INSERT INTO agents (id, user_id, name, protocol, enabled, source, driver, created_at)
    VALUES (?, ?, ?, 'a2a', 1, 'local', 'a2a', 1)`).run(row.id, USER, row.name)
  const chat = chatRepo.create(USER, { title: 'Work', router: 'coordinator', providerId: 'provider', modelId: 'model' })
  chatId = chat.id
  for (const row of state.agents) chatOnDemandAgentRepo.add(chatId, row.id)
})
afterEach(async () => {
  for (const entry of taskRunnersByChat.values()) { try { entry.cancel() } catch { /* already terminal */ } }
  await vi.waitFor(() => expect(activeRunsByChat.size).toBe(0))
  await new Promise((resolve) => setTimeout(resolve, 0))
  taskRunnersByChat.clear()
  turnLock.releaseAll()
  state.database?.close()
  state.database = null
})

describe('autonomous coordinator runner', () => {
  it('delegates, waits for a durable gate, hands off with context, hands back and finishes without a view', async () => {
    stream.mockResolvedValueOnce(tool('delegate', { agent: 'Analyst', message: 'Analyse the goal' }))
      .mockResolvedValueOnce(tool('ask_user', { question: 'Which branch?' }))
      .mockResolvedValueOnce(tool('handoff', { agent: 'Writer', note: 'Use the analysis and selected branch' }))
      .mockResolvedValueOnce(tool('finish', { summary: 'Goal completed and verified' }))
    const { taskId } = taskRunnerService.start(scope, { chatId, goal: 'Ship the feature' })
    await vi.waitFor(() => expect(taskRuntimeRepo.get(USER, taskId)?.state).toBe('waiting'))
    expect(taskService.getById(USER, taskId).status).toBe('blocked')
    expect(stream).toHaveBeenCalledTimes(2)
    expect(stream.mock.calls[0][0].tools?.map((definition) => definition.name)).toEqual(['delegate', 'handoff', 'ask_user', 'update_task', 'finish'])
    const [gate] = taskInputRequestRepo.listOpenForTask(taskId)
    expect(gate).toMatchObject({ deliveryOwner: 'runner', agentId: null, resume: 'reply' })
    expect(taskInputRequestRepo.expireOpen()).toBe(0)
    expect(await inboxService.answer(USER, gate.id, { kind: 'question', answers: [['main']] })).toEqual({ ok: true })
    await vi.waitFor(() => expect(taskService.getById(USER, taskId).status).toBe('completed'))
    expect(driverRun).toHaveBeenCalledTimes(2)
    expect(driverRun.mock.calls.find((call) => call[1].id === 'analyst')![2].handbackEligible).toBeUndefined()
    const writer = driverRun.mock.calls.find((call) => call[1].id === 'writer')![2].wireContent
    for (const phrase of ['Ship the feature', 'Analyst result', 'main', 'Use the analysis']) expect(writer).toContain(phrase)
    expect(stream).toHaveBeenCalledTimes(4)
    expect(stream.mock.calls[3][0].messages.some((row) => row.role === 'user' && row.content.includes('Writer handed the task back to the coordinator.'))).toBe(true)
    expect(taskRuntimeRepo.get(USER, taskId)).toMatchObject({ state: 'completed', ownerTurns: 4 })
    const rows = chatRepo.listMessages(chatId)
    expect(rows.filter((row) => row.content === 'Goal completed and verified')).toHaveLength(1)
    expect(rows.find((row) => row.toolName === 'delegate')).toMatchObject({ toolAgentId: 'analyst', content: 'Analyst result' })
    expect(rows.filter((row) => row.role === 'user').map((row) => row.content)).toEqual(['Ship the feature', 'main'])
    expect(taskInputRequestRepo.listOpenForTask(taskId)).toEqual([])
    expect(taskRunnersByChat.has(chatId)).toBe(false)
  })

  it('carries an authorized specialist handback note into the existing coordinator continuation', async () => {
    stream.mockResolvedValueOnce(tool('handoff', { agent: 'Writer', note: 'Produce and verify the report' }))
      .mockResolvedValueOnce(tool('finish', { summary: 'Done after review' }))
    driverRun.mockResolvedValueOnce({ text: 'Report ready.\n/handback Verified report.md', parts: [{ kind: 'text', text: 'Report ready.' }],
      notices: [], taskState: 'completed', handback: { note: 'Verified report.md' } })
    const { taskId } = taskRunnerService.start(scope, { chatId, goal: 'Ship the report' })
    await vi.waitFor(() => expect(taskService.getById(USER, taskId).status).toBe('completed'))
    expect(driverRun.mock.calls[0][2].handbackEligible).toBe(true)
    expect(stream.mock.calls[1][0].messages.some((row) => row.content.includes('Agent-provided handback note: "Verified report.md"'))).toBe(true)
    expect(chatRepo.listMessages(chatId).some((row) => row.content.includes('Agent-provided handback note: "Verified report.md"'))).toBe(true)
  })

  it('does not use a handback result to bypass a specialist’s durable question', async () => {
    stream.mockResolvedValueOnce(tool('handoff', { agent: 'Writer', note: 'Confirm the branch' }))
    driverRun.mockImplementationOnce(async (_owner, _row, input) => {
      input.onEvent?.({ type: 'needs_input', requestId: 'branch', resume: 'next_message',
        request: { kind: 'question', questions: [{ question: 'Which branch?', multiSelect: false, options: [] }] } })
      return { text: '/handback Not ready', parts: [], notices: [], taskState: 'input-required', handback: { note: 'Not ready' } }
    })
    const { taskId } = taskRunnerService.start(scope, { chatId, goal: 'Ship the report' })
    await vi.waitFor(() => expect(taskRuntimeRepo.get(USER, taskId)?.state).toBe('waiting'))
    expect(stream).toHaveBeenCalledTimes(1)
    expect(taskRuntimeRepo.get(USER, taskId)?.owner).toMatchObject({ kind: 'agent', agentId: 'writer' })
    expect(chatRepo.listMessages(chatId).some((row) => row.content.includes('handed the task back'))).toBe(false)
  })

  it('bounds natural model continuations by owner turns instead of falsely completing', async () => {
    stream.mockResolvedValue({ content: 'More work remains', toolCalls: [] })
    const { taskId } = taskRunnerService.start(scope, { chatId, goal: 'Keep working', budget: { maxRounds: 2 } })
    await vi.waitFor(() => expect(taskService.getById(USER, taskId).status).toBe('error'))
    expect(stream).toHaveBeenCalledTimes(2)
    expect(taskService.getById(USER, taskId).errorMessage).toContain('owner-turn limit')
    expect(chatRepo.listMessages(chatId).filter((row) => row.role === 'user')).toHaveLength(1)
  })

  it('aborts an in-flight silent model when its time budget expires', async () => {
    stream.mockImplementation((input) => new Promise((_resolve, reject) => {
      input.signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true })
    }))
    const { taskId } = taskRunnerService.start(scope, { chatId, goal: 'Work', budget: { maxMinutes: 0.001 } })
    await vi.waitFor(() => expect(taskService.getById(USER, taskId).status).toBe('error'))
    expect(taskService.getById(USER, taskId).errorMessage).toContain('time limit')
    expect(activeRunsByChat.size).toBe(0)
  })

  it('refuses unsupported token limits before making a task or calling a participant', () => {
    expect(() => taskRunnerService.start(scope, { chatId, goal: 'Work', budget: { maxTokens: 1 } })).toThrow('usage reporting')
    expect(stream).not.toHaveBeenCalled()
    expect(driverRun).not.toHaveBeenCalled()
    expect(taskRunnersByChat.has(chatId)).toBe(false)
    expect(chatRepo.listMessages(chatId)).toEqual([])
  })

  it('preserves a durable gate and repairs an interrupted tool batch without replaying its side effects', async () => {
    stream.mockResolvedValueOnce(tool('ask_user', { question: 'Which branch?' }))
      .mockResolvedValueOnce(tool('finish', { summary: 'Recovered and done' }))
    const { taskId } = taskRunnerService.start(scope, { chatId, goal: 'Recover safely' })
    await vi.waitFor(() => expect(taskRuntimeRepo.get(USER, taskId)?.state).toBe('waiting'))
    await new Promise((resolve) => setTimeout(resolve, 0))
    const [gate] = taskInputRequestRepo.listOpenForTask(taskId)
    // Crash after committing the gate but before saving the model tool result.
    state.database!.raw.prepare("DELETE FROM messages WHERE chat_id = ? AND role = 'tool_call'").run(chatId)
    taskRuntimeRepo.save(USER, taskId, { ...taskRuntimeRepo.get(USER, taskId)!, state: 'running' })
    taskRunnersByChat.clear()
    taskRunnerService.recover()
    expect(taskRuntimeRepo.get(USER, taskId)?.state).toBe('interrupted')
    taskRunnerService.resume(USER, taskId)
    expect(taskRuntimeRepo.get(USER, taskId)?.state).toBe('waiting')
    expect(taskInputRequestRepo.listOpenForTask(taskId).map((row) => row.id)).toEqual([gate.id])
    expect(chatRepo.listMessages(chatId).find((row) => row.toolCallId === 'call-ask_user' && row.role === 'tool_call'))
      .toMatchObject({ toolError: false, content: 'Waiting for a human answer: Which branch?' })
    expect(stream).toHaveBeenCalledTimes(1)
    expect(await inboxService.answer(USER, gate.id, { kind: 'question', answers: [['main']] })).toEqual({ ok: true })
    await vi.waitFor(() => expect(taskService.getById(USER, taskId).status).toBe('completed'))
  })

  it('rolls back terminal checkpoint and gate settlement when a task status write fails', async () => {
    stream.mockResolvedValueOnce(tool('ask_user', { question: 'Continue?' }))
    const { taskId } = taskRunnerService.start(scope, { chatId, goal: 'Work' })
    await vi.waitFor(() => expect(taskRuntimeRepo.get(USER, taskId)?.state).toBe('waiting'))
    await new Promise((resolve) => setTimeout(resolve, 0))
    const failure = vi.spyOn(taskService, 'setStatus').mockImplementationOnce(() => { throw new Error('disk unavailable') })
    try {
      expect(() => taskRunnerService.cancel(USER, taskId)).toThrow('disk unavailable')
      expect(taskRuntimeRepo.get(USER, taskId)?.state).toBe('waiting')
      expect(taskService.getById(USER, taskId).status).toBe('blocked')
      expect(taskInputRequestRepo.listOpenForTask(taskId)).toHaveLength(1)
      expect(taskRunnersByChat.has(chatId)).toBe(true)
    } finally { failure.mockRestore() }
    taskRunnerService.cancel(USER, taskId)
    expect(taskService.getById(USER, taskId).status).toBe('cancelled')
    expect(taskInputRequestRepo.listOpenForTask(taskId)).toEqual([])
  })

  it('interrupts a silent turn and resumes with a new conversational input instead of replaying the goal', async () => {
    stream.mockImplementationOnce((input) => new Promise((_resolve, reject) => {
      input.signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true })
    })).mockResolvedValueOnce(tool('finish', { summary: 'Resumed safely' }))
    const { taskId } = taskRunnerService.start(scope, { chatId, goal: 'Initial goal' })
    await vi.waitFor(() => expect(stream).toHaveBeenCalledTimes(1))
    taskRunnerService.interruptAll('App is closing')
    await vi.waitFor(() => expect(activeRunsByChat.size).toBe(0))
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(taskRuntimeRepo.get(USER, taskId)?.state).toBe('interrupted')
    expect(taskService.getById(USER, taskId).status).toBe('blocked')
    taskRunnerService.resume(USER, taskId)
    await vi.waitFor(() => expect(taskService.getById(USER, taskId).status).toBe('completed'))
    const resumed = stream.mock.calls[1][0].messages
    expect(resumed.find((row) => row.content.startsWith('The previous execution was interrupted.'))?.role).toBe('user')
    expect(chatRepo.listMessages(chatId).filter((row) => row.role === 'user').map((row) => row.content)).toEqual(['Initial goal'])
  })

  it('rechecks a handed-off agent after waiting for an editor lock', async () => {
    const lock = turnLock.acquire('writer', 'editor')
    stream.mockResolvedValueOnce(tool('handoff', { agent: 'Writer', note: 'Implement it' }))
    const { taskId } = taskRunnerService.start(scope, { chatId, goal: 'Work' })
    await vi.waitFor(() => expect(taskRuntimeRepo.get(USER, taskId)?.owner.kind).toBe('agent'))
    chatOnDemandAgentRepo.remove(chatId, 'writer')
    lock.release()
    await vi.waitFor(() => expect(taskService.getById(USER, taskId).status).toBe('error'))
    expect(driverRun).not.toHaveBeenCalled()
    expect(taskService.getById(USER, taskId).errorMessage).toContain('no longer enabled and attached')
  })

  it('keeps sibling continuation addresses answerable after the first answer starts another root run', async () => {
    stream.mockResolvedValueOnce(tool('delegate', { agent: 'Analyst', message: 'Ask for two decisions' }))
      .mockResolvedValueOnce(tool('finish', { summary: 'Both answers handled' }))
    driverRun.mockImplementationOnce(async (_owner, _row, input) => {
      for (const question of ['First choice?', 'Second choice?']) input.onEvent?.({ type: 'needs_input', requestId: question,
        resume: 'next_message', request: { kind: 'question', questions: [{ question, multiSelect: false, options: [] }] } })
      return { text: 'Two answers needed', parts: [], notices: [], taskState: 'input-required' }
    })
    const { taskId } = taskRunnerService.start(scope, { chatId, goal: 'Make both decisions' })
    await vi.waitFor(() => expect(taskRuntimeRepo.get(USER, taskId)?.state).toBe('waiting'))
    await new Promise((resolve) => setTimeout(resolve, 0))
    const [first, second] = taskInputRequestRepo.listOpenForTask(taskId)
    expect(second).toBeDefined()
    expect(await inboxService.answer(USER, first.id, { kind: 'question', answers: [['one']] })).toEqual({ ok: true })
    await vi.waitFor(() => expect(taskRuntimeRepo.get(USER, taskId)?.state).toBe('waiting'))
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(taskRuntimeRepo.get(USER, taskId)?.lastRunId).not.toBe(second.rootRunId)
    expect(taskRuntimeRepo.get(USER, taskId)?.pendingRequestIds).toEqual([second.id])
    expect(taskService.getById(USER, taskId).status).toBe('blocked')
    expect(await inboxService.answer(USER, second.id, { kind: 'question', answers: [['two']] })).toEqual({ ok: true })
    await vi.waitFor(() => expect(taskService.getById(USER, taskId).status).toBe('completed'))
    expect(driverRun).toHaveBeenCalledTimes(3)
    expect(stream).toHaveBeenCalledTimes(2)
    expect(taskInputRequestRepo.listOpenForTask(taskId)).toEqual([])
  })

  it('refuses a changed goal when restarting an existing task', async () => {
    stream.mockResolvedValue({ content: 'Unfinished', toolCalls: [] })
    const { taskId } = taskRunnerService.start(scope, { chatId, goal: 'Original goal', budget: { maxRounds: 1 } })
    await vi.waitFor(() => expect(taskService.getById(USER, taskId).status).toBe('error'))
    expect(() => taskRunnerService.start(scope, { chatId, goal: 'Different goal' })).toThrow('original goal')
    expect(stream).toHaveBeenCalledTimes(1)
  })

  it('cancels a waiting task when its conversation is deleted and cannot resurrect its gate on restore', async () => {
    stream.mockResolvedValueOnce(tool('ask_user', { question: 'Continue?' }))
    const { taskId } = taskRunnerService.start(scope, { chatId, goal: 'Work' })
    await vi.waitFor(() => expect(taskRuntimeRepo.get(USER, taskId)?.state).toBe('waiting'))
    const { chatService } = await import('./chatService')
    chatService.delete(USER, chatId)
    expect(taskService.getById(USER, taskId).status).toBe('cancelled')
    expect(taskRuntimeRepo.get(USER, taskId)?.state).toBe('completed')
    expect(taskInputRequestRepo.listOpenForTask(taskId)).toEqual([])
    chatService.restore(USER, chatId)
    taskRunnerService.recover()
    expect(taskRunnersByChat.has(chatId)).toBe(false)
  })

  it('durably cancels an active task before its deleted conversation can strand cleanup', async () => {
    stream.mockImplementation((input) => new Promise((_resolve, reject) => {
      input.signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true })
    }))
    const { taskId } = taskRunnerService.start(scope, { chatId, goal: 'Work' })
    await vi.waitFor(() => expect(stream).toHaveBeenCalledTimes(1))
    const { chatService } = await import('./chatService')
    chatService.delete(USER, chatId)
    await vi.waitFor(() => expect(activeRunsByChat.size).toBe(0))
    expect(taskRuntimeRepo.get(USER, taskId)?.state).toBe('completed')
    expect(taskService.getById(USER, taskId).status).toBe('cancelled')
    expect(taskRunnersByChat.has(chatId)).toBe(false)
  })

  it('requires explicit recovery when a driver needs input but its durable question could not be written', async () => {
    stream.mockResolvedValueOnce(tool('handoff', { agent: 'Writer', note: 'Ask a question' }))
    const write = vi.spyOn(taskInputRequestRepo, 'open').mockImplementationOnce(() => { throw new Error('disk unavailable') })
    driverRun.mockImplementationOnce(async (_owner, _row, input) => {
      input.onEvent?.({ type: 'needs_input', requestId: 'lost-question', resume: 'next_message',
        request: { kind: 'question', questions: [{ question: 'Continue?', multiSelect: false, options: [] }] } })
      return { text: 'Need an answer', parts: [], notices: [], taskState: 'input-required' }
    })
    try {
      const { taskId } = taskRunnerService.start(scope, { chatId, goal: 'Work' })
      await vi.waitFor(() => expect(taskRuntimeRepo.get(USER, taskId)?.state).toBe('interrupted'))
      expect(taskInputRequestRepo.listOpenForTask(taskId)).toEqual([])
      expect(taskService.getById(USER, taskId).status).toBe('blocked')
      expect(taskRuntimeRepo.get(USER, taskId)?.reason).toContain('no answerable question was saved')
      expect(stream).toHaveBeenCalledTimes(1)
    } finally { write.mockRestore() }
  })

})
