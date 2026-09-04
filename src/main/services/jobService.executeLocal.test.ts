import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createTestDatabase, type TestDatabase } from '../db/testSupport/nodeSqlite'
import type { JobDepDescriptor } from '../../shared/sync'

/**
 * `jobService.executeLocal` against a real database, on the path that had never
 * been tested: a job arrives from another device naming an agent this device
 * cannot resolve, and the user presses Run.
 *
 * The failure this file exists to prevent is a *success*. The job's agent never
 * made it into the join rows — `collections.ts` pushes one only on a resolve,
 * and for a folder agent (a directory on disk) or a remote agent from another
 * server there is nothing to push. `executeLocal` read those join rows, saw
 * `[]`, asked `derivePattern([], [])`, was told `'AI'`, and spawned a plain-LLM
 * chat that ran the prompt with no agent at all and recorded `succeeded`.
 * Nothing in the output, the run history or the chat said an agent was dropped.
 *
 * The `missing_dependency` throw that was already there cannot catch this: it
 * compares `listAgentIds(jobId)` against the subset of those ids that still
 * exist, and an *absent* dependency makes both sides `[]`. It fires for a
 * dangling id, which is a different accident.
 *
 * So the assertions come in pairs, and the second half of each pair is the one
 * that matters: the run must be refused, **and no run row may be recorded** —
 * a block that still writes history has only moved the lie.
 */

const holder = vi.hoisted(() => ({ current: null as TestDatabase | null }))
/** The Cinna server this profile is signed in to; null = not a Cinna profile. */
const server = vi.hoisted(() => ({ url: null as string | null }))

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
vi.mock('./cinnaApiService', () => ({
  getCinnaServerUrl: () => server.url,
  cinnaApiService: {}
}))
vi.mock('./syncService', () => ({ syncService: { markDirty: () => undefined } }))

const { COLLECTION_MAPPERS, newResolveCache } = await import('../sync/collections')
const { agentRepo } = await import('../db/agents')
const { mcpProviderRepo } = await import('../db/mcpProviders')
const { jobsRepo, jobRunsRepo } = await import('../db/jobs')
const { jobService } = await import('./jobService')

const USER = '__default__'
const JOB_ID = 'job-1'

const folderDep: JobDepDescriptor = {
  kind: 'agent',
  source: 'folder',
  manifestId: '6f1a-uuid',
  name: 'Invoice Checker'
}

const remoteDep: JobDepDescriptor = {
  kind: 'agent',
  source: 'remote',
  remoteTargetType: 'agent',
  remoteTargetId: 'be7d-uuid',
  serverUrl: 'https://cinna.example',
  name: 'Ledger Bot'
}

const mcpDep: JobDepDescriptor = {
  kind: 'mcp',
  transport: 'stdio',
  command: '/usr/bin/ledger',
  args: [],
  name: 'Ledger MCP'
}

const jobMapper = COLLECTION_MAPPERS.find((m) => m.collection === 'job')

/** The job as it arrives from the device that could resolve it. */
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

/** This device holds the agent's workshop directory. */
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

/** This device is signed in to the server the remote agent lives on. */
function syncRemoteAgent(): void {
  agentRepo.syncRemote(USER, [
    {
      targetType: 'agent',
      targetId: 'be7d-uuid',
      name: 'Ledger Bot',
      description: null,
      cardUrl: 'https://cinna.example/.well-known/agent.json',
      skills: null,
      metadata: {
        entrypoint_prompt: null,
        example_prompts: [],
        session_mode: null,
        ui_color_preset: null,
        protocol_versions: []
      }
    }
  ])
}

function run(): ReturnType<typeof jobService.executeLocal> {
  return jobService.executeLocal(USER, JOB_ID)
}

beforeEach(() => {
  holder.current = createTestDatabase()
  server.url = 'https://cinna.example'
})

afterEach(() => {
  holder.current?.close()
  holder.current = null
})

describe('running a job whose agent this device cannot resolve', () => {
  it('refuses the run when the folder agent workshop is not on this device', () => {
    applyIncomingJob([folderDep])
    expect(() => run()).toThrow()
    // The half that was actually broken: before the gate this call *returned*,
    // and left a `job_runs` row behind that went on to report success.
    expect(jobRunsRepo.listByJob(USER, JOB_ID)).toEqual([])
  })

  it('refuses the run when the remote agent is on a server this profile is not on', () => {
    // The row is right here, under the same target id — but it belongs to a
    // different server, which is why `resolveRemoteAgent` refuses it. This is
    // the case a gate built on `buildResolveIndex.remoteAgent` alone would wave
    // through: that index is keyed on target type + id and carries no server.
    syncRemoteAgent()
    server.url = 'https://other.example'
    applyIncomingJob([remoteDep])
    expect(() => run()).toThrow()
    expect(jobRunsRepo.listByJob(USER, JOB_ID)).toEqual([])
  })

  it('refuses the run when the remote agent is not on this device at all', () => {
    applyIncomingJob([remoteDep])
    expect(() => run()).toThrow()
    expect(jobRunsRepo.listByJob(USER, JOB_ID)).toEqual([])
  })

  it('names the missing agent in the thrown message, because the code does not survive IPC', () => {
    // `ipcMain.handle` serialises a rejection to message + stack and
    // `contextBridge` re-clones it, so `err.code` is gone by the time the
    // renderer sees it (see the comment in `src/main/ipc/_wrap.ts`). The
    // sentence is the whole wire contract — if the name is not in it, the user
    // is told a dependency is missing and never which one.
    applyIncomingJob([folderDep])
    expect(() => run()).toThrow(/Invoice Checker/)
    expect(() => run()).toThrow(/isn't compatible with this setup/)
  })

  it('names every unresolvable agent, not just the first', () => {
    applyIncomingJob([folderDep, remoteDep])
    expect(() => run()).toThrow(/Invoice Checker/)
    expect(() => run()).toThrow(/Ledger Bot/)
  })
})

/**
 * The other half of the gate, and the half a careless fix passes without.
 * Routing every agent row to blocked satisfies every assertion above while
 * breaking every job that works.
 */
describe('running a job whose dependencies do resolve', () => {
  it('runs, and binds the agent as the chat root, when the workshop is here', () => {
    indexWorkshop()
    applyIncomingJob([folderDep])
    const res = run()
    // A2A: one agent, no MCPs. `agentId` non-null is the renderer's signal to
    // call `startAgent` rather than `startLlm`.
    expect(res.agentId).toBe('folder:6f1a-uuid')
    expect(jobRunsRepo.listByJob(USER, JOB_ID)).toHaveLength(1)
  })

  it('runs when the remote agent is on the server this profile is signed in to', () => {
    syncRemoteAgent()
    applyIncomingJob([remoteDep])
    const res = run()
    expect(res.agentId).toBe('remote:agent:be7d-uuid')
    expect(jobRunsRepo.listByJob(USER, JOB_ID)).toHaveLength(1)
  })

  it('runs a job that carries no synced manifest at all', () => {
    // The ordinary locally-created job. It has no `sync_deps`, so there is no
    // manifest to disagree with and the gate must not invent one.
    const job = jobsRepo.create(USER, {
      type: 'local',
      title: 'Local job',
      description: null,
      prompt: 'Do the thing'
    })
    const res = jobService.executeLocal(USER, job.id)
    expect(res.agentId).toBeNull()
    expect(jobRunsRepo.listByJob(USER, job.id)).toHaveLength(1)
  })

  it('runs when the only unresolved dependency is an MCP', () => {
    // Deliberately not blocked. An MCP miss auto-creates a *disabled* shell the
    // user finishes configuring in the app, so blocking it would break the
    // ordinary sync-then-configure path this app is built around.
    applyIncomingJob([mcpDep])
    const shells = mcpProviderRepo.list(USER)
    expect(shells).toHaveLength(1)
    expect(shells[0].enabled).toBe(false)
    expect(jobService.getDetail(USER, JOB_ID).needsSetup).toBe(true)
    expect(run().runId).toBeTruthy()
  })

  it('runs when the folder agent is here but the user switched it off', () => {
    // Present-and-disabled is a toggle, not an absence: the row exists, the
    // repair is one click inside the app, and `getDependencyStatus` calls it
    // `needs-setup` with a working "Set up" button. Collapsing it into the
    // blocked state would take that button away.
    indexWorkshop()
    applyIncomingJob([folderDep])
    agentRepo.update(USER, 'folder:6f1a-uuid', { enabled: false })
    expect(run().agentId).toBe('folder:6f1a-uuid')
  })
})

/**
 * The gate and the panel the user reads must not become two opinions.
 * `getDependencyStatus` already computes this exact set as
 * `kind: 'agent', state: 'unavailable'`; this pins that they still agree, so an
 * edit to either one shows up here as a failure rather than as drift.
 */
describe('the gate agrees with the dependency panel', () => {
  const cases: Array<[string, () => void, boolean]> = [
    ['missing workshop', () => applyIncomingJob([folderDep]), true],
    ['workshop present', () => (indexWorkshop(), applyIncomingJob([folderDep])), false],
    ['workshop present but disabled', () => {
      indexWorkshop()
      applyIncomingJob([folderDep])
      agentRepo.update(USER, 'folder:6f1a-uuid', { enabled: false })
    }, false],
    ['remote agent absent', () => applyIncomingJob([remoteDep]), true],
    ['remote agent on a foreign server', () => {
      syncRemoteAgent()
      server.url = 'https://other.example'
      applyIncomingJob([remoteDep])
    }, true],
    ['remote agent present', () => (syncRemoteAgent(), applyIncomingJob([remoteDep])), false],
    ['mcp shell only', () => applyIncomingJob([mcpDep]), false]
  ]

  for (const [name, setup, blocked] of cases) {
    it(`${name}: panel and job list say the same thing`, () => {
      setup()
      const panelSaysBlocked = jobService
        .getDependencyStatus(USER, JOB_ID)
        .some((d) => d.kind === 'agent' && d.state === 'unavailable')
      expect(panelSaysBlocked).toBe(blocked)

      const listed = jobService.list(USER).find((j) => j.id === JOB_ID)
      expect(listed?.incompleteSetup).toBe(blocked)
      expect(jobService.getDetail(USER, JOB_ID).incompleteSetup).toBe(blocked)
    })
  }
})

/**
 * `incompleteSetup` is a *different* question from `needsSetup`, and the whole
 * reason it had to be a new field: `needsSetup` is true for a disabled MCP
 * shell, which is a finish-configuring case, not a blocked one. A renderer
 * gating "can't run here" on `needsSetup` would refuse jobs that run fine.
 */
describe('incompleteSetup is not needsSetup', () => {
  it('separates the blocked job from the one that merely needs configuring', () => {
    applyIncomingJob([mcpDep])
    const configuring = jobService.getDetail(USER, JOB_ID)
    expect(configuring.needsSetup).toBe(true)
    expect(configuring.incompleteSetup).toBe(false)
  })

  it('is carried by `getDetail`, not only by `list`', () => {
    // `needsSetup` was documented as list-only and left false on the detail
    // DTO. A blocked flag with that habit would read false in the one view
    // whose Run button it has to disable.
    applyIncomingJob([folderDep])
    expect(jobService.getDetail(USER, JOB_ID).incompleteSetup).toBe(true)
  })
})
