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
import { getSettingsScopeUserId, getAgentLookupScope } from '../auth/scope'
import { JobError } from '../errors'
import { derivePattern } from '../../shared/commPattern'
import { cinnaApiService } from './cinnaApiService'
import { createLogger } from '../logger/logger'

const logger = createLogger('job')

export interface JobDetail extends JobRow {
  agentIds: string[]
  mcpProviderIds: string[]
  recentRuns: JobRunRowWithMeta[]
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
}

export const jobService = {
  list(userId: string): JobListItem[] {
    const rows = jobsRepo.list(userId)
    const counts = jobRunsRepo.countInProgressByJob(userId)
    return rows.map((j) => ({ ...j, inProgressRunsCount: counts.get(j.id) ?? 0 }))
  },

  getDetail(userId: string, jobId: string): JobDetail {
    const job = requireJob(userId, jobId)
    const agentIds = jobAgentRepo.listAgentIds(jobId)
    const mcpProviderIds = jobMcpRepo.listProviderIds(jobId)
    const recentRuns = jobRunsRepo
      .listByJob(userId, jobId)
      .slice(0, RECENT_RUNS_LIMIT)
    return { ...job, agentIds, mcpProviderIds, recentRuns }
  },

  create(userId: string, input: JobCreateInput): JobRow {
    validateCreate(input)
    const job = jobsRepo.create(userId, input)
    logger.info('job created', { jobId: job.id, type: job.type })
    return job
  },

  update(userId: string, jobId: string, patch: JobPatch): JobRow {
    requireJob(userId, jobId)
    if (patch.type && patch.type !== 'local' && patch.type !== 'cinna_task') {
      throw new JobError('invalid_input', `Unknown job type: ${patch.type}`)
    }
    if (patch.title !== undefined && !patch.title.trim()) {
      throw new JobError('invalid_input', 'Title is required')
    }
    if (patch.prompt !== undefined && !patch.prompt.trim()) {
      throw new JobError('invalid_input', 'Prompt is required')
    }
    const ok = jobsRepo.update(userId, jobId, patch)
    if (!ok) throw new JobError('not_found', 'Job not found')
    const updated = jobsRepo.getById(userId, jobId)
    if (!updated) throw new JobError('not_found', 'Job not found after update')
    return updated
  },

  softDelete(userId: string, jobId: string): void {
    const ok = jobsRepo.softDelete(userId, jobId)
    if (!ok) throw new JobError('not_found', 'Job not found')
    logger.info('job deleted', { jobId })
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
  },

  listRuns(userId: string, jobId: string): JobRunRowWithMeta[] {
    requireJob(userId, jobId)
    return jobRunsRepo.listByJob(userId, jobId)
  },

  /**
   * Single entry point for running a job. Branches on `job.type` so the IPC
   * handler stays a one-liner and the two execution paths share ownership +
   * validation logic. The return is a discriminated union so the renderer
   * can react to `local` (navigate to spawned chat + kick off stream) vs.
   * `cinna_task` (stay on the job, start polling).
   */
  async execute(
    userId: string,
    jobId: string
  ): Promise<
    | {
        type: 'local'
        chatId: string
        runId: string
        prompt: string
        agentId: string | null
        modeId: string | null
      }
    | {
        type: 'cinna_task'
        runId: string
        cinnaTaskId: string
        cinnaShortCode: string | null
      }
  > {
    const job = requireJob(userId, jobId)
    if (job.type === 'cinna_task') {
      const res = await this.executeCinnaTask(userId, jobId)
      return { type: 'cinna_task', ...res }
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
   * The same `derivePattern` decision the new-chat composer uses routes the
   * run: exactly one agent and no MCPs → direct A2A (the agent is bound as the
   * chat root, returned as `agentId` so the renderer calls `startAgent`).
   * Anything else → an LLM-root chat (agents/MCPs attached on-demand,
   * `orchestrated` set when agents are present, `agentId` null so the renderer
   * calls `startLlm`). The return contract is unchanged: a non-null `agentId`
   * means A2A, null means orchestrated/plain-LLM.
   */
  executeLocal(
    userId: string,
    jobId: string
  ): {
    chatId: string
    runId: string
    prompt: string
    agentId: string | null
    modeId: string | null
  } {
    const job = requireJob(userId, jobId)
    if (job.type !== 'local') {
      throw new JobError('unsupported_type', 'executeLocal called on non-local job')
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

    const isA2A = derivePattern(existingAgentIds, filteredMcpIds) === 'A2A'

    const { chatId, runId } = jobRunsRepo.createLocalChatAndRun({
      userId,
      jobId,
      title: job.title,
      prompt: job.prompt,
      rootAgentId: isA2A ? existingAgentIds[0] : null,
      orchestrated: !isA2A && existingAgentIds.length > 0,
      modeId: job.modeId,
      providerId: mode?.providerId ?? null,
      modelId: mode?.modelId ?? null,
      onDemandAgentIds: isA2A ? [] : existingAgentIds,
      onDemandMcpIds: isA2A ? [] : filteredMcpIds
    })

    logger.info('job executed (local)', {
      jobId,
      chatId,
      runId,
      pattern: isA2A ? 'A2A' : 'AI',
      agents: existingAgentIds.length,
      mcps: filteredMcpIds.length
    })

    return {
      chatId,
      runId,
      prompt: job.prompt,
      agentId: isA2A ? existingAgentIds[0] : null,
      modeId: job.modeId
    }
  },

  /**
   * Stream-completion hook — called by chatStreamingService /
   * a2aStreamingService when the chat finishes (or errors). No-op if the
   * chat isn't linked to a job run or the run is already terminal.
   */
  reportRunCompletion(chatId: string, outcome: 'succeeded' | 'failed', errorMessage?: string): void {
    const run = jobRunsRepo.getByLocalChatId(chatId)
    if (!run) return
    if (run.status !== 'running' && run.status !== 'pending') return
    jobRunsRepo.updateStatus(run.id, outcome, { errorMessage: errorMessage ?? null })
    logger.info('job run finalized via chat stream', {
      runId: run.id,
      chatId,
      status: outcome
    })
  },

  /**
   * Spawn a cinna-core task for a `cinna_task` job. No local chat is created
   * — the conversation lives on cinna-core; the desktop polls for status.
   */
  async executeCinnaTask(
    userId: string,
    jobId: string
  ): Promise<{ runId: string; cinnaTaskId: string; cinnaShortCode: string | null }> {
    const job = requireJob(userId, jobId)
    if (job.type !== 'cinna_task') {
      throw new JobError('unsupported_type', 'executeCinnaTask called on non-cinna job')
    }
    if (!job.cinnaAgentId) {
      throw new JobError('missing_dependency', 'Cinna agent is required to run this job')
    }

    const task = await cinnaApiService.createTask(userId, {
      original_message: job.prompt,
      title: job.title,
      selected_agent_id: job.cinnaAgentId,
      priority: job.cinnaPriority ?? 'normal',
      auto_execute: true
    })

    const run = jobRunsRepo.create({
      jobId,
      userId,
      type: 'cinna_task',
      cinnaTaskId: task.id,
      cinnaShortCode: task.short_code,
      status: mapCinnaStatus(task.status)
    })

    logger.info('job executed (cinna_task)', {
      jobId,
      runId: run.id,
      cinnaTaskId: task.id,
      shortCode: task.short_code
    })

    return { runId: run.id, cinnaTaskId: task.id, cinnaShortCode: task.short_code }
  },

  /**
   * Poll cinna-core for the current state of a cinna_task run and persist
   * any status change. No-op for non-cinna runs. Skips the network call for
   * already-terminal runs unless `force` is true (manual user refresh).
   */
  async refreshCinnaRun(
    userId: string,
    runId: string,
    options: { force?: boolean } = {}
  ): Promise<JobRunRowWithMeta> {
    const run = jobRunsRepo.getById(userId, runId)
    if (!run) throw new JobError('not_found', 'Job run not found')
    if (run.type !== 'cinna_task') return enrichRun(userId, run)
    if (!run.cinnaTaskId) return enrichRun(userId, run)
    const isTerminal =
      run.status === 'succeeded' || run.status === 'failed' || run.status === 'cancelled'
    if (isTerminal && !options.force) {
      return enrichRun(userId, run)
    }

    logger.info('refreshing cinna run', {
      runId,
      cinnaTaskId: run.cinnaTaskId,
      prevStatus: run.status,
      force: options.force ?? false
    })
    const detail = await cinnaApiService.getTaskDetail(userId, run.cinnaTaskId)
    const mapped = mapCinnaStatus(detail.status)
    if (mapped !== run.status) {
      jobRunsRepo.updateStatus(runId, mapped)
    }
    logger.info('cinna run refreshed', {
      runId,
      remoteStatus: detail.status,
      newStatus: mapped
    })
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
    return updated
  },

  deleteFolder(userId: string, folderId: string): void {
    const existing = jobFoldersRepo.getById(userId, folderId)
    if (!existing) throw new JobError('not_found', 'Folder not found')
    jobFoldersRepo.delete(userId, folderId)
    logger.info('job folder deleted', { folderId })
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
  }
}

/**
 * Translate a cinna-core task status into our local run status.
 * Terminal cinna states map to the matching local terminal; any in-flight
 * state collapses to `running`. Keep this aligned with the cinna-core
 * `task.status` vocabulary (new, refining, open, in_progress, blocked,
 * completed, error, cancelled, archived).
 */
function mapCinnaStatus(status: string): JobRunStatus {
  switch (status) {
    case 'completed':
    case 'archived':
      return 'succeeded'
    case 'error':
      return 'failed'
    case 'cancelled':
      return 'cancelled'
    case 'pending':
    case 'new':
      return 'pending'
    default:
      return 'running'
  }
}
