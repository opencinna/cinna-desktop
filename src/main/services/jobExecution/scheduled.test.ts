import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createTestDatabase, type TestDatabase } from '../../db/testSupport/nodeSqlite'
import type { AgentDriver } from '../../agents/drivers/driver'
import type { AgentRow } from '../../db/agents'

const state = vi.hoisted(() => ({ database: null as TestDatabase | null, agents: [] as AgentRow[] }))
const driverRun = vi.hoisted(() => vi.fn<AgentDriver['run']>())
const resolveModel = vi.hoisted(() => vi.fn())
vi.mock('../../db/client', () => ({ getDb: () => state.database!.db, getRawSqlite: () => state.database!.sqlite }))
vi.mock('../../db/sync', () => ({ syncRepo: { getState: () => null } }))
vi.mock('../../logger/logger', () => ({ createLogger: () => ({ info() {}, debug() {}, warn() {}, error() {} }) }))
vi.mock('../../auth/scope', () => ({ getSettingsScopeUserId: () => '__default__', getAgentLookupScope: () => ['__default__'] }))
vi.mock('../../mcp/manager', () => ({ mcpManager: { getConnection: () => null } }))
vi.mock('../cinnaApiService', () => ({ getCinnaServerUrl: () => null, cinnaApiService: {} }))
vi.mock('../syncService', () => ({ syncService: { markDirty() {} } }))
vi.mock('../fileStore', () => ({ attachmentToMediaPart: async () => null }))
vi.mock('../taskModelConfig', () => ({ resolveTaskModelConfig: resolveModel }))
vi.mock('../chatConductorService', () => ({ chatConductorService: { remove() {}, bind: (_user: string, chat: { id: string }) => {
  state.database!.raw.prepare('UPDATE chats SET agent_id = ? WHERE id = ?').run('runtime', chat.id)
  return { ...chat, agentId: 'runtime' }
} } }))
vi.mock('../taskFileService', () => ({ taskFileService: { exportHandoff() {}, removeHandoff() {} } }))
vi.mock('../chatTitleService', () => ({ chatTitleService: { autoGenerateForFirstMessage: async () => {} }, ChatTitleError: class extends Error {} }))
vi.mock('../agentService', () => ({ agentService: {
  findAgent: (_settings: string, _user: string, id: string) => { const row = state.agents.find(agent => agent.id === id); return row ? { row, userId: '__default__' } : null },
  listMerged: () => state.agents
} }))
vi.mock('../../agents/drivers', () => ({ driverFor: () => ({ run: driverRun, capabilities: () => ({ commands: { source: 'none' } }) }) }))
vi.mock('../localAgents/commandService', () => ({ resolveCommandRunner: (_cap: unknown, _wire: string, _user: string, _agent: string, run: unknown) => run }))

const { prepareScheduledJob, interruptScheduledOrdinaryJob } = await import('./scheduled')
const { jobsRepo, jobAgentRepo, jobRunsRepo } = await import('../../db/jobs')
const { taskRepo } = await import('../../db/tasks')
const { chatRepo } = await import('../../db/chats')
const { scriptRuntimeRepo } = await import('../../db/scriptRuntimes')
const { taskRuntimeRepo } = await import('../../db/taskRuntimes')
const { taskInputRequestRepo } = await import('../../db/taskInputRequests')
const { taskRunnersByChat } = await import('../taskRunnerState')
const { activeRunsByChat } = await import('../runExecutionState')
const { taskRunnerService } = await import('../taskRunnerService')
const { scriptRuntimeService } = await import('../scriptRuntimeService')
const { runExecutionService } = await import('../runExecutionService')
const { messageRoutingService } = await import('../messageRoutingService')
const { turnLock } = await import('../localAgents/turnLock')
const USER = '__default__'
const scope = { profileUserId: USER, settingsUserId: USER }

beforeEach(() => {
  state.database = createTestDatabase()
  state.agents = ['worker', 'second', 'runtime'].map(id => ({ id, name: id, driver: 'acp', source: 'local', enabled: true, userId: USER, cardUrl: `http://localhost/${id}` } as AgentRow))
  for (const row of state.agents) state.database.raw.prepare(`INSERT INTO agents (id,user_id,name,protocol,enabled,source,driver,card_url,created_at) VALUES (?,?,?,'acp',1,'local','acp',?,1)`).run(row.id, USER, row.name, row.cardUrl)
  resolveModel.mockReset().mockResolvedValue({ modeId: 'mode', providerId: 'provider', modelId: 'model', mcpIds: [], assertCurrent() {} })
  driverRun.mockReset().mockImplementation(async (_owner, _agent, input) => {
    if (input.coordinator) {
      const result = await input.coordinator.callTool('finish', { summary: 'Verified work' }, { toolCallId: 'finish', signal: input.signal, onEvent: input.onEvent })
      return { text: 'Verified work', parts: [], notices: [], control: result.control }
    }
    return { text: 'Verified work', parts: [], notices: [], taskState: 'completed' }
  })
})
afterEach(async () => {
  vi.restoreAllMocks()
  for (const entry of taskRunnersByChat.values()) { try { entry.cancel() } catch { /* already terminal */ } }
  await vi.waitFor(() => expect(activeRunsByChat.size).toBe(0))
  await new Promise(resolve => setTimeout(resolve, 0))
  taskRunnersByChat.clear()
  state.database?.close(); state.database = null
})
function jobFor(route: 'ordinary' | 'coordinator' | 'script') {
  const job = jobsRepo.create(USER, { type: 'local', title: 'Existing job', prompt: 'Keep the original literal {{goal}}.',
    ...(route === 'coordinator' ? { router: 'coordinator' as const } : {}),
    ...(route === 'script' ? { router: 'script' as const, script: { version: 1 as const, agents: { worker: { kind: 'agent' as const, source: 'local' as const, cardUrl: 'http://localhost/worker' } }, steps: [{ id: 'work', agent: 'worker', prompt: '{{goal}}' }] } } : {}) })
  if (route !== 'script') jobAgentRepo.setAgentIds(job.id, ['worker'])
  return jobsRepo.getById(USER, job.id)!
}

describe('main-owned scheduled Job execution', () => {
  it.each(['ordinary', 'coordinator', 'script'] as const)('prepares %s transactionally and launches against the unchanged source Job', async route => {
    const job = jobFor(route)
    const factory = await prepareScheduledJob(scope, job, () => true)
    expect(taskRepo.list(USER)).toEqual([])
    expect(driverRun).not.toHaveBeenCalled()
    const prepared = state.database!.db.transaction(() => factory())
    expect(driverRun).not.toHaveBeenCalled()
    expect(jobRunsRepo.getById(USER, prepared.runId)).toMatchObject({ jobId: job.id, taskId: prepared.taskId })
    prepared.launch()
    await vi.waitFor(() => expect(taskRepo.getById(USER, prepared.taskId)?.status).toBe('completed'))
    expect(jobRunsRepo.getById(USER, prepared.runId)?.status).toBe('succeeded')
    expect(jobsRepo.getById(USER, job.id)).toEqual(job)
    expect(driverRun).toHaveBeenCalledTimes(1)
    expect(driverRun.mock.calls[0][2].wireContent).toContain(job.prompt)
    expect(() => prepared.launch()).toThrow()
  })

  it.each(['ordinary', 'coordinator', 'script'] as const)('rolls %s preparation back with the outer receipt transaction and prevents launch inside it', async route => {
    const job = jobFor(route)
    const factory = await prepareScheduledJob(scope, job, () => true)
    expect(() => state.database!.db.transaction(() => {
      const prepared = factory()
      expect(() => prepared.launch()).toThrow('Commit')
      throw new Error('Receipt insertion failed')
    })).toThrow('Receipt insertion failed')
    expect(taskRepo.list(USER)).toEqual([])
    expect(jobRunsRepo.listByJob(USER, job.id)).toEqual([])
    expect(taskRunnersByChat.size).toBe(0)
    expect(driverRun).not.toHaveBeenCalled()
  })

  it.each(['ordinary', 'coordinator', 'script'] as const)('refuses %s admission after a profile switch and records a committed interrupted attempt explicitly', async route => {
    const job = jobFor(route)
    let current = true
    const factory = await prepareScheduledJob(scope, job, () => current)
    current = false
    expect(factory).toThrow('profile changed')
    expect(taskRepo.list(USER)).toEqual([])
    current = true
    const prepared = factory()
    current = false
    expect(() => prepared.launch()).toThrow('profile changed')
    prepared.interrupt('Profile changed before launch')
    expect(taskRepo.getById(USER, prepared.taskId)?.status).toBe('blocked')
    if (route === 'script') expect(scriptRuntimeRepo.get(USER, prepared.taskId)?.state).toBe('interrupted')
    if (route === 'coordinator') expect(taskRuntimeRepo.get(USER, prepared.taskId)?.state).toBe('interrupted')
    expect(driverRun).not.toHaveBeenCalled()
  })

  it('does not start an ordinary Job on an agent still in a turn, and leaves it for review', async () => {
    const job = jobFor('ordinary')
    const factory = await prepareScheduledJob(scope, job, () => true)
    const prepared = state.database!.db.transaction(() => factory())
    const held = turnLock.acquire('worker', 'earlier turn')
    try {
      expect(() => prepared.launch()).toThrow('still busy')
    } finally {
      held.release()
    }
    expect(driverRun).not.toHaveBeenCalled()
    prepared.interrupt('The agent was still busy')
    expect(taskRepo.getById(USER, prepared.taskId)).toMatchObject({ status: 'blocked', errorMessage: 'The agent was still busy' })
    expect(jobRunsRepo.getById(USER, prepared.runId)?.status).not.toBe('failed')
  })

  it('refuses a profile switch during asynchronous coordinator preflight before creating rows', async () => {
    let finish!: (value: unknown) => void
    resolveModel.mockImplementation(() => new Promise(resolve => { finish = resolve }))
    const job = jobFor('coordinator')
    let current = true
    const pending = prepareScheduledJob(scope, job, () => current)
    await vi.waitFor(() => expect(resolveModel).toHaveBeenCalled())
    current = false
    finish({ modeId: 'mode', providerId: 'provider', modelId: 'model', mcpIds: [], assertCurrent() {} })
    await expect(pending).rejects.toThrow('profile changed')
    expect(taskRepo.list(USER)).toEqual([])
    expect(driverRun).not.toHaveBeenCalled()
  })

  it.each(['ordinary', 'coordinator', 'script'] as const)('refuses edited %s definitions between preflight and claim', async route => {
    const job = jobFor(route)
    const factory = await prepareScheduledJob(scope, job, () => true)
    jobsRepo.update(USER, job.id, { prompt: 'An unreviewed replacement' })
    expect(factory).toThrow('changed')
    expect(taskRepo.list(USER)).toEqual([])
    expect(driverRun).not.toHaveBeenCalled()
  })

  it('keeps the manual human routing choice for ordinary multi-agent Jobs', async () => {
    const job = jobFor('ordinary')
    jobAgentRepo.setAgentIds(job.id, ['worker', 'second'])
    const factory = await prepareScheduledJob(scope, job, () => true)
    const prepared = factory()
    expect(chatRepo.getOwned(USER, prepared.chatId)?.router).toBe('human')
    prepared.launch()
    await vi.waitFor(() => expect(taskRepo.getById(USER, prepared.taskId)?.status).toBe('completed'))
    expect(driverRun.mock.calls[0][1].id).toBe('second')
  })

  it('starts an ordinary model Job through its configured chat runtime without a renderer', async () => {
    const job = jobFor('ordinary')
    jobAgentRepo.setAgentIds(job.id, [])
    const factory = await prepareScheduledJob(scope, job, () => true)
    const prepared = factory()
    expect(chatRepo.getOwned(USER, prepared.chatId)?.agentId).toBeNull()
    prepared.launch()
    await vi.waitFor(() => expect(taskRepo.getById(USER, prepared.taskId)?.status).toBe('completed'))
    expect(driverRun.mock.calls[0][1].id).toBe('runtime')
  })

  it('rejects a changed ordinary Job participant list between preflight and claim', async () => {
    const job = jobFor('ordinary')
    const factory = await prepareScheduledJob(scope, job, () => true)
    jobAgentRepo.setAgentIds(job.id, ['second'])
    expect(factory).toThrow('dependencies changed')
    expect(taskRepo.list(USER)).toEqual([])
  })

  it('uses normal Stop to cancel an ordinary scheduled Job and its linked attempt', async () => {
    driverRun.mockImplementation((_owner, _agent, input) => new Promise((_resolve, reject) => {
      input.signal?.addEventListener('abort', () => reject(new Error('Stopped')), { once: true })
    }))
    const job = jobFor('ordinary')
    const factory = await prepareScheduledJob(scope, job, () => true)
    const prepared = factory()
    prepared.launch()
    await vi.waitFor(() => expect(driverRun).toHaveBeenCalledTimes(1))
    runExecutionService.cancelChat(USER, prepared.chatId)
    await vi.waitFor(() => expect(taskRepo.getById(USER, prepared.taskId)?.status).toBe('cancelled'))
    expect(jobRunsRepo.getById(USER, prepared.runId)?.status).toBe('cancelled')
  })

  it('recovers an ordinary admission without its original closure and does not repeat it', async () => {
    const job = jobFor('ordinary')
    const factory = await prepareScheduledJob(scope, job, () => true)
    const prepared = factory()
    interruptScheduledOrdinaryJob(USER, prepared.taskId, prepared.chatId, prepared.runId, 'The app closed before dispatch was confirmed.')
    expect(taskRepo.getById(USER, prepared.taskId)).toMatchObject({ status: 'blocked', errorMessage: 'The app closed before dispatch was confirmed.' })
    expect(() => prepared.launch()).toThrow('no longer awaiting launch')
    expect(() => interruptScheduledOrdinaryJob(USER, prepared.taskId, prepared.chatId, prepared.runId, 'Review the interrupted work.')).not.toThrow()
    expect(driverRun).not.toHaveBeenCalled()
    expect(() => interruptScheduledOrdinaryJob(USER, prepared.taskId, 'unrelated-chat', prepared.runId, 'Wrong owner')).toThrow('no longer owns')
  })

  it('blocks an ordinary first send if the profile changes after launch but before message acceptance', async () => {
    const job = jobFor('ordinary')
    let current = true
    const factory = await prepareScheduledJob(scope, job, () => current)
    const prepared = factory()
    const prepareMessage = messageRoutingService.prepareAgentSend
    vi.spyOn(messageRoutingService, 'prepareAgentSend').mockImplementation(input => {
      current = false
      return prepareMessage(input)
    })
    prepared.launch()
    await vi.waitFor(() => expect(taskRepo.getById(USER, prepared.taskId)?.status).toBe('blocked'))
    expect(taskRepo.getById(USER, prepared.taskId)?.errorMessage).toContain('profile changed')
    expect(chatRepo.listMessages(prepared.chatId).filter(row => row.role === 'user')).toHaveLength(0)
    expect(driverRun).not.toHaveBeenCalled()
  })

  it('retains ordinary Job questions in the Inbox and keeps the task unfinished', async () => {
    driverRun.mockImplementationOnce(async (_owner, _agent, input) => {
      input.onEvent?.({ type: 'needs_input', requestId: 'proceed', resume: 'next_message', request: { kind: 'question', questions: [{ question: 'Proceed?', multiSelect: false, options: [] }] } })
      return { text: 'Waiting for a choice', parts: [], notices: [], taskState: 'input-required' }
    })
    const job = jobFor('ordinary')
    const factory = await prepareScheduledJob(scope, job, () => true)
    const prepared = factory()
    prepared.launch()
    await vi.waitFor(() => expect(taskInputRequestRepo.listOpen(USER)).toHaveLength(1))
    await vi.waitFor(() => expect(activeRunsByChat.size).toBe(0))
    expect(taskRepo.getById(USER, prepared.taskId)?.status).toBe('blocked')
    expect(jobRunsRepo.getById(USER, prepared.runId)?.status).toBe('running')
  })

  it.each(['coordinator', 'script'] as const)('does not automatically replay an unlaunched %s attempt during recovery', async route => {
    const job = jobFor(route)
    const factory = await prepareScheduledJob(scope, job, () => true)
    const prepared = factory()
    if (route === 'coordinator') taskRunnerService.recover()
    else scriptRuntimeService.recover()
    expect(taskRepo.getById(USER, prepared.taskId)?.status).toBe('blocked')
    expect(() => prepared.launch()).toThrow('queued')
    expect(driverRun).not.toHaveBeenCalled()
  })
})
