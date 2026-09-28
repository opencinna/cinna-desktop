import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createTestDatabase, type TestDatabase } from '../db/testSupport/nodeSqlite'

/**
 * The job sidebar row's unread-result icon: the `chat_run_results` row of the
 * chat of the job's latest run, and the job page's acknowledgement of it.
 */

const holder = vi.hoisted(() => ({ current: null as TestDatabase | null }))

vi.mock('../db/client', () => ({
  getDb: () => {
    if (!holder.current) throw new Error('test database not initialised')
    return holder.current.db
  },
  getRawSqlite: () => {
    if (!holder.current) throw new Error('test database not initialised')
    return holder.current.sqlite
  }
}))
vi.mock('../auth/scope', () => ({
  getSettingsScopeUserId: () => '__default__',
  getProfileScopeUserId: () => '__default__',
  getAgentLookupScope: () => ['__default__']
}))
vi.mock('./cinnaApiService', () => ({ getCinnaServerUrl: () => null, cinnaApiService: {} }))
vi.mock('./syncService', () => ({ syncService: { markDirty: () => undefined } }))
vi.mock('../logger/logger', () => ({
  createLogger: () => ({ debug: () => {}, info: () => {}, warn: () => {}, error: () => {} })
}))

const { jobsRepo, jobRunsRepo } = await import('../db/jobs')
const { chatRunResultRepo } = await import('../db/chatRunResults')
const { jobService } = await import('./jobService')

const USER = '__default__'
const OTHER = 'another-profile'

function newJob(userId = USER): string {
  return jobsRepo.create(userId, { type: 'local', title: 'Nightly check', prompt: 'Check the invoices' }).id
}

/** A run with its own chat; `createdAt` in seconds, as the column stores it. */
function run(jobId: string, createdAt: number, userId = USER): { runId: string; chatId: string } {
  const { chatId, runId } = jobRunsRepo.createLocalChatAndRun({
    userId, jobId, title: 'Nightly check', prompt: 'Check the invoices', rootAgentId: null,
    router: 'direct', modeId: null, providerId: null, modelId: null, onDemandAgentIds: [], onDemandMcpIds: []
  })
  holder.current!.sqlite.prepare('update job_runs set created_at = ? where id = ?').run(createdAt, runId)
  return { runId, chatId }
}

const listed = (jobId: string, userId = USER) => jobService.list(userId).find((job) => job.id === jobId)!

beforeEach(() => { holder.current = createTestDatabase() })
afterEach(() => { holder.current?.close(); holder.current = null })

describe('jobService.list lastRunResult', () => {
  it('is null for a job with no runs, and for a latest run with no recorded result', () => {
    const jobId = newJob()
    expect(listed(jobId).lastRunResult).toBeNull()
    run(jobId, 100)
    expect(listed(jobId).lastRunResult).toBeNull()
  })

  it('is the latest run\'s result: an older unread one gives way to a newer read one', () => {
    const jobId = newJob()
    const older = run(jobId, 200)
    const newer = run(jobId, 100)
    holder.current!.sqlite.prepare('update job_runs set created_at = ? where id = ?').run(300, newer.runId)
    chatRunResultRepo.record(older.chatId, 'turn-old', 'failed')
    chatRunResultRepo.record(newer.chatId, 'turn-new', 'completed')
    chatRunResultRepo.markRead(newer.chatId, 'turn-new')
    expect(listed(jobId).lastRunResult).toEqual({ runId: 'turn-new', status: 'completed', unread: false })
    expect(jobService.getDetail(USER, jobId).lastRunResult).toEqual({ runId: 'turn-new', status: 'completed', unread: false })
  })

  it('is null once the latest run\'s chat is deleted, rather than an older run\'s result', () => {
    const jobId = newJob()
    const older = run(jobId, 100)
    const newer = run(jobId, 200)
    chatRunResultRepo.record(older.chatId, 'turn-old', 'failed')
    chatRunResultRepo.record(newer.chatId, 'turn-new', 'completed')
    holder.current!.sqlite.prepare('delete from chats where id = ?').run(newer.chatId)
    expect(listed(jobId).lastRunResult).toBeNull()
  })

  it('finds each job\'s latest run through the index, not a sort per run', () => {
    const plan = holder.current!.sqlite.prepare(`explain query plan select id from job_runs
      where job_id = ? and user_id = ? and type = 'local' order by created_at desc, rowid desc limit 1`)
      .all('job', USER) as { detail: string }[]
    expect(plan.map((row) => row.detail).join(' | ')).toContain('idx_job_runs_job_created')
    expect(plan.map((row) => row.detail).join(' | ')).not.toContain('TEMP B-TREE')
  })

  it('breaks a tie in the same second by insertion order, and keeps each job its own', () => {
    const a = newJob()
    const b = newJob()
    const first = run(a, 500)
    const second = run(a, 500)
    const other = run(b, 900)
    chatRunResultRepo.record(first.chatId, 'turn-1', 'failed')
    chatRunResultRepo.record(second.chatId, 'turn-2', 'needs_input')
    chatRunResultRepo.record(other.chatId, 'turn-b', 'completed')
    expect(listed(a).lastRunResult).toEqual({ runId: 'turn-2', status: 'needs_input', unread: true })
    expect(listed(b).lastRunResult).toEqual({ runId: 'turn-b', status: 'completed', unread: true })
  })

  it('never shows another profile\'s runs', () => {
    const jobId = newJob()
    const mine = run(jobId, 100)
    chatRunResultRepo.record(mine.chatId, 'turn-mine', 'completed')
    const theirJob = newJob(OTHER)
    const theirs = run(theirJob, 100, OTHER)
    chatRunResultRepo.record(theirs.chatId, 'turn-theirs', 'failed')
    expect(jobService.list(OTHER).map((job) => [job.id, job.lastRunResult?.runId])).toEqual([[theirJob, 'turn-theirs']])
    expect(listed(jobId).lastRunResult?.runId).toBe('turn-mine')
  })
})

describe('jobService.markLatestResultRead', () => {
  it('marks only the result the page was shown, and only the latest run\'s', () => {
    const jobId = newJob()
    const older = run(jobId, 100)
    const latest = run(jobId, 200)
    chatRunResultRepo.record(older.chatId, 'turn-old', 'completed')
    chatRunResultRepo.record(latest.chatId, 'turn-1', 'completed')
    // Another run's result id, or a stale one, is not the latest: nothing moves.
    jobService.markLatestResultRead(USER, jobId, 'turn-old')
    expect(chatRunResultRepo.get(USER, older.chatId)?.unread).toBe(true)
    // A result that landed after the page rendered stays unread.
    chatRunResultRepo.record(latest.chatId, 'turn-2', 'needs_input')
    jobService.markLatestResultRead(USER, jobId, 'turn-1')
    expect(listed(jobId).lastRunResult).toEqual({ runId: 'turn-2', status: 'needs_input', unread: true })
    jobService.markLatestResultRead(USER, jobId, 'turn-2')
    expect(listed(jobId).lastRunResult).toEqual({ runId: 'turn-2', status: 'needs_input', unread: false })
  })

  it('refuses another profile\'s job and leaves its result unread', () => {
    const jobId = newJob()
    const { chatId } = run(jobId, 100)
    chatRunResultRepo.record(chatId, 'turn-1', 'failed')
    expect(() => jobService.markLatestResultRead(OTHER, jobId, 'turn-1')).toThrow('Job not found')
    expect(chatRunResultRepo.get(USER, chatId)?.unread).toBe(true)
  })

  it('does nothing for a job without runs', () => {
    const jobId = newJob()
    expect(() => jobService.markLatestResultRead(USER, jobId, 'turn-1')).not.toThrow()
  })
})
