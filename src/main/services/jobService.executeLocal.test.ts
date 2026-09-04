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
    expect(() => run()).toThrow(/can't run on this device/)
  })

  it('stops at what is true, and does not tell the user to copy the agent here', () => {
    // Local agents are not synced and the cross-machine matching semantics are
    // undesigned, so an instruction to hand-copy the folder would promise a
    // workflow the product has not got. It would clear the block today, which
    // is exactly what makes it unsafe to say.
    applyIncomingJob([folderDep])
    let message = ''
    try {
      run()
    } catch (err) {
      message = err instanceof Error ? err.message : String(err)
    }
    expect(message).not.toMatch(/copy|move|re-?create|folder|directory/i)
  })

  it('carries its own code, distinct from a dangling reference', () => {
    // The code never reaches the renderer — two serialisation boundaries eat it
    // — but it is read here, in main's own log, where "the agent is not on this
    // device" and "the reference has gone dangling" are different incidents.
    // Reusing `missing_dependency` for both would merge them in every grep.
    applyIncomingJob([folderDep])
    try {
      run()
      throw new Error('expected the run to be refused')
    } catch (err) {
      expect((err as { code?: string }).code).toBe('incomplete_setup')
    }
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
    // Both, because a gate and the surface that displays it must not hold
    // different opinions — the detail view is where the Run button is disabled.
    // (`needsSetup` is computed in both too. Its doc comment claimed otherwise
    // for a while, which is how this test nearly acquired the wrong reason.)
    applyIncomingJob([folderDep])
    expect(jobService.getDetail(USER, JOB_ID).incompleteSetup).toBe(true)
  })
})

/**
 * The gate is scoped to **folder and remote** agent sources. That is the whole
 * claim of this block — not that what happens to a `local` one is right.
 *
 * A `source: 'local'` A2A dependency auto-creates a disabled shell on apply, so
 * it normally resolves. Delete that shell and it resolves to nothing, leaves no
 * join row, and the run goes ahead agentless and reports success: the same
 * defect this file was written for, still live, deliberately out of scope. It
 * is out because the shell is repairable in the app (the reasoning that also
 * excludes MCPs) and because `getDependencyStatus` calls it `needs-setup` —
 * blocking it here would put the gate and the panel into disagreement.
 *
 * So this asserts the **scope**, not the behaviour. It does not call `run()`,
 * because a test asserting that the local case runs would pin a known defect as
 * a contract. When the scope widens, this test changes with it and says so.
 */
describe('the gate is scoped to folder and remote sources', () => {
  const localDep: JobDepDescriptor = {
    kind: 'agent',
    source: 'local',
    cardUrl: 'https://local.example/.well-known/agent.json',
    name: 'Local Helper'
  }

  it('does not treat a deleted local A2A shell as blocking', () => {
    applyIncomingJob([localDep])
    const shell = agentRepo.list(USER).find((a) => a.createdBySync)
    if (!shell) throw new Error('sync did not auto-create the local agent shell')
    agentRepo.delete(USER, shell.id)

    expect(jobService.getDetail(USER, JOB_ID).incompleteSetup).toBe(false)
    // And the panel still routes it to the in-app repair, which is the reason
    // the gate leaves it alone. If either of these two flips, they flip
    // together.
    const [dep] = jobService.getDependencyStatus(USER, JOB_ID)
    expect(dep.state).toBe('needs-setup')
  })
})
