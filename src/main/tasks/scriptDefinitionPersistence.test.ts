import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createTestDatabase, type TestDatabase } from '../db/testSupport/nodeSqlite'
import type { TaskScript } from '../../shared/taskScript'
import { runAllMigrations } from '../db/migrations'

const state = vi.hoisted(() => ({ database: null as TestDatabase | null }))
vi.mock('../db/client', () => ({ getDb: () => state.database!.db, getRawSqlite: () => state.database!.sqlite }))
vi.mock('../auth/scope', () => ({ getSettingsScopeUserId: () => '__default__', getProfileScopeUserId: () => '__default__', getAgentLookupScope: () => ['__default__'] }))
vi.mock('../services/cinnaApiService', () => ({ getCinnaServerUrl: () => null, cinnaApiService: {} }))
vi.mock('../services/syncService', () => ({ syncService: { markDirty() {} } }))
vi.mock('../services/taskFileService', () => ({ taskFileService: { exportHandoff() {}, removeHandoff() {} } }))
vi.mock('../logger/logger', () => ({ createLogger: () => ({ info() {}, debug() {}, warn() {}, error() {} }) }))

const { jobService } = await import('../services/jobService')
const { taskService } = await import('../services/taskService')
const { taskSyncService } = await import('../services/taskSyncService')
const { jobsRepo, jobRunsRepo } = await import('../db/jobs')
const { taskRepo } = await import('../db/tasks')
const { chatRepo } = await import('../db/chats')
const { agentRepo } = await import('../db/agents')
const { COLLECTION_MAPPERS, newResolveCache } = await import('../sync/collections')
const USER = '__default__'
const script: TaskScript = { version: 1, agents: { author: { kind: 'agent', source: 'folder', manifestId: 'author-portable' } },
  steps: [{ id: 'write', agent: 'author', prompt: 'Write {{goal}}', after: [] }, { id: 'gate', after: ['write'], ask_user: 'Accept {{write.text}}?' }] }
beforeEach(() => { state.database = createTestDatabase() })
afterEach(() => { state.database?.close(); state.database = null })

describe('persisted script definitions', () => {
  it('snapshots portable Job and Task definitions and validates local edits before writing', () => {
    const job = jobService.create(USER, { type: 'local', title: 'Write', prompt: 'A guide', router: 'script', script, budget: { maxRounds: 4 } })
    expect(jobsRepo.getById(USER, job.id)).toMatchObject({ script, router: 'script', budget: { maxRounds: 4, maxMinutes: 60 } })
    expect(() => jobService.update(USER, job.id, { router: null })).toThrow(/script router/)
    expect(() => jobService.update(USER, job.id, { script: { ...script, version: 2 } as unknown as TaskScript })).toThrow(/version/)
    expect(jobsRepo.getById(USER, job.id)?.script).toEqual(script)
    expect(jobService.update(USER, job.id, { title: 'Revised title' }).title).toBe('Revised title')
    const task = taskService.create(USER, { title: job.title, goal: job.prompt, router: 'script', script, budget: job.budget })
    expect(taskService.getById(USER, task.id).script).toEqual(script)
    expect(() => taskService.update(USER, task.id, { router: 'direct' })).toThrow(/fixed/)
    expect(() => taskService.create(USER, { title: 'Nested', goal: 'Work', parentTaskId: task.id, router: 'script', script })).toThrow(/nested/)
    expect(taskRepo.list(USER)).toHaveLength(1)
  })

  it('refuses unsupported execution before creating a fallback LLM chat, task or attempt', () => {
    const job = jobService.create(USER, { type: 'local', title: 'Write', prompt: 'A guide', router: 'script', script })
    expect(() => jobService.executeLocal(USER, job.id)).toThrow(/autonomous job executor/)
    expect(jobRunsRepo.listByJob(USER, job.id)).toEqual([])
    expect(taskRepo.list(USER)).toEqual([])
    expect(chatRepo.list(USER)).toEqual([])
    const invalid = { ...script, steps: [{ id: 'a', ask_user: '{{missing.text}}' }] }
    expect(() => jobService.create(USER, { type: 'local', title: 'Bad', prompt: 'Bad', router: 'script', script: invalid })).toThrow(/dependencies/)
    expect(jobsRepo.list(USER)).toHaveLength(1)
  })

  it('refuses contradictory remote job routing before any adapter preflight or task creation', async () => {
    const adapter = vi.spyOn(taskSyncService, 'preferredAdapterId').mockResolvedValue(null)
    try {
      const job = jobsRepo.create(USER, { type: 'cinna_task', title: 'Remote', prompt: 'Work', cinnaAgentId: 'remote-id', router: 'coordinator' })
      await expect(jobService.executeCinnaTask(USER, job.id)).rejects.toThrow('local job')
      expect(adapter).not.toHaveBeenCalled()
      expect(jobRunsRepo.listByJob(USER, job.id)).toEqual([])
      expect(taskRepo.list(USER)).toEqual([])
    } finally { adapter.mockRestore() }
  })

  it('preserves future script versions and router names through sync and unrelated edits', () => {
    const future = { version: 5, agents: script.agents, steps: script.steps, newPolicy: { retry: 'ask' } }
    for (const collection of ['job', 'task'] as const) {
      const mapper = COLLECTION_MAPPERS.find((item) => item.collection === collection)!
      mapper.apply(USER, `future-${collection}`, { type: 'local', title: 'Future', prompt: 'Goal', goal: 'Goal',
        router: 'future-router', script: future, budget: { maxNewUnit: 10 }, modeName: null, deps: [], executor: 'desktop', origin: 'local' },
      false, { clientUpdatedAt: Date.now(), cache: newResolveCache() })
      const payload = () => mapper.listDirty(USER, 0).find((item) => item.clientEntityId === `future-${collection}`)!.plaintext
      expect(payload()).toMatchObject({ router: 'future-router', script: future, budget: { maxNewUnit: 10 } })
      if (collection === 'job') {
        jobService.update(USER, 'future-job', { title: 'Renamed future' })
        expect(() => jobService.executeLocal(USER, 'future-job')).toThrow(/router is not supported/)
        expect(jobRunsRepo.listByJob(USER, 'future-job')).toEqual([])
      } else taskService.update(USER, 'future-task', { title: 'Renamed future' })
      expect(payload()).toMatchObject({ script: future, budget: { maxNewUnit: 10 } })
    }
    // A script's portable references are data; receiving one never installs agents.
    expect(agentRepo.list(USER)).toEqual([])
    expect(agentRepo.listFolder(USER)).toEqual([])
  })

  it('updates existing synced definitions and refuses another profile’s row', () => {
    const mapper = COLLECTION_MAPPERS.find((item) => item.collection === 'job')!
    const incoming = { type: 'local', title: 'One', prompt: 'Goal', router: 'script', script, budget: { maxRounds: 5 }, deps: [] }
    const apply = (userId: string, fields: Record<string, unknown>) => mapper.apply(userId, 'same-job', fields, false,
      { clientUpdatedAt: Date.now(), cache: newResolveCache() })
    apply(USER, incoming)
    apply(USER, { ...incoming, script: { ...script, steps: [{ id: 'gate', ask_user: 'Proceed?' }] }, budget: { maxRounds: 9 } })
    expect(jobsRepo.getById(USER, 'same-job')).toMatchObject({ budget: { maxRounds: 9 }, script: { steps: [{ id: 'gate', ask_user: 'Proceed?' }] } })
    apply('other-profile', { ...incoming, title: 'Hijacked' })
    expect(jobsRepo.getById(USER, 'same-job')?.title).toBe('One')
    expect(jobsRepo.getById('other-profile', 'same-job')).toBeUndefined()
  })

  it('migrates existing Jobs and Tasks with null definitions and preserves populated definitions on replay', () => {
    const job = jobsRepo.create(USER, { type: 'local', title: 'Legacy', prompt: 'Work' })
    const task = taskRepo.create(USER, { title: 'Legacy', goal: 'Work' })
    state.database!.raw.exec('ALTER TABLE jobs DROP COLUMN router; ALTER TABLE jobs DROP COLUMN script; ALTER TABLE jobs DROP COLUMN budget; ALTER TABLE tasks DROP COLUMN script;')
    runAllMigrations(state.database!.sqlite)
    expect(jobsRepo.getById(USER, job.id)).toMatchObject({ title: 'Legacy', router: null, script: null, budget: null })
    expect(taskRepo.getById(USER, task.id)?.script).toBeNull()
    jobsRepo.update(USER, job.id, { router: 'script', script })
    taskRepo.update(USER, task.id, { script })
    runAllMigrations(state.database!.sqlite)
    expect(jobsRepo.getById(USER, job.id)?.script).toEqual(script)
    expect(taskRepo.getById(USER, task.id)?.script).toEqual(script)
  })
})
