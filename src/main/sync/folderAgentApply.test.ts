import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createTestDatabase, type TestDatabase } from '../db/testSupport/nodeSqlite'
import { derivePattern } from '../../shared/commPattern'
import type { JobDepDescriptor } from '../../shared/sync'

/**
 * The peer side, end to end, against a real database: a job arrives from
 * another device carrying a folder-agent dependency, and this device applies it.
 *
 * This is the path the defect lived on and the one the unit tests around it
 * cannot see, because `parseDeps` and the apply dispatch are both private to
 * `collections.ts`. Deleting either branch there restores the original bug in
 * full — the descriptor is dropped on the wire instead of at the row, the job
 * materializes with no agent, `derivePattern` answers `'AI'`, and the run goes
 * ahead as a plain-LLM job reporting success. Nothing else in the suite would
 * notice.
 *
 * The second claim is the one that separates a folder agent from its two
 * neighbours in the same dispatch: `resolveLocalAgent` and `resolveMcp` both
 * auto-create a disabled shell on a miss, and a folder agent must not, because
 * it *is* a directory on disk.
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
  getProfileScopeUserId: () => 'profile-1',
  getAgentLookupScope: () => ['__default__', 'profile-1']
}))
vi.mock('../services/cinnaApiService', () => ({
  getCinnaServerUrl: () => null,
  cinnaApiService: {}
}))
vi.mock('../services/syncService', () => ({ syncService: { markDirty: () => undefined } }))
/**
 * The logger is captured rather than silenced: two of the paths under test are
 * ones where a folder dependency *leaves* the job, and a log is the only trace
 * either of them produces. A no-op double could not fail a test about that.
 */
const warnings = vi.hoisted(() => [] as Array<{ msg: string; meta?: unknown }>)
vi.mock('../logger/logger', () => ({
  createLogger: () => ({
    info: () => undefined,
    warn: (msg: string, meta?: unknown) => warnings.push({ msg, meta }),
    error: () => undefined,
    debug: () => undefined
  })
}))

const { COLLECTION_MAPPERS, newResolveCache } = await import('./collections')
const { agentRepo } = await import('../db/agents')
const { jobsRepo, jobAgentRepo } = await import('../db/jobs')
const { buildJobManifest } = await import('./manifest')
const { jobService } = await import('../services/jobService')

const USER = '__default__'
const JOB_ID = 'job-1'

const folderDep: JobDepDescriptor = {
  kind: 'agent',
  source: 'folder',
  manifestId: '6f1a-uuid',
  name: 'Invoice Checker'
}

const jobMapper = COLLECTION_MAPPERS.find((m) => m.collection === 'job')

/** What the peer received from the device that owns the workshop. */
function applyIncomingJob(deps: JobDepDescriptor[]): void {
  if (!jobMapper) throw new Error('no job mapper registered')
  jobMapper.apply(
    USER,
    JOB_ID,
    {
      type: 'local',
      title: 'Nightly check',
      description: null,
      prompt: 'Check the invoices',
      modeName: null,
      // JSON round trip: the wire never hands us the objects we constructed.
      deps: JSON.parse(JSON.stringify(deps)),
      folderId: null,
      position: 0,
      deletedAt: null
    },
    false,
    { clientUpdatedAt: Date.now(), cache: newResolveCache() }
  )
}

function indexWorkshop(): void {
  agentRepo.replaceFolderIndex(USER, 'r1', [
    {
      id: 'folder:6f1a-uuid',
      name: 'Invoice Checker',
      description: null,
      localPath: '/w/Local/invoice-checker',
      remoteMetadata: {
        entrypoint_prompt: null,
        example_prompts: [],
        session_mode: null,
        ui_color_preset: null,
        protocol_versions: []
      }
    }
  ])
}

beforeEach(() => {
  holder.current = createTestDatabase()
  warnings.length = 0
})

afterEach(() => {
  holder.current?.close()
  holder.current = null
})

describe('a synced job that depends on a folder agent', () => {
  it('materializes the agent on a device that has the workshop', () => {
    indexWorkshop()
    applyIncomingJob([folderDep])
    const { agentRefs, mcpRefs } = jobsRepo.listRefs(JOB_ID)
    // The damage first: this run must talk to the agent, not to a bare model.
    expect(derivePattern(agentRefs, mcpRefs)).toBe('A2A')
    expect(agentRefs).toEqual(['folder:6f1a-uuid'])
  })

  it('keeps the descriptor in `sync_deps` even where it cannot resolve', () => {
    // Verbatim storage is what lets the peer re-encode byte-identically and
    // lets a third device still see the dependency. The old code never got
    // here — the descriptor was gone before the manifest was built.
    applyIncomingJob([folderDep])
    const job = jobsRepo.getById(USER, JOB_ID)
    expect(job?.syncDeps?.deps).toEqual([folderDep])
  })

  it('creates no agent row when the workshop is absent, and attaches nothing', () => {
    applyIncomingJob([folderDep])
    // A shell row would claim an agent this machine does not have — it would be
    // offered in both pickers and fail at the first turn.
    expect(agentRepo.list(USER)).toEqual([])
    expect(jobsRepo.listRefs(JOB_ID).agentRefs).toEqual([])
  })

  it('does not resurrect the agent from a name collision with a local agent', () => {
    // A local A2A agent called the same thing is a different dependency; only
    // the manifest id decides.
    agentRepo.create(USER, {
      name: 'Invoice Checker',
      protocol: 'a2a',
      cardUrl: 'https://elsewhere.example/.well-known/agent.json',
      enabled: true
    })
    applyIncomingJob([folderDep])
    expect(jobsRepo.listRefs(JOB_ID).agentRefs).toEqual([])
  })
})

describe('re-encoding a synced job on the device that could not resolve it', () => {
  it('carries the unresolvable folder dependency forward instead of dropping it', () => {
    // `buildJobManifest` derives descriptors from *join rows*, and this device
    // has none for the folder agent — deliberately, since it must not
    // auto-create one. Without the carry-forward, the next local edit here
    // would re-emit the job one dependency lighter and hand a third device the
    // same silent plain-LLM run this whole piece exists to prevent.
    applyIncomingJob([folderDep])
    const job = jobsRepo.getById(USER, JOB_ID)
    if (!job) throw new Error('job not applied')
    expect(buildJobManifest(USER, job).deps).toEqual([folderDep])
  })

  it('emits it once, not twice, on the device that does have the workshop', () => {
    // Here the descriptor comes from both the join row and the prior manifest;
    // `remember`'s identity-key dedupe is what keeps the bytes stable.
    indexWorkshop()
    applyIncomingJob([folderDep])
    const job = jobsRepo.getById(USER, JOB_ID)
    if (!job) throw new Error('job not applied')
    expect(buildJobManifest(USER, job).deps).toEqual([folderDep])
  })
})

describe('the Jobs detail dependency list for a folder agent', () => {
  it('calls a missing workshop `unavailable`, because nothing in the app can fix it', () => {
    applyIncomingJob([folderDep])
    const [dep] = jobService.getDependencyStatus(USER, JOB_ID)
    // `needs-setup` is the state whose repair lives in the app, and
    // `JobDetail.tsx` gates its "Set up" button on it. A folder agent is a
    // directory: the repair is copying files, so the button would lead nowhere.
    // Its two neighbours in this dispatch auto-create a shell on a miss and are
    // genuinely `needs-setup`; this arm is the one where the two come apart.
    expect(dep.state).toBe('unavailable')
    expect(dep.kind).toBe('agent')
    // The descriptor's own `name` is the only label available here — there is
    // no local row to read one from.
    expect(dep.label).toBe('Invoice Checker')
    expect(dep.localId).toBeNull()
  })

  it('resolves it, and points at the real row, where the workshop is present', () => {
    indexWorkshop()
    applyIncomingJob([folderDep])
    const [dep] = jobService.getDependencyStatus(USER, JOB_ID)
    expect(dep.state).toBe('resolved')
    expect(dep.localId).toBe('folder:6f1a-uuid')
  })

  it('keeps `needs-setup` for the one folder case the app can act on', () => {
    // The row is here and the user switched it off — a toggle away, in the app,
    // which is exactly what `needs-setup` and its "Set up" button mean. This is
    // the assertion that stops the fix above from collapsing both misses into
    // `unavailable` and losing the actionable one.
    indexWorkshop()
    agentRepo.update(USER, 'folder:6f1a-uuid', { enabled: false })
    applyIncomingJob([folderDep])
    const [dep] = jobService.getDependencyStatus(USER, JOB_ID)
    expect(dep.state).toBe('needs-setup')
    expect(dep.localId).toBe('folder:6f1a-uuid')
  })
})

/**
 * The two places a folder dependency can leave a job without anyone being told.
 *
 * Both are silent by construction rather than by oversight: the apply path
 * deliberately does not auto-create a shell, and the manifest path deliberately
 * returns null rather than emitting a descriptor it cannot key. Deliberate and
 * unlogged is the combination that makes an incident unreconstructable — the
 * arm beside each of them logs what it did, so these were the only ones that
 * left no trace at all.
 */
describe('what gets said when a folder dependency goes missing', () => {
  it('warns when a synced job cannot find the workshop it depends on', () => {
    applyIncomingJob([folderDep])
    // The join rows are the observable effect; the log is what makes it
    // explicable afterwards, and it carries the manifest id so the workshop can
    // actually be identified.
    expect(jobsRepo.listRefs(JOB_ID).agentRefs).toEqual([])
    const warned = warnings.find((w) => w.msg.includes('folder agent this device does not have'))
    expect(warned).toBeTruthy()
    expect(warned?.meta).toMatchObject({ jobId: JOB_ID, manifestId: '6f1a-uuid' })
  })

  it('says nothing when the workshop is present, so the warning stays a signal', () => {
    indexWorkshop()
    applyIncomingJob([folderDep])
    expect(warnings.filter((w) => w.msg.includes('folder agent this device does not have'))).toEqual([])
  })

  it('warns when a folder row carries an id with no manifest id behind it', () => {
    // Unreachable today — every writer of a folder row builds the id from the
    // prefix — which is exactly why it is worth a log rather than a silent
    // `return null`: the day something produces such a row, the dependency
    // vanishes from the manifest and the job runs without it.
    agentRepo.replaceFolderIndex(USER, 'r1', [
      {
        id: 'folder:',
        name: 'Nameless',
        description: null,
        localPath: '/w/Local/nameless',
        remoteMetadata: {
          entrypoint_prompt: null,
          example_prompts: [],
          session_mode: null,
          ui_color_preset: null,
          protocol_versions: []
        }
      }
    ])
    const job = jobsRepo.create(USER, { type: 'local', title: 'J', prompt: 'p' })
    jobAgentRepo.setAgentIds(job.id, ['folder:'])

    const manifest = buildJobManifest(USER, jobsRepo.getById(USER, job.id)!)

    // The consequence first: the dependency is not in the manifest, which is
    // the silent drop the log exists to explain.
    expect(manifest.deps).toEqual([])
    const warned = warnings.find((w) => w.msg.includes('carries no manifest id'))
    expect(warned).toBeTruthy()
    expect(warned?.meta).toMatchObject({ jobId: job.id, agentId: 'folder:' })
  })

  it('says nothing for a well-formed folder row on the same path', () => {
    indexWorkshop()
    const job = jobsRepo.create(USER, { type: 'local', title: 'J', prompt: 'p' })
    jobAgentRepo.setAgentIds(job.id, ['folder:6f1a-uuid'])
    buildJobManifest(USER, jobsRepo.getById(USER, job.id)!)
    expect(warnings.filter((w) => w.msg.includes('carries no manifest id'))).toEqual([])
  })
})
