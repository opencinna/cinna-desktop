import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createTestDatabase, type TestDatabase } from '../db/testSupport/nodeSqlite'
import type { AgentRow } from '../db/agents'
import type { AgentDriver } from '../agents/drivers/driver'

const state = vi.hoisted(() => ({ database: null as TestDatabase | null, agents: [] as AgentRow[], get: vi.fn() }))
const driverRun = vi.hoisted(() => vi.fn<AgentDriver['run']>())
vi.mock('../db/client', () => ({ getDb: () => state.database!.db, getRawSqlite: () => state.database!.sqlite }))
vi.mock('../db/sync', () => ({ syncRepo: { getState: () => null } }))
vi.mock('../logger/logger', () => ({ createLogger: () => ({ info() {}, debug() {}, warn() {}, error() {} }) }))
vi.mock('../auth/scope', () => ({ getSettingsScopeUserId: () => '__default__', getAgentLookupScope: () => ['__default__'] }))
vi.mock('../mcp/manager', () => ({ mcpManager: { getConnection: () => null } }))
vi.mock('./cinnaApiService', () => ({ getCinnaServerUrl: () => null, cinnaApiService: {} }))
vi.mock('./syncService', () => ({ syncService: { markDirty() {} } }))
vi.mock('./fileStore', () => ({ attachmentToMediaPart: async () => null }))
vi.mock('./taskFileService', () => ({ taskFileService: { exportHandoff() {}, removeHandoff() {} } }))
vi.mock('./chatTitleService', () => ({ chatTitleService: { autoGenerateForFirstMessage: async () => {} }, ChatTitleError: class extends Error {} }))
vi.mock('./localAgents/localAgentService', () => ({ localAgentService: { get: state.get } }))
vi.mock('./agentService', () => ({ agentService: {
  findAgent: (_settings: string, _user: string, id: string) => { const row = state.agents.find((agent) => agent.id === id); return row ? { row, userId: '__default__' } : null },
  listMerged: () => state.agents
} }))
vi.mock('../agents/drivers', () => ({ driverFor: () => ({ run: driverRun, capabilities: () => ({ commands: { source: 'none' } }) }) }))
vi.mock('./localAgents/commandService', () => ({ resolveCommandRunner: (_cap: unknown, _wire: string, _user: string, _agent: string, run: unknown) => run }))
const { localScheduleService } = await import('./localScheduleService')
const { localScheduleRepo } = await import('../db/localSchedules')
const { scriptRuntimeService } = await import('./scriptRuntimeService')
const { scriptRuntimeRepo } = await import('../db/scriptRuntimes')
const { taskRepo } = await import('../db/tasks')
const { jobsRepo, jobRunsRepo } = await import('../db/jobs')
const { jobService } = await import('./jobService')
const { taskInputRequestRepo } = await import('../db/taskInputRequests')
const { userRepo } = await import('../db/users')
const { taskRunnersByChat } = await import('./taskRunnerState')
const { activeRunsByChat } = await import('./runExecutionState')
const USER = '__default__'
const MANIFEST = 'aa270900-138e-4a59-b2a0-ea25b7bb457e'
const AGENT = `folder:${MANIFEST}`
const scope = { profileUserId: USER, settingsUserId: USER }
const BASE = Date.parse('2026-09-12T09:00:00Z')
let definition: { name: string; cron_string: string; timezone: string | null; schedule_type: string; prompt: string; enabled?: boolean }

beforeEach(() => {
  state.database = createTestDatabase()
  definition = { name: 'Daily check', cron_string: '* * * * *', timezone: 'UTC', schedule_type: 'static_prompt', prompt: 'Read literal {{goal}} and {{unknown.text}}.' }
  state.agents = [{ id: AGENT, name: 'Verifier', driver: 'acp', source: 'folder', enabled: true, userId: USER } as AgentRow]
  state.database.raw.prepare(`INSERT INTO agents (id,user_id,name,protocol,enabled,source,driver,created_at) VALUES (?,?,'Verifier','local-folder',1,'folder','acp',1)`).run(AGENT, USER)
  state.get.mockReset().mockImplementation(() => ({ id: AGENT, name: 'Verifier', kind: 'kit', enabled: true, readiness: 'ok', manifest: { id: MANIFEST, schedules: [structuredClone(definition)] } }))
  driverRun.mockReset().mockImplementation(async () => ({ text: 'Checked', parts: [], notices: [], taskState: 'completed' }))
})
afterEach(async () => {
  vi.restoreAllMocks()
  for (const entry of taskRunnersByChat.values()) { try { entry.cancel() } catch { /* terminal */ } }
  await vi.waitFor(() => expect(activeRunsByChat.size).toBe(0))
  await new Promise((resolve) => setTimeout(resolve, 0))
  taskRunnersByChat.clear()
  state.database?.close(); state.database = null
})
function review() {
  const item = localScheduleService.list(scope, AGENT)[0]
  return { profileUserId: USER, agentId: AGENT, name: item.name, revision: item.revision!, timezone: item.timezone }
}
function enable(now = BASE) { localScheduleService.enable(scope, review(), now); return localScheduleRepo.list(USER)[0] }
function check(now = BASE + 60000) { localScheduleService.check(scope, () => true, () => now) }
async function settled(bindingId: string) {
  await vi.waitFor(() => expect(localScheduleService.list(scope, AGENT)[0].binding?.last?.status).toBe('completed'))
  return localScheduleRepo.latest(USER, bindingId)!
}

describe('local schedule admission and persistence', () => {
  it('keeps opt-in across a transient folder failure and makes listing read-only', async () => {
    const binding = enable()
    const healthy = state.get.getMockImplementation()!
    state.get.mockImplementation(() => { throw new Error('EBUSY: manifest is being saved') })
    expect(localScheduleService.list(scope, AGENT)[0].binding?.reason).toContain('EBUSY')
    expect(localScheduleRepo.get(USER, binding.id)).toEqual(binding)
    check()
    expect(localScheduleRepo.get(USER, binding.id)).toEqual(binding)
    expect(driverRun).not.toHaveBeenCalled()
    state.get.mockImplementation(healthy)
    check(BASE + 120000)
    await settled(binding.id)
    expect(driverRun).toHaveBeenCalledTimes(1)
  })

  it('enables and runs a schedule on an agent whose credentials are missing, but not on an invalid one', async () => {
    const healthy = state.get.getMockImplementation()!
    const withReadiness = (readiness: string) => () => ({ ...(healthy() as object), readiness, readinessReason: `Folder is ${readiness}.` })
    state.get.mockImplementation(withReadiness('invalid'))
    expect(localScheduleService.list(scope, AGENT)[0].problem).toBe('Folder is invalid.')
    state.get.mockImplementation(withReadiness('credentials_needed'))
    expect(localScheduleService.list(scope, AGENT)[0].problem).toBeNull()
    const binding = enable()
    expect(localScheduleService.list(scope, AGENT)[0].binding).toMatchObject({ enabled: true, reason: null })
    check()
    await settled(binding.id)
    expect(driverRun).toHaveBeenCalledTimes(1)
  })

  it('does not let a soft-deleted blocked task reserve every later occurrence', async () => {
    const binding = enable()
    const prepared = scriptRuntimeService.prepareJob(scope, jobsRepo.getById(USER, binding.jobId)!)
    taskRepo.update(USER, prepared.taskId, { status: 'blocked' })
    taskRepo.softDelete(USER, prepared.taskId)
    expect(localScheduleRepo.unfinishedRuns(USER, [binding.jobId])).toEqual([])
    check()
    await settled(binding.id)
  })

  it('lists without opt-in, freezes the literal prompt, skips initial minute and dispatches once after commit', async () => {
    expect(review().revision).toBeTruthy()
    check()
    expect(jobsRepo.list(USER)).toEqual([])
    expect(taskRepo.list(USER)).toEqual([])
    const binding = enable()
    check(BASE)
    expect(localScheduleRepo.occurrences(USER, binding.id)).toEqual([])
    check(); check()
    const receipt = await settled(binding.id)
    expect(receipt.definition.prompt).toBe(definition.prompt)
    expect(jobRunsRepo.getById(USER, receipt.runId!)).toMatchObject({ taskId: receipt.taskId, status: 'succeeded' })
    expect(driverRun).toHaveBeenCalledTimes(1)
    expect(driverRun.mock.calls[0][2].wireContent).toContain(definition.prompt)
    expect(scriptRuntimeRepo.get(USER, receipt.taskId!)?.steps.run.prompt).toBe(definition.prompt)
    expect(taskRepo.list(USER)).toHaveLength(2)
  })
  it('records one failed observation after rolling back all prepared execution rows', () => {
    const binding = enable()
    const insert = localScheduleRepo.insertOccurrence
    let failed = false
    vi.spyOn(localScheduleRepo, 'insertOccurrence').mockImplementation((row) => {
      if (!failed && row.status === 'prepared') { failed = true; throw new Error('Receipt write refused') }
      insert(row)
    })
    check(); check()
    expect(localScheduleRepo.occurrences(USER, binding.id)).toMatchObject([{ status: 'failed', taskId: null, reason: 'Receipt write refused' }])
    expect(jobRunsRepo.listByJob(USER, binding.jobId)).toEqual([])
    expect(taskRepo.list(USER)).toEqual([])
    expect(scriptRuntimeRepo.list(USER)).toEqual([])
    expect(driverRun).not.toHaveBeenCalled()
    expect(taskRunnersByChat.size).toBe(0)
  })
  it('turns a committed but unlaunched occurrence into explicit interrupted recovery', () => {
    const binding = enable()
    const prepare = scriptRuntimeService.prepareJob
    vi.spyOn(scriptRuntimeService, 'prepareJob').mockImplementation((captured, job) => ({ ...prepare(captured, job), launch() { throw new Error('Profile switched before launch') } }))
    check(); check()
    const receipt = localScheduleRepo.latest(USER, binding.id)!
    expect(receipt).toMatchObject({ status: 'interrupted', reason: 'Profile switched before launch' })
    expect(scriptRuntimeRepo.get(USER, receipt.taskId!)?.state).toBe('interrupted')
    scriptRuntimeService.recover()
    check(BASE + 120000)
    expect(localScheduleRepo.latest(USER, binding.id)?.status).toBe('skipped_overlap')
    expect(driverRun).not.toHaveBeenCalled()
  })
  it('blocks overlap with a manually prepared interrupted run of the generated Job', () => {
    const binding = enable()
    const prior = scriptRuntimeService.prepareJob(scope, jobsRepo.getById(USER, binding.jobId)!)
    scriptRuntimeService.interruptPrepared(USER, prior.taskId, 'Review prior work')
    check()
    expect(localScheduleRepo.latest(USER, binding.id)).toMatchObject({ status: 'skipped_overlap', taskId: prior.taskId })
    expect(jobRunsRepo.listByJob(USER, binding.jobId)).toHaveLength(1)
    expect(driverRun).not.toHaveBeenCalled()
  })
  it('deleting a waiting scheduled run cancels its tasks and gates and allows a later occurrence', async () => {
    driverRun.mockImplementationOnce(async (_owner, _row, input) => {
      input.onEvent?.({ type: 'needs_input', requestId: 'publish', resume: 'next_message', request: {
        kind: 'question', questions: [{ question: 'Publish?', multiSelect: false, options: [] }]
      } })
      return { text: 'Waiting for a choice', parts: [], notices: [], taskState: 'input-required' }
    })
    const binding = enable()
    check()
    const receipt = localScheduleRepo.latest(USER, binding.id)!
    await vi.waitFor(() => expect(scriptRuntimeRepo.get(USER, receipt.taskId!)?.state).toBe('waiting'))
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(taskInputRequestRepo.listOpen(USER)).toHaveLength(1)
    expect(jobService.deleteRun(USER, receipt.runId!)).toMatchObject({ chatDeleted: true })
    expect(taskRepo.getById(USER, receipt.taskId!)?.status).toBe('cancelled')
    expect(scriptRuntimeRepo.get(USER, receipt.taskId!)?.state).toBe('completed')
    expect(taskInputRequestRepo.listOpen(USER)).toEqual([])
    expect(taskRunnersByChat.size).toBe(0)
    expect(localScheduleService.list(scope, AGENT)[0].binding?.last?.status).toBe('cancelled')
    check(BASE + 120000)
    await settled(binding.id)
    expect(driverRun).toHaveBeenCalledTimes(2)
  })
  it('suspends changed definitions and refuses a stale review, while preserving old occurrence history', async () => {
    const token = review(), binding = enable()
    check(); await settled(binding.id)
    definition.prompt = 'Changed instructions'
    expect(localScheduleService.list(scope, AGENT)[0].binding).toMatchObject({ enabled: false, reason: expect.stringContaining('changed') })
    expect(() => localScheduleService.enable(scope, token, BASE + 120000)).toThrow('changed')
    localScheduleService.enable(scope, review(), BASE + 120000)
    const next = localScheduleRepo.get(USER, binding.id)!
    expect(next.jobId).not.toBe(binding.jobId)
    expect(next.jobIds).toEqual([binding.jobId, next.jobId])
    expect(localScheduleRepo.occurrences(USER, binding.id)).toHaveLength(1)
    check(BASE + 120000)
    expect(driverRun).toHaveBeenCalledTimes(1)
  })
  it('preserves civil dedupe through fall DST and disable/re-enable, and skips missed minutes', async () => {
    definition.timezone = 'Europe/Berlin'; definition.cron_string = '30 2 * * *'
    const first = Date.parse('2026-10-25T00:30:00Z')
    const binding = enable(first - 60000)
    check(first); await settled(binding.id)
    localScheduleService.disable(scope, binding.id)
    localScheduleService.enable(scope, review(), first + 30 * 60000)
    check(first + 60 * 60000)
    expect(localScheduleRepo.occurrences(USER, binding.id)).toHaveLength(1)
    expect(driverRun).toHaveBeenCalledTimes(1)
    check(first - 60000)
    expect(localScheduleRepo.get(USER, binding.id)!.watermark).toBe((first + 60 * 60000) / 60000)
    check(first + 3 * 86400000)
    expect(localScheduleRepo.occurrences(USER, binding.id)).toHaveLength(1)
  })
  it('rejects stale profile review and cascades only the removed profile’s local records', async () => {
    const binding = enable()
    check(); await settled(binding.id)
    userRepo.insert({ id: 'other', type: 'local_user', username: 'other', displayName: 'Other' })
    expect(() => localScheduleService.enable({ ...scope, profileUserId: 'other' }, review(), BASE)).toThrow('profile changed')
    expect(() => localScheduleService.disable({ ...scope, profileUserId: 'other' }, binding.id)).toThrow('another profile')
    userRepo.deleteWithCascade(USER)
    expect(localScheduleRepo.list(USER)).toEqual([])
    expect(localScheduleRepo.occurrences(USER, binding.id)).toEqual([])
    expect(userRepo.get('other')).toBeDefined()
  })
  it.each(['command', 'duplicate', 'disabled', 'missing', 'job'] as const)('suspends admission for %s changes without silently recreating work', (change) => {
    const binding = enable()
    if (change === 'command') definition.schedule_type = 'script_trigger'
    if (change === 'disabled') definition.enabled = false
    if (change === 'missing') state.get.mockImplementation(() => { throw new Error('Folder unavailable') })
    if (change === 'duplicate') state.get.mockImplementation(() => ({ id: AGENT, kind: 'kit', enabled: true, readiness: 'ok', manifest: { id: MANIFEST, schedules: [definition, definition] } }))
    if (change === 'job') jobsRepo.update(USER, binding.jobId, { prompt: 'Edited Job' })
    check()
    expect(localScheduleRepo.get(USER, binding.id)?.enabled).toBe(change === 'missing')
    expect(jobRunsRepo.listByJob(USER, binding.jobId)).toEqual([])
    expect(driverRun).not.toHaveBeenCalled()
  })
  it('does not admit a minute whose fresh folder preflight ran past its boundary', () => {
    const binding = enable()
    let now = BASE + 60000
    const get = state.get.getMockImplementation()!
    state.get.mockImplementation((...args) => { now += 60000; return get(...args) })
    localScheduleService.check(scope, () => true, () => now)
    expect(localScheduleRepo.occurrences(USER, binding.id)).toEqual([])
    expect(driverRun).not.toHaveBeenCalled()
  })
  it('refuses duplicate names introduced between the review check and final folder read', () => {
    const token = review()
    const get = state.get.getMockImplementation()!
    state.get.mockImplementationOnce(get).mockImplementationOnce(() => ({ ...get(), manifest: { id: MANIFEST, schedules: [definition, definition] } }))
    expect(() => localScheduleService.enable(scope, token, BASE)).toThrow('no longer unique')
    expect(localScheduleRepo.list(USER)).toEqual([])
    expect(jobsRepo.list(USER)).toEqual([])
  })
})
