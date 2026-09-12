import { jobRuntimeDefinition } from '../tasks/jobRuntimeDefinition'
import { jobRunStatusForTask } from '../../shared/taskStatus'
import { taskInputRequestRepo } from '../db/taskInputRequests'
import {
  jobsRepo,
  jobFoldersRepo,
  jobMcpRepo,
  jobAgentRepo,
  jobRunsRepo,
  type JobRow,
  type JobFolderRow,
  type JobFolderCreateInput,
  type JobFolderPatch,
  type JobRunRow,
  type JobRunRowWithMeta,
  type JobCreateInput,
  type JobPatch,
  type JobRunStatus
} from '../db/jobs'
import { chatRepo } from '../db/chats'
import { mcpProviderRepo } from '../db/mcpProviders'
import { chatModeRepo } from '../db/chatModes'
import { agentRepo } from '../db/agents'
import { taskRepo } from '../db/tasks'
import { getSettingsScopeUserId, getAgentLookupScope } from '../auth/scope'
import { JobError, TaskError } from '../errors'
import { newChatRouter, routingOf } from '../../shared/chatRouting'
import type { JobRunOrigin, JobExecuteResult } from '../../shared/jobs'
import type { RunState } from '../../shared/runEvents'
import { parseTaskPriority, type TaskDto } from '../../shared/tasks'
import { cinnaApiService } from './cinnaApiService'
import { syncService } from './syncService'
import { taskService } from './taskService'
import { taskRunnerBridge } from './taskRunnerBridge'
import { taskSyncService } from './taskSyncService'
import { rebuildJobManifest } from '../sync/manifest'
import {
  resolveMode,
  resolveRemoteAgent,
  profileServerUrl,
  findMcp,
  findFolderAgent,
  findLocalAgent,
  buildResolveIndex,
  manifestNeedsSetup,
  type ResolveIndex
} from '../sync/resolvers'
import { agentIdentityKey, normalizeUrl } from '../sync/identity'
import type { JobDependencyStatus, JobSyncManifest } from '../../shared/sync'
import { createLogger } from '../logger/logger'

const logger = createLogger('job')

/**
 * A run outcome as a run state, so a job run and an agent turn report a task
 * the same way. `reportRunCompletion` is the job path; the stream path posts
 * these states itself.
 */
const RUN_STATE_FOR_OUTCOME: Record<'succeeded' | 'failed' | 'cancelled', RunState> = {
  succeeded: 'completed',
  failed: 'failed',
  cancelled: 'canceled'
}

export interface JobDetail extends JobRow {
  agentIds: string[]
  mcpProviderIds: string[]
  recentRuns: JobRunRowWithMeta[]
  /**
   * Whether any synced dependency isn't fully resolved here. Kept on the DTO
   * for type honesty (`JobDetailData` declares it); the detail view itself uses
   * the richer per-dependency `job:dep-status` query for the setup surface.
   */
  needsSetup: boolean
  /**
   * Whether the manifest names an agent that resolves to nothing here, which
   * blocks the run outright. Computed here as well as in `list`, because a
   * gate and the surface that displays it must not hold different opinions —
   * this is what the detail view's Run button is disabled on.
   */
  incompleteSetup: boolean
}

/**
 * Resolve a set of agent ids against the active lookup scopes (local agents
 * live in the settings scope, remote in the active profile), returning only
 * the ids that still exist. Used to filter stale references before a write or
 * a run.
 */
function filterExistingAgents(agentIds: string[]): string[] {
  if (agentIds.length === 0) return []
  const scopes = getAgentLookupScope()
  return agentIds.filter((id) => scopes.some((scope) => !!agentRepo.getOwned(scope, id)))
}

/**
 * Agent dependencies the manifest names that resolve to **nothing** on this
 * device: a folder agent whose workshop directory isn't here, or a remote agent
 * from a server this profile isn't on. Returns their display labels, in
 * manifest order — the labels are the message, see `executeLocal`.
 *
 * This is the same set `getDependencyStatus` reports as
 * `kind: 'agent', state: 'unavailable'`, computed against a prebuilt index so
 * the job *list* can flag every row in one pass instead of one table scan per
 * dependency. `jobService.executeLocal.test.ts` pins the two answers together
 * so an edit to either shows up as a failure rather than as drift.
 *
 * Three things are deliberately **not** here:
 *
 *  - **MCP deps.** A miss auto-creates a disabled shell the user finishes
 *    configuring in the app, so blocking on one would break the ordinary
 *    sync-then-configure path.
 *  - **`source: 'local'` A2A agents.** `resolveLocalAgent` auto-creates a shell
 *    too, so a miss there is the same finish-in-app case as an MCP.
 *  - **A row that is present but disabled.** That is a toggle, not an absence:
 *    the row exists, `getDependencyStatus` calls it `needs-setup`, and its
 *    "Set up" button leads somewhere real.
 *
 * The `serverUrl` guard is not decoration. `ResolveIndex.remoteAgent` is keyed
 * on target type + id alone and carries no server, while `resolveRemoteAgent`
 * — which the detail panel goes through — refuses a descriptor naming a
 * different server. Without the guard here the two would disagree, permissively
 * and in exactly the direction this whole gate exists to close.
 */
function unresolvableAgentLabels(
  manifest: JobSyncManifest | null,
  idx: ResolveIndex,
  serverUrl: string | null
): string[] {
  if (!manifest) return []
  const out: string[] = []
  for (const desc of manifest.deps) {
    if (desc.kind !== 'agent') continue
    if (desc.source === 'remote') {
      const foreign =
        !!desc.serverUrl &&
        !!serverUrl &&
        normalizeUrl(desc.serverUrl) !== normalizeUrl(serverUrl)
      if (foreign || !idx.remoteAgent.has(agentIdentityKey(desc))) {
        out.push(desc.name ?? 'Remote agent')
      }
    } else if (desc.source === 'folder') {
      if (!idx.folderAgent.has(agentIdentityKey(desc))) {
        out.push(desc.name ?? 'Agent')
      }
    }
  }
  return out
}

const RECENT_RUNS_LIMIT = 10

function requireJob(userId: string, jobId: string): JobRow {
  const job = jobsRepo.getById(userId, jobId)
  if (!job || job.deletedAt) throw new JobError('not_found', 'Job not found')
  return job
}

/**
 * Attach the `chatHidden` flag to a single run so the IPC surface keeps the
 * same DTO shape across `listRuns` and single-row methods. Cinna runs and
 * local runs with no chat get `false`.
 */
function enrichRun(userId: string, run: JobRunRow): JobRunRowWithMeta {
  if (run.type !== 'local' || !run.localChatId) {
    return { ...run, chatHidden: false }
  }
  const chat = chatRepo.getOwned(userId, run.localChatId)
  return { ...run, chatHidden: !!chat?.hiddenFromList }
}

function validateCreate(input: JobCreateInput): void {
  if (!input.title?.trim()) throw new JobError('invalid_input', 'Title is required')
  if (!input.prompt?.trim()) throw new JobError('invalid_input', 'Prompt is required')
  if (input.type !== 'local' && input.type !== 'cinna_task') {
    throw new JobError('invalid_input', `Unknown job type: ${input.type}`)
  }
}

export interface JobListItem extends JobRow {
  /**
   * Count of this job's runs currently in a non-terminal state (`pending` or
   * `running`). Drives the sidebar's run-progress spinner so the user can
   * see at a glance which jobs are still working.
   */
  inProgressRunsCount: number
  /**
   * True when the job's synced dependency manifest has at least one dependency
   * that isn't fully resolved on this device (auto-created/disabled MCP/agent,
   * foreign remote agent, or a missing mode with no default). Drives the
   * sidebar "finish setup" badge.
   */
  needsSetup: boolean
  /**
   * True when the manifest names an agent that resolves to nothing on this
   * device. Drives the sidebar's blocked marker — and, unlike `needsSetup`,
   * means the run is refused rather than merely unconfigured.
   */
  incompleteSetup: boolean
}

export const jobService = {
  list(userId: string): JobListItem[] {
    const rows = jobsRepo.list(userId)
    const counts = jobRunsRepo.countInProgressByJob(userId)
    // Only build the resolution index (4 table scans) when at least one job
    // actually carries a synced manifest — non-Cinna / never-synced workspaces
    // skip the work entirely.
    const index = rows.some((j) => j.syncDeps) ? buildResolveIndex(userId) : null
    const serverUrl = index ? profileServerUrl(userId) : null
    return rows.map((j) => ({
      ...j,
      inProgressRunsCount: counts.get(j.id) ?? 0,
      needsSetup: index ? manifestNeedsSetup(j.syncDeps, index) : false,
      incompleteSetup: index
        ? unresolvableAgentLabels(j.syncDeps, index, serverUrl).length > 0
        : false
    }))
  },

  getDetail(userId: string, jobId: string): JobDetail {
    const job = requireJob(userId, jobId)
    const agentIds = jobAgentRepo.listAgentIds(jobId)
    const mcpProviderIds = jobMcpRepo.listProviderIds(jobId)
    const recentRuns = jobRunsRepo
      .listByJob(userId, jobId)
      .slice(0, RECENT_RUNS_LIMIT)
    const index = job.syncDeps ? buildResolveIndex(userId) : null
    const needsSetup = index ? manifestNeedsSetup(job.syncDeps, index) : false
    const incompleteSetup = index
      ? unresolvableAgentLabels(job.syncDeps, index, profileServerUrl(userId)).length > 0
      : false
    return { ...job, agentIds, mcpProviderIds, recentRuns, needsSetup, incompleteSetup }
  },

  create(userId: string, input: JobCreateInput): JobRow {
    validateCreate(input)
    const definition = jobRuntimeDefinition(input)
    const job = jobsRepo.create(userId, { ...input, ...definition })
    // Seed the portable dependency manifest from initial state (mode only —
    // agents/MCPs are attached afterwards via setAgents/setMcpProviders).
    rebuildJobManifest(userId, job.id)
    logger.info('job created', { jobId: job.id, type: job.type })
    syncService.markDirty(userId)
    return job
  },

  update(userId: string, jobId: string, patch: JobPatch): JobRow {
    const existing = requireJob(userId, jobId)
    const changesRuntime = ['type', 'router', 'script', 'budget'].some((key) => Object.hasOwn(patch, key))
    const normalized = changesRuntime ? { ...patch, ...jobRuntimeDefinition({ ...existing, ...patch }) } : patch
    if (patch.type && patch.type !== 'local' && patch.type !== 'cinna_task') {
      throw new JobError('invalid_input', `Unknown job type: ${patch.type}`)
    }
    if (patch.title !== undefined && !patch.title.trim()) {
      throw new JobError('invalid_input', 'Title is required')
    }
    if (patch.prompt !== undefined && !patch.prompt.trim()) {
      throw new JobError('invalid_input', 'Prompt is required')
    }
    const ok = jobsRepo.update(userId, jobId, normalized)
    if (!ok) throw new JobError('not_found', 'Job not found')
    const updated = jobsRepo.getById(userId, jobId)
    if (!updated) throw new JobError('not_found', 'Job not found after update')
    // A mode change alters the manifest's `modeName`; rebuild so the synced
    // truth tracks the local edit.
    if (patch.modeId !== undefined) rebuildJobManifest(userId, jobId)
    syncService.markDirty(userId)
    return updated
  },

  softDelete(userId: string, jobId: string): void {
    const ok = jobsRepo.softDelete(userId, jobId)
    if (!ok) throw new JobError('not_found', 'Job not found')
    logger.info('job deleted', { jobId })
    syncService.markDirty(userId)
  },

  setMcpProviders(userId: string, jobId: string, mcpProviderIds: string[]): void {
    requireJob(userId, jobId)
    const validIds = new Set(
      mcpProviderRepo.list(getSettingsScopeUserId()).map((p) => p.id)
    )
    const filtered = mcpProviderIds.filter((id) => validIds.has(id))
    if (filtered.length !== mcpProviderIds.length) {
      const dropped = mcpProviderIds.filter((id) => !validIds.has(id))
      logger.warn('setMcpProviders: dropped stale ids', { jobId, dropped })
    }
    jobMcpRepo.setProviderIds(jobId, filtered)
    jobsRepo.touch(userId, jobId)
    rebuildJobManifest(userId, jobId)
    syncService.markDirty(userId)
  },

  setAgents(userId: string, jobId: string, agentIds: string[]): void {
    requireJob(userId, jobId)
    // Drop ids that no longer resolve (an agent removed elsewhere shouldn't
    // wedge the form) — mirrors setMcpProviders' stale-id filter.
    const filtered = filterExistingAgents(agentIds)
    if (filtered.length !== agentIds.length) {
      const dropped = agentIds.filter((id) => !filtered.includes(id))
      logger.warn('setAgents: dropped stale ids', { jobId, dropped })
    }
    jobAgentRepo.setAgentIds(jobId, filtered)
    jobsRepo.touch(userId, jobId)
    rebuildJobManifest(userId, jobId)
    syncService.markDirty(userId)
  },

  listRuns(userId: string, jobId: string): JobRunRowWithMeta[] {
    requireJob(userId, jobId)
    return jobRunsRepo.listByJob(userId, jobId)
  },

  /**
   * Resolve a job's portable dependency manifest against this device's current
   * local state (plan §8). Drives the "finish setup on this device" UX:
   * `resolved` (seamless), `needs-setup` (amber — auto-created/disabled MCP or
   * agent), `unavailable` (grey — can't resolve here, e.g. a remote agent from a
   * server this profile isn't on). Empty when the job has no synced manifest.
   */
  getDependencyStatus(userId: string, jobId: string): JobDependencyStatus[] {
    const job = jobsRepo.getById(userId, jobId)
    const manifest = job?.syncDeps
    if (!job || !manifest) return []

    const out: JobDependencyStatus[] = []

    if (manifest.modeName) {
      const modeId = resolveMode(manifest.modeName)
      out.push({
        key: `mode:${manifest.modeName}`,
        kind: 'mode',
        label: manifest.modeName,
        state: modeId ? 'resolved' : 'unavailable',
        localId: modeId
      })
    }

    manifest.deps.forEach((desc, i) => {
      if (desc.kind === 'mcp') {
        const row = findMcp(desc)
        out.push({
          key: `mcp:${i}`,
          kind: 'mcp',
          label: row?.name ?? desc.name,
          state: row ? (row.enabled ? 'resolved' : 'needs-setup') : 'needs-setup',
          localId: row?.id ?? null,
          transport: desc.transport
        })
      } else if (desc.source === 'remote') {
        const id = resolveRemoteAgent(userId, desc, profileServerUrl(userId))
        out.push({
          key: `agent:${i}`,
          kind: 'agent',
          label: desc.name ?? 'Remote agent',
          state: id ? 'resolved' : 'unavailable',
          localId: id
        })
      } else if (desc.source === 'folder') {
        // The two misses are different states, and this is the arm where they
        // come apart. A local agent or an MCP auto-creates a disabled shell on
        // apply, so a miss there is always `needs-setup`: the row exists and
        // the user finishes configuring it in the app. A folder agent creates
        // nothing, so an absent row means the *workshop is not on this device*
        // — nothing in the app can resolve it, because the repair is copying a
        // directory. That is `unavailable`, the same state a remote agent from
        // a server this profile is not on gets, and for the same reason.
        //
        // `needs-setup` is kept for the one folder case the app can act on: the
        // row is here and the user has switched it off. The distinction is not
        // cosmetic — `JobDetail.tsx` gates its "Set up" button on the amber
        // state, so calling a missing workshop `needs-setup` offered a button
        // that could not lead anywhere.
        const row = findFolderAgent(desc)
        out.push({
          key: `agent:${i}`,
          kind: 'agent',
          label: row?.name ?? desc.name ?? 'Agent',
          state: row ? (row.enabled ? 'resolved' : 'needs-setup') : 'unavailable',
          localId: row?.id ?? null
        })
      } else {
        const row = findLocalAgent(desc)
        out.push({
          key: `agent:${i}`,
          kind: 'agent',
          label: row?.name ?? desc.name ?? 'Agent',
          state: row ? (row.enabled ? 'resolved' : 'needs-setup') : 'needs-setup',
          localId: row?.id ?? null
        })
      }
    })

    return out
  },

  /**
   * Resolve a run id back to its originating job (id + title) for the chat-page
   * "from job" banner. Returns null when the run is unknown, or its job is
   * missing/soft-deleted — the banner shouldn't link to a job that's gone.
   */
  getRunOrigin(userId: string, runId: string): JobRunOrigin | null {
    const run = jobRunsRepo.getById(userId, runId)
    if (!run) return null
    const job = jobsRepo.getById(userId, run.jobId)
    if (!job || job.deletedAt) return null
    return { jobId: job.id, jobTitle: job.title }
  },

  /**
   * Single entry point for running a job.
   *
   * **The last place `job.type` decides anything.** §5.8's end state is that
   * the type is only which value the task's `executor` starts at, and after
   * step 11 that is all it is: both arms make a task, and what differs is
   * whether the work is started in a chat on this device or handed across the
   * seam to a service. Nothing downstream of here reads it — a run's status
   * comes from its task, and a refresh goes through whichever adapter holds it.
   *
   * The return is still a discriminated union, because the renderer does two
   * different things with the answer: navigate to the spawned chat and kick off
   * the stream, or stay on the job and start polling.
   */
  async execute(
    userId: string,
    jobId: string,
    settingsUserId = getSettingsScopeUserId()
  ): Promise<JobExecuteResult> {
    const job = requireJob(userId, jobId)
    if (job.type === 'cinna_task') {
      const res = await this.executeCinnaTask(userId, jobId)
      return { type: 'cinna_task', ...res }
    }
    if (job.router === 'coordinator') {
      const { startCoordinatorJob } = await import('./coordinatorJobService')
      return { type: 'local', execution: 'main', ...await startCoordinatorJob({ profileUserId: userId, settingsUserId }, job) }
    }
    if (job.router === 'script') {
      const { scriptRuntimeService } = await import('./scriptRuntimeService')
      return { type: 'local', execution: 'main', ...scriptRuntimeService.startJob({ profileUserId: userId, settingsUserId }, job) }
    }
    return { type: 'local', ...this.executeLocal(userId, jobId) }
  },

  /**
   * Spawn a fresh chat seeded with the job's prompt + agent/mode/MCP config,
   * then record a `job_runs` row pointing at it. The renderer is responsible
   * for kicking off the actual stream (LLM or agent) — this method only sets
   * up the persisted state so the stream-completion hook can flip the run
   * status when the first assistant turn finishes.
   *
   * The same `newChatRouter` decision the new-chat composer makes routes the
   * run. One agent and no MCPs binds that agent as the chat's root (`direct`);
   * several agents make a chat the user routes by hand (`human`); agents mixed
   * with MCP servers need the model to coordinate.
   *
   * A `human` run addresses **one** of the job's agents — the first of
   * `jobAgentRepo.listAgentIds`, which is stable but arbitrary, because
   * `job_agents` records no order (see its own docstring). That is honest
   * rather than ideal: a run is one prompt, so it has to pick somebody, and the
   * user routes the rest of the conversation in the chat it spawns. Phase 5
   * replaces this with a task, which is where a job that means to address a
   * particular agent will be able to say so.
   *
   * `agentId` in the return is who the **first message** goes to, null when
   * that is the local model. Phase 5 replaces this with a task, so nothing more
   * elaborate is attempted here.
   */
  executeLocal(
    userId: string,
    jobId: string
  ): {
    chatId: string
    runId: string
    /** The task this run is executing. Every local run has one. */
    taskId: string
    prompt: string
    agentId: string | null
    modeId: string | null
  } {
    const job = requireJob(userId, jobId)
    if (job.type !== 'local') {
      throw new JobError('unsupported_type', 'executeLocal called on non-local job')
    }
    // Definitions must never fall through to the legacy renderer-started turn.
    if (job.router != null || job.script != null || job.budget != null) {
      jobRuntimeDefinition(job)
      throw new JobError('unsupported_type', 'This job requires the autonomous job executor.')
    }

    // **This is the block.** The `incompleteSetup` flag on the job DTO reports
    // the same condition to the UI so the user sees it before clicking, but a
    // flag only tells; this refusal is what actually stops the run, and it is
    // recomputed here so a renderer working from a stale job list still cannot
    // start one.
    //
    // The check the join rows below cannot make. They are the *resolved*
    // subset: `collections.ts` pushes a row only when a descriptor resolved, so
    // an agent that isn't on this device leaves no row and no trace. The
    // `missing_dependency` throw further down compares those rows against
    // themselves and is therefore blind to it — both sides are `[]` — and the
    // run went ahead with no agent, the router answered "a chat with the local
    // model", and a plain-LLM chat reported success. The manifest is the only record that the
    // agent was ever part of this job, so the manifest is what gets asked.
    //
    // The whole explanation goes in the *message* on purpose. A `DomainError`'s
    // `code` does not survive the trip to the renderer — `ipcMain.handle`
    // serialises a rejection to message + stack and `contextBridge` re-clones
    // it (see the comment in `src/main/ipc/_wrap.ts`) — so a renderer guard on
    // `err.code` would silently never fire. The code below is for this
    // process's own log; the sentence is the wire contract, and it names the
    // agents because "a dependency is missing" without saying which one leaves
    // the user with nothing to act on.
    //
    // The message stops at *what is true*. It does not tell the user to copy
    // the agent's folder onto this machine, even though that is what would
    // clear it today: local agents are not synced, and how an agent on one
    // machine corresponds to one on another is undesigned. Advice that happens
    // to work is still a promise the product has not made.
    //
    // **What this gate deliberately does not cover.** A `source: 'local'` A2A
    // dependency whose auto-created shell the user later *deletes* resolves to
    // nothing, leaves no join row, and still runs agentless reporting success —
    // the identical failure, knowingly left live. It is out because the shell is
    // repairable inside the app, which is the same reason MCPs are out, and
    // because `getDependencyStatus` calls that case `needs-setup`: blocking it
    // would put this gate and the panel the user reads into disagreement. If
    // that changes, the `getDependencyStatus` local arm moves with it.
    const blocked = job.syncDeps
      ? unresolvableAgentLabels(job.syncDeps, buildResolveIndex(userId), profileServerUrl(userId))
      : []
    if (blocked.length > 0) {
      logger.warn('refused to run a job with an unresolvable agent', { jobId, blocked })
      throw new JobError(
        'incomplete_setup',
        `This job can't run on this device. It needs ${
          blocked.length === 1 ? 'an agent' : 'agents'
        } that ${blocked.length === 1 ? "isn't" : "aren't"} available here: ${blocked.join(', ')}.`
      )
    }

    // Attached agents (multi). A missing reference is a hard dependency break,
    // matching the single-agent contract — surfaced as an inline run error.
    const agentIds = jobAgentRepo.listAgentIds(jobId)
    const existingAgentIds = filterExistingAgents(agentIds)
    if (existingAgentIds.length !== agentIds.length) {
      throw new JobError('missing_dependency', 'Agent referenced by job no longer exists')
    }

    const mode = job.modeId
      ? chatModeRepo.getOwned(getSettingsScopeUserId(), job.modeId)
      : null
    if (job.modeId && !mode) {
      throw new JobError('missing_dependency', 'Chat mode referenced by job no longer exists')
    }

    // Drop MCP ids that no longer exist (FK would crash the insert anyway).
    const rawMcpIds = jobMcpRepo.listProviderIds(jobId)
    let filteredMcpIds: string[] = []
    if (rawMcpIds.length > 0) {
      const validIds = new Set(
        mcpProviderRepo.list(getSettingsScopeUserId()).map((p) => p.id)
      )
      filteredMcpIds = rawMcpIds.filter((id) => validIds.has(id))
      const dropped = rawMcpIds.length - filteredMcpIds.length
      if (dropped > 0) {
        logger.warn('executeLocal: dropped stale mcp ids', { jobId, dropped })
      }
    }

    const router = newChatRouter({ agentIds: existingAgentIds, mcpIds: filteredMcpIds })
    const rootAgentId = router === 'direct' ? (existingAgentIds[0] ?? null) : null
    const answerer = routingOf({ router, agentId: rootAgentId }).answerer()
    // Who takes the first message: the root, or — in a chat the user routes —
    // the first agent attached, matching `startNewChat`.
    const firstAnswerer = router === 'coordinator' ? null : (existingAgentIds[0] ?? null)

    const { chatId, runId } = jobRunsRepo.createLocalChatAndRun({
      userId,
      jobId,
      title: job.title,
      prompt: job.prompt,
      rootAgentId,
      router,
      modeId: job.modeId,
      providerId: mode?.providerId ?? null,
      modelId: mode?.modelId ?? null,
      // The root is the chat's own counterparty, not one of its attached
      // agents; everything else is attached.
      onDemandAgentIds: existingAgentIds.filter((id) => id !== rootAgentId),
      // The MCP servers are the **model's** tools; an agent cannot call them.
      // So they are attached whenever the model is the one answering — which
      // `router === 'coordinator'` does not cover: a job with connectors and no
      // agent at all is `direct`, to the model, and dropping its servers there
      // would run it toolless and report success.
      onDemandMcpIds: answerer.kind === 'model' ? filteredMcpIds : []
    })

    // The task, **after** the chat and the run exist.
    //
    // §5.8 sketches this the other way round — create the task, then start it —
    // and that inversion is right, but it belongs with step 11, where the
    // adapter turns `start` into one dispatch for both executors. Creating the
    // task first *today* would mean every refusal above (an unresolvable agent,
    // a deleted MCP, a missing mode) left an orphan task sitting in `new` that
    // nothing would ever run or clear. Those refusals are load-bearing and are
    // deliberately left untouched.
    const task = taskService.create(userId, {
      title: job.title,
      goal: job.prompt,
      router,
      origin: 'local',
      executor: 'desktop',
      chatId,
      assigneeAgentId: firstAnswerer,
      assigneeName: firstAnswerer ? (agentRepo.getOwned(userId, firstAnswerer)?.name ?? null) : null,
      assigneeKind: firstAnswerer ? 'agent' : 'model',
      priority: parseTaskPriority(job.cinnaPriority),
      jobId,
      jobRunId: runId
    })
    jobRunsRepo.setTaskId(runId, task.id)
    // The run is already `running` — `createLocalChatAndRun` writes it that way
    // — so the task says the same thing rather than sitting at `new` until the
    // first delta arrives.
    taskService.start(userId, task.id, { chatId })

    logger.info('job executed (local)', {
      jobId,
      chatId,
      runId,
      taskId: task.id,
      router,
      agents: existingAgentIds.length,
      mcps: filteredMcpIds.length
    })

    return {
      chatId,
      runId,
      taskId: task.id,
      prompt: job.prompt,
      agentId: firstAnswerer,
      modeId: job.modeId
    }
  },

  /**
   * Stream-completion hook — called by chatStreamingService /
   * a2aStreamingService when the chat finishes (or errors). No-op if the
   * chat isn't linked to a job run or the run is already terminal.
   *
   * **`cancelled` is here because a stop is an ending, not a non-event.** A
   * user who presses Stop leaves the stream through its abort branch, and while
   * that branch reported nothing the run stayed `running` for the life of the
   * app: nothing reaps a stale one, and `countInProgressByJob` — the sidebar's
   * "is this job running?" indicator — counts `pending` and `running`, so the
   * job advertised itself as busy for ever. `setRunStatus` could already write
   * the status; it is only reachable from the explicit run-cancel action in
   * `job.ipc.ts`, which is a different gesture from stopping the chat.
   */
  reportRunCompletion(
    chatId: string,
    outcome: 'succeeded' | 'failed' | 'cancelled',
    errorMessage?: string
  ): void {
    const run = jobRunsRepo.getByLocalChatId(chatId)
    if (!run) return
    if (run.status !== 'running' && run.status !== 'pending') return
    if (taskInputRequestRepo.listOpenForChat(chatId)
      .some((request) => request.resume === 'next_message')) return
    jobRunsRepo.updateStatus(run.id, outcome, { errorMessage: errorMessage ?? null })

    // The task is the record of the work; the run row is the record of the
    // *job's* attempt at it. Both are written, and the task's status comes from
    // the run vocabulary through `applyRunState` rather than being derived here
    // — `submitted` does not map onto a legal step from `in_progress`, and this
    // path is not written to catch a throw.
    //
    // Deliberately best-effort: a run that has genuinely finished must be
    // recorded as finished even if the task write fails, or the sidebar counts
    // it as busy for the life of the app. Failing the whole hook to keep two
    // rows in step would trade a visible wrong status for an invisible one.
    if (run.taskId) {
      try {
        taskService.applyRunState(run.userId, run.taskId, RUN_STATE_FOR_OUTCOME[outcome])
        if (outcome === 'failed' && errorMessage) {
          taskService.setStatus(run.userId, run.taskId, 'error', { errorMessage })
        }
      } catch (err) {
        logger.warn('could not record the run outcome on its task', {
          runId: run.id,
          taskId: run.taskId,
          error: err instanceof Error ? err.message : String(err)
        })
      }
    }

    logger.info('job run finalized via chat stream', {
      runId: run.id,
      chatId,
      taskId: run.taskId ?? undefined,
      status: outcome
    })
  },

  /**
   * Run a `cinna_task` job by **handing its task to the service**, which is the
   * same gesture §5.10 gives the user and the same code behind it.
   *
   * Until step 11 this method spoke to one server directly — `createTask` with
   * `auto_execute: true` on `cinnaApiService`, a local `job_runs` row, and no
   * task at all — so a cinna job run was the one run in the app with nothing in
   * the tasks table, invisible to the inbox, to the task page and to the user's
   * other devices. Now it makes a task like every other run and moves it across
   * the seam; `cinna` is chosen by {@link taskSyncService.handOff} asking the
   * registry which adapter this profile can use, and the word does not appear
   * here. §5.8 wrote `job.type === 'cinna_task' ? 'cinna' : null` into this
   * method, which is the phase's own exit criterion broken in its own plan.
   *
   * **A hand-over that fails leaves nothing behind.** The task has to exist
   * before the adapter can be given it — `external_ref` is the desktop's own id,
   * which is what makes a retried create idempotent — so the orphan
   * `executeLocal` avoids by ordering has to be cleaned up by hand here. A
   * refused run leaves no task and no run row, which is what its own test
   * asserts and what the user sees: the error, and nothing new in the list.
   */
  async executeCinnaTask(
    userId: string,
    jobId: string
  ): Promise<{
    runId: string
    taskId: string
    cinnaTaskId: string
    cinnaShortCode: string | null
  }> {
    const job = requireJob(userId, jobId)
    if (job.type !== 'cinna_task') {
      throw new JobError('unsupported_type', 'executeCinnaTask called on non-cinna job')
    }
    if (job.router != null || job.script != null || job.budget != null) jobRuntimeDefinition(job)
    if (!job.cinnaAgentId) {
      throw new JobError('missing_dependency', 'Cinna agent is required to run this job')
    }
    // **Before the task exists.** The hand-over checks this too, and by then the
    // task has been created — so a profile that is not connected to a service
    // minted a task and soft-deleted it on *every* press of Run. A soft delete
    // is not a rollback: the row survives for ever and travels to the user's
    // other devices as an ordinary upsert carrying `deleted: true`. The task
    // still cannot be created after the adapter call (`adapter.create` is handed
    // its id as `external_ref`, which is what makes a retried create
    // idempotent), so the check moves rather than the creation.
    if (!(await taskSyncService.preferredAdapterId(userId))) {
      throw new JobError(
        'incomplete_setup',
        "This job runs on a service, and this profile isn't connected to one."
      )
    }

    const task = taskService.create(userId, {
      title: job.title,
      goal: job.prompt,
      // The service routes the work; the desktop's own routers describe a chat,
      // and this task has none.
      router: 'direct',
      origin: 'local',
      executor: 'desktop',
      // **An id in the space its kind names.** `remote_agent` is an agent that
      // exists on the service and nowhere here, which is exactly what a job's
      // configured agent is — there is no local `agents` row to point at.
      assigneeAgentId: job.cinnaAgentId,
      assigneeName: null,
      assigneeKind: 'remote_agent',
      priority: parseTaskPriority(job.cinnaPriority),
      jobId
    })

    let handed: TaskDto
    try {
      handed = await taskSyncService.handOff(userId, task.id)
    } catch (err) {
      // Soft-deleted rather than left: a task nothing picked up is not a task,
      // and leaving it would put a permanently `new` row on the user's other
      // devices for a run that never happened.
      //
      // **The cleanup may not replace the failure.** It is a second write on a
      // path that has already failed once, and a throw from it would surface
      // instead of the hand-over's own error — so the user would read "Task not
      // found" where the truth was "that service refused the work". The
      // original is what the surface needs; an orphan is what the log gets.
      // **Not for a hand-over that succeeded.** `handed_over` means the service
      // took the work and only the local record of it was lost, so there is
      // nothing to clean up and an agent is running right now. Deleting here
      // would be the app arguing with a row a peer has already removed.
      if (err instanceof TaskError && (err.code === 'handed_over' || err.code === 'handoff_uncertain')) throw err
      try {
        taskService.remove(userId, task.id)
      } catch (cleanupErr) {
        logger.warn('a refused hand-over left its task behind', {
          jobId,
          taskId: task.id,
          error: cleanupErr instanceof Error ? cleanupErr.message : String(cleanupErr)
        })
      }
      throw err
    }

    const run = jobRunsRepo.create({
      jobId,
      userId,
      type: 'cinna_task',
      taskId: task.id,
      // The two columns the run row keeps for its deep link. They are fed from
      // the binding rather than from a server response, so a second adapter
      // fills them the same way — the names are older than the seam and a
      // rename belongs with the rest of `job.type` in phase 7.
      cinnaTaskId: handed.remote?.id ?? null,
      cinnaShortCode: handed.remote?.key ?? null,
      status: jobRunStatusForTask(handed.status)
    })
    taskService.linkJobRun(userId, task.id, run.id)

    logger.info('job executed (handed to a service)', {
      jobId,
      runId: run.id,
      taskId: task.id,
      remoteId: handed.remote?.id,
      shortCode: handed.remote?.key
    })

    return {
      runId: run.id,
      taskId: task.id,
      cinnaTaskId: handed.remote?.id ?? '',
      cinnaShortCode: handed.remote?.key ?? null
    }
  },

  /**
   * Bring a run that is executing on a service up to date, and let its status
   * follow its task's.
   *
   * **The run status is derived, not fetched.** Until step 11 this asked one
   * hardcoded server for a task detail and mapped the string it answered with;
   * now {@link taskSyncService.pullOne} asks whichever adapter holds the task,
   * writes the answer to the task row, and the run row says whatever its task
   * says. That is §5.8's "the job run's status derives from the task" and it is
   * what stops the two disagreeing — there was nothing keeping them in step
   * before, because only one of them was ever written.
   *
   * **A run from before this step has no task**, and is adopted rather than
   * left on a path of its own: a task is created for it, bound to the remote id
   * the run row already carries, and the pull fills in everything else. Keeping
   * the old fetch beside the new one for those rows would have been a second
   * code path serving a shrinking set, and the run would still have been the
   * one kind in the app with no task behind it.
   *
   * Skips the network for an already-terminal run unless `force` is set, which
   * is the manual refresh.
   */
  async refreshCinnaRun(
    userId: string,
    runId: string,
    options: { force?: boolean } = {}
  ): Promise<JobRunRowWithMeta> {
    const run = jobRunsRepo.getById(userId, runId)
    if (!run) throw new JobError('not_found', 'Job run not found')
    if (run.type !== 'cinna_task') return enrichRun(userId, run)
    const isTerminal =
      run.status === 'succeeded' || run.status === 'failed' || run.status === 'cancelled'
    if (isTerminal && !options.force) {
      return enrichRun(userId, run)
    }

    const taskId = run.taskId ?? (await adoptRemoteRun(userId, run))
    if (!taskId) return enrichRun(userId, run)

    logger.info('refreshing a run executing on a service', {
      runId,
      taskId,
      prevStatus: run.status,
      force: options.force ?? false
    })
    const task = await taskSyncService.pullOne(userId, taskId)
    if (task) {
      // The accepted remote snapshot projects only its matching active attempt.
      // Repeating that write here would erase its error and overwrite history.
      logger.info('run refreshed from its task', { runId, taskStatus: task.status })
    } else {
      // **A null from `pullOne` is three different things**, and only one of
      // them is news: the service could not be reached (say nothing and try
      // again later), the task is no longer bound to anything, or the task row
      // has gone. Telling them apart matters because the second is terminal —
      // the pull unbinds on `not_ours`, which is a 404 or an ownership refusal,
      // and a run whose work has been deleted on the service will never move
      // again. Left as it was, it polled every five seconds for the life of the
      // window with the job's badge lit, and every manual Refresh reported
      // success.
      //
      // Asked of the row rather than returned by `pullOne`, because "is this
      // task still bound" is the fact that decides it and the row is where that
      // fact lives.
      const currentTask = taskRepo.getById(userId, taskId)
      const stillBound = currentTask?.remoteAdapter ?? null
      if (!stillBound) {
        const currentRun = jobRunsRepo.getById(userId, runId)
        if (currentRun && currentRun.taskId === taskId && ['pending', 'running'].includes(currentRun.status) &&
          (!currentTask || currentRun.localChatId === currentTask.chatId)) {
          jobRunsRepo.updateStatus(runId, 'failed')
        }
        logger.warn('a run lost the work it was executing', { runId, taskId })
        throw new JobError(
          'missing_dependency',
          'That task no longer exists on the service that was running it.'
        )
      }
    }
    const fresh = jobRunsRepo.getById(userId, runId) ?? run
    return enrichRun(userId, fresh)
  },

  /**
   * Resolve the configured Cinna server base URL for the active profile.
   * Used by the renderer to build the "Open on Cinna" deep link.
   */
  getCinnaServerUrl(userId: string): string {
    return cinnaApiService.getServerUrl(userId)
  },

  /**
   * Permanently delete a run. For local runs, the originating chat is
   * hard-deleted in the same transaction (cascading rows: messages, MCP
   * junctions, agent sessions, etc. via FK `ON DELETE CASCADE`). For
   * cinna_task runs, only the desktop's bookkeeping is removed — the
   * upstream cinna-core task is unaffected.
   *
   * The returned `chatId` is what the IPC layer hands to the renderer for
   * cache invalidation and (if it was the active chat) navigation reset.
   */
  deleteRun(userId: string, runId: string): { chatId: string | null; chatDeleted: boolean } {
    const result = jobRunsRepo.deleteWithChat(userId, runId)
    if (!result.runDeleted) {
      throw new JobError('not_found', 'Job run not found')
    }
    // The repository hard-deletes the owned chat too. Follow the same
    // lifecycle notification as chatService.permanentDelete so a waiting
    // script cannot retain unanswerable gates and permanent reservations.
    if (result.chatDeleted && result.chatId) taskRunnerBridge.chatRemoved(userId, result.chatId)
    logger.info('job run deleted', {
      runId,
      chatId: result.chatId,
      chatDeleted: result.chatDeleted
    })
    return { chatId: result.chatId, chatDeleted: result.chatDeleted }
  },

  /** Force-flip a run to a terminal status (used by manual cancel paths). */
  setRunStatus(
    userId: string,
    runId: string,
    status: JobRunStatus,
    errorMessage?: string | null
  ): JobRunRowWithMeta {
    const run = jobRunsRepo.getById(userId, runId)
    if (!run) throw new JobError('not_found', 'Job run not found')
    if (run.status !== 'pending' && run.status !== 'running') return enrichRun(userId, run)
    if (run.taskId && (status === 'succeeded' || status === 'failed' || status === 'cancelled')) {
      const task = taskService.getById(userId, run.taskId)
      if (task.executor === 'desktop') {
        // setStatus validates this device's claim and expires idle Inbox asks.
        // Do this before the job write so a refused claim changes neither row.
        taskService.applyRunState(userId, task.id, RUN_STATE_FOR_OUTCOME[status])
        if (status === 'failed' && errorMessage) {
          taskService.setStatus(userId, task.id, 'error', { errorMessage })
        }
      }
    }
    jobRunsRepo.updateStatus(runId, status, { errorMessage: errorMessage ?? null })
    const updated = jobRunsRepo.getById(userId, runId)
    if (!updated) throw new JobError('not_found', 'Job run not found after update')
    return enrichRun(userId, updated)
  },

  // ---- Folders ------------------------------------------------------------

  listFolders(userId: string): JobFolderRow[] {
    return jobFoldersRepo.list(userId)
  },

  createFolder(userId: string, input: JobFolderCreateInput): JobFolderRow {
    const name = input.name?.trim()
    if (!name) throw new JobError('invalid_input', 'Folder name is required')
    const folder = jobFoldersRepo.create(userId, { name })
    logger.info('job folder created', { folderId: folder.id })
    syncService.markDirty(userId)
    return folder
  },

  updateFolder(
    userId: string,
    folderId: string,
    patch: JobFolderPatch
  ): JobFolderRow {
    const existing = jobFoldersRepo.getById(userId, folderId)
    if (!existing) throw new JobError('not_found', 'Folder not found')
    if (patch.name !== undefined && !patch.name.trim()) {
      throw new JobError('invalid_input', 'Folder name is required')
    }
    const normalized: JobFolderPatch = {}
    if (patch.name !== undefined) normalized.name = patch.name.trim()
    if (patch.collapsed !== undefined) normalized.collapsed = patch.collapsed
    if (Object.keys(normalized).length === 0) return existing
    const ok = jobFoldersRepo.update(userId, folderId, normalized)
    if (!ok) throw new JobError('not_found', 'Folder not found')
    const updated = jobFoldersRepo.getById(userId, folderId)
    if (!updated) throw new JobError('not_found', 'Folder not found after update')
    syncService.markDirty(userId)
    return updated
  },

  deleteFolder(userId: string, folderId: string): void {
    const existing = jobFoldersRepo.getById(userId, folderId)
    if (!existing) throw new JobError('not_found', 'Folder not found')
    jobFoldersRepo.delete(userId, folderId)
    logger.info('job folder deleted', { folderId })
    syncService.markDirty(userId)
  },

  reorderFolders(userId: string, orderedIds: string[]): void {
    if (orderedIds.length > 0) {
      const matched = jobFoldersRepo.countOwned(userId, orderedIds)
      if (matched !== orderedIds.length) {
        throw new JobError('not_found', 'One or more folders not found')
      }
    }
    jobFoldersRepo.reorder(userId, orderedIds)
    logger.info('folders reordered', { count: orderedIds.length })
    syncService.markDirty(userId)
  },

  /**
   * Re-position the jobs inside one target group (folder or root). The
   * caller submits the new full order of the destination group; we trust
   * the client to have a consistent view (the list is refetched after every
   * folder operation, so drift is short-lived).
   *
   * Validates folder ownership and job ownership before any write — single
   * COUNT query for the batch instead of N+1 reads.
   */
  reorderJobs(
    userId: string,
    targetFolderId: string | null,
    orderedJobIds: string[]
  ): void {
    if (targetFolderId !== null) {
      const folder = jobFoldersRepo.getById(userId, targetFolderId)
      if (!folder) throw new JobError('not_found', 'Folder not found')
    }
    if (orderedJobIds.length > 0) {
      const matched = jobsRepo.countOwned(userId, orderedJobIds)
      if (matched !== orderedJobIds.length) {
        throw new JobError('not_found', 'One or more jobs not found')
      }
    }
    jobsRepo.reorderInGroup(userId, targetFolderId, orderedJobIds)
    logger.info('jobs reordered', {
      targetFolderId,
      count: orderedJobIds.length
    })
    syncService.markDirty(userId)
  }
}

/**
 * Give a pre-step-11 remote run the task it never had, and return its id.
 *
 * These rows carry the remote's id in `cinnaTaskId` and nothing else — no task,
 * no binding, no way to reach an adapter. The task is created as a **replica**
 * (`origin: 'remote'`), because that is what it is: the work was created on the
 * service by a version of this app that did not model it here. The title and
 * goal are the job's, which is the best this side knows until the first pull
 * overwrites them with the service's own.
 *
 * Null when there is nothing to adopt — no remote id, or no adapter this
 * profile can use, which is the same "leave it alone" the old code reached by
 * returning the run unchanged.
 */
async function adoptRemoteRun(userId: string, run: JobRunRow): Promise<string | null> {
  if (!run.cinnaTaskId) return null
  const adapterId = await taskSyncService.preferredAdapterId(userId)
  if (!adapterId) return null
  // **Read the run again on this side of the await.** Asking the registry which
  // adapter is usable asks the adapter whether it is available, which is a
  // promise — so two refreshes of the same run can both have passed the
  // `run.taskId` check above before either of them writes one, and the second
  // would mint a duplicate task bound to the same remote id. Nothing in the app
  // presses this twice today; the caller before it disables its own button
  // while the mutation is in flight. It is one read, and "nothing does this
  // today" is how the two duplicated-row defects earlier in this phase started.
  const fresh = jobRunsRepo.getById(userId, run.id)
  if (fresh?.taskId) return fresh.taskId
  // **And the collision this run knows nothing about.** A pull can already have
  // made a replica for the same remote id — that is what a pull *does* — and
  // binding a second local task to it would leave two tasks pushing to one
  // remote task, each overwriting the other. The re-read above only stops this
  // run adopting itself twice. Latent while nothing schedules `pull`; it comes
  // alive on the same step that owes `pull` its in-flight dedupe.
  const already = taskRepo.getByRemote(userId, adapterId, run.cinnaTaskId)
  if (already) {
    jobRunsRepo.setTaskId(run.id, already.id)
    if (!already.jobRunId) taskService.linkJobRun(userId, already.id, run.id)
    logger.info('a remote job run joined the task a pull had already made for it', {
      runId: run.id,
      taskId: already.id
    })
    return already.id
  }
  const job = jobsRepo.getById(userId, run.jobId)
  const task = taskService.create(userId, {
    title: job?.title ?? 'Task',
    goal: job?.prompt ?? job?.title ?? 'Task',
    router: 'direct',
    origin: 'remote',
    executor: 'remote',
    priority: parseTaskPriority(job?.cinnaPriority ?? null),
    jobId: run.jobId,
    jobRunId: run.id
  })
  taskService.bindRemote(userId, task.id, {
    adapter: adapterId,
    id: run.cinnaTaskId,
    key: run.cinnaShortCode,
    url: null,
    state: {}
  })
  jobRunsRepo.setTaskId(run.id, task.id)
  logger.info('adopted a remote job run that predates its task', {
    runId: run.id,
    taskId: task.id,
    adapter: adapterId
  })
  return task.id
}
