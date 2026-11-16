import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createTestDatabase, type TestDatabase } from '../db/testSupport/nodeSqlite'

/**
 * Jobs mobile runs as the Assistant (`modeName: "@assistant"`), and unresolved
 * mode names in general, against a real database: a job arrives from another
 * device, this device edits it, and the mode name the sender wrote must still
 * be what goes back out — unless the user chose a mode here.
 *
 * And the run side: an Assistant job never runs on this device, whichever
 * entry point is asked.
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
vi.mock('../services/cinnaApiService', () => ({
  getCinnaServerUrl: () => null,
  cinnaApiService: {}
}))
vi.mock('../services/syncService', () => ({ syncService: { markDirty: () => undefined } }))
vi.mock('../logger/logger', () => ({
  createLogger: () => ({ info: () => undefined, warn: () => undefined, error: () => undefined, debug: () => undefined })
}))

const { COLLECTION_MAPPERS, newResolveCache } = await import('./collections')
const { resolveMode } = await import('./resolvers')
const { chatModeRepo } = await import('../db/chatModes')
const { jobsRepo, jobRunsRepo } = await import('../db/jobs')
const { taskRepo } = await import('../db/tasks')
const { jobService } = await import('../services/jobService')
const { prepareScheduledJob } = await import('../services/jobExecution/scheduled')
const { RUNS_ON_MOBILE_MESSAGE } = await import('../services/jobExecution/mobileOnly')

const USER = '__default__'
const JOB_ID = 'job-1'
const scope = { profileUserId: USER, settingsUserId: USER }

const jobMapper = COLLECTION_MAPPERS.find((m) => m.collection === 'job')

function applyIncomingJob(modeName: string | null, type: 'local' | 'cinna_task' = 'local'): void {
  if (!jobMapper) throw new Error('no job mapper registered')
  jobMapper.apply(
    USER,
    JOB_ID,
    {
      type,
      title: 'Morning brief',
      description: null,
      prompt: 'Summarise my day',
      modeName,
      deps: [],
      folderId: null,
      position: 0,
      deletedAt: null
    },
    false,
    { clientUpdatedAt: Date.now(), cache: newResolveCache() }
  )
}

function addMode(name: string, isDefault = false): string {
  return chatModeRepo.insert(USER, { name, isDefault }).id
}

const stored = () => jobsRepo.getById(USER, JOB_ID)!
const modeName = () => stored().syncDeps?.modeName ?? null

beforeEach(() => {
  holder.current = createTestDatabase()
})

afterEach(() => {
  holder.current?.close()
  holder.current = null
})

describe('resolveMode', () => {
  it.each(['@assistant', '@Assistant ', ' @ASSISTANT'])('resolves the Assistant marker %j to no mode', (name) => {
    addMode('Everyday', true)
    // A chat mode carrying the marker's name loses to the marker, as on mobile.
    addMode('@assistant')
    expect(resolveMode(name)).toBeNull()
  })

  it('still falls back to the default mode for any other unknown name', () => {
    const fallback = addMode('Everyday', true)
    expect(resolveMode('Research')).toBe(fallback)
  })

  it('resolves an unknown name to no mode when there is no default', () => {
    addMode('Everyday')
    expect(resolveMode('Research')).toBeNull()
  })
})

describe('an Assistant job pulled from mobile', () => {
  it('has no mode, runs on mobile, and does not need setup', () => {
    addMode('Everyday', true)
    applyIncomingJob('@assistant')
    expect(stored().modeId).toBeNull()
    const listed = jobService.list(USER).find((j) => j.id === JOB_ID)!
    expect(listed).toMatchObject({ runsOnMobile: true, needsSetup: false, incompleteSetup: false })
    expect(jobService.getDetail(USER, JOB_ID)).toMatchObject({ runsOnMobile: true, needsSetup: false })
    expect(jobService.getDependencyStatus(USER, JOB_ID)).toEqual([])
  })

  it('is not flagged as running on mobile for an ordinary mode name', () => {
    addMode('Everyday', true)
    applyIncomingJob('Everyday')
    expect(jobService.getDetail(USER, JOB_ID).runsOnMobile).toBe(false)
  })
})

describe.each([
  ['@assistant', 'the Assistant marker'],
  ['Research', 'an unknown name with a default-mode fallback']
])('keeping the sender\'s mode name %j (%s) through local edits', (name) => {
  beforeEach(() => {
    addMode('Everyday', true)
    applyIncomingJob(name)
  })

  it('survives setAgents', () => {
    jobService.setAgents(USER, JOB_ID, [])
    expect(modeName()).toBe(name)
  })

  it('survives setMcpProviders', () => {
    jobService.setMcpProviders(USER, JOB_ID, [])
    expect(modeName()).toBe(name)
  })

  it('survives an update that does not touch the mode', () => {
    jobService.update(USER, JOB_ID, { title: 'Evening brief' })
    expect(modeName()).toBe(name)
  })

  it('is replaced when the user picks a mode here', () => {
    const picked = addMode('Deep work')
    jobService.update(USER, JOB_ID, { modeId: picked })
    expect(modeName()).toBe('Deep work')
    jobService.setAgents(USER, JOB_ID, [])
    expect(modeName()).toBe('Deep work')
  })
})

describe('the user leaving the Assistant on this device', () => {
  it('replaces the marker on an explicit null, which equals the stored modeId', () => {
    applyIncomingJob('@assistant')
    jobService.update(USER, JOB_ID, { modeId: null })
    expect(modeName()).toBeNull()
    expect(jobService.getDetail(USER, JOB_ID).runsOnMobile).toBe(false)
  })

  it('replaces an unknown name on an explicit choice of the default mode', () => {
    const fallback = addMode('Everyday', true)
    applyIncomingJob('Research')
    jobService.update(USER, JOB_ID, { modeId: fallback })
    expect(modeName()).toBe('Everyday')
  })
})

describe('a stale name after a local mode rename', () => {
  it('builds from the renamed mode, not the old name', () => {
    addMode('Everyday', true)
    const research = addMode('Research')
    applyIncomingJob('Research')
    expect(stored().modeId).toBe(research)
    // Renamed here: the job keeps the mode, and its old name now resolves to nothing.
    chatModeRepo.setName(USER, research, 'Deep research')
    jobService.setAgents(USER, JOB_ID, [])
    expect(modeName()).toBe('Deep research')
  })
})

describe('running an Assistant job on this device', () => {
  const noRunRows = (): void => {
    expect(jobRunsRepo.listByJob(USER, JOB_ID)).toEqual([])
    expect(taskRepo.list(USER).filter((t) => t.jobId === JOB_ID)).toEqual([])
  }

  it('refuses a manual run with a sentence for the user, and leaves nothing behind', async () => {
    applyIncomingJob('@assistant')
    await expect(jobService.execute(USER, JOB_ID, USER)).rejects.toThrow(RUNS_ON_MOBILE_MESSAGE)
    noRunRows()
  })

  it('refuses the renderer-started run', () => {
    applyIncomingJob('@assistant')
    expect(() => jobService.executeLocal(USER, JOB_ID)).toThrow(RUNS_ON_MOBILE_MESSAGE)
    noRunRows()
  })

  it('refuses a coordinator job before its router branch', async () => {
    applyIncomingJob('@assistant')
    jobsRepo.update(USER, JOB_ID, { router: 'coordinator' })
    await expect(jobService.execute(USER, JOB_ID, USER)).rejects.toThrow(RUNS_ON_MOBILE_MESSAGE)
  })

  it('refuses a Cinna task job', async () => {
    applyIncomingJob('@assistant', 'cinna_task')
    await expect(jobService.execute(USER, JOB_ID, USER)).rejects.toThrow(RUNS_ON_MOBILE_MESSAGE)
  })

  it('refuses scheduled admission', async () => {
    applyIncomingJob('@assistant')
    await expect(prepareScheduledJob(scope, stored(), () => true)).rejects.toThrow(RUNS_ON_MOBILE_MESSAGE)
    noRunRows()
  })
})
