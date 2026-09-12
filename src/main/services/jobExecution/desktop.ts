import { getDb } from '../../db/client'
import { jobAgentRepo, jobMcpRepo, jobRunsRepo } from '../../db/jobs'
import { agentRepo } from '../../db/agents'
import { chatModeRepo } from '../../db/chatModes'
import { mcpProviderRepo } from '../../db/mcpProviders'
import { newChatRouter, routingOf } from '../../../shared/chatRouting'
import { parseTaskPriority } from '../../../shared/tasks'
import { JobError } from '../../errors'
import { createLogger } from '../../logger/logger'
import { jobRuntimeDefinition } from '../../tasks/jobRuntimeDefinition'
import { buildResolveIndex, profileServerUrl } from '../../sync/resolvers'
import { taskService } from '../taskService'
import { unresolvableAgentLabels } from './dependencies'
import type { JobExecutor } from './contract'
const logger = createLogger('job')

export const desktopJobExecutor: JobExecutor = {
  async execute(scope, job) {
    jobRuntimeDefinition(job)
    if (job.router === 'coordinator') {
      const { startCoordinatorJob } = await import('../coordinatorJobService')
      return { type: 'local', disposition: 'accepted', execution: 'main', ...await startCoordinatorJob(scope, job) }
    }
    if (job.router === 'script') {
      const { scriptRuntimeService } = await import('../scriptRuntimeService')
      return { type: 'local', disposition: 'accepted', execution: 'main', ...scriptRuntimeService.startJob(scope, job) }
    }
    return { type: 'local', disposition: 'renderer_turn', ...desktopJobExecutor.prepareRendererTurn!(scope, job) }
  },
  prepareRendererTurn(scope, job) {
    const userId = scope.profileUserId
    const jobId = job.id
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
      ? unresolvableAgentLabels(job.syncDeps, buildResolveIndex(userId, scope.settingsUserId), profileServerUrl(userId))
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
    const existingAgentIds = agentIds.filter((id) => [scope.settingsUserId, userId].some((owner) => !!agentRepo.getOwned(owner, id)))
    if (existingAgentIds.length !== agentIds.length) {
      throw new JobError('missing_dependency', 'Agent referenced by job no longer exists')
    }

    const mode = job.modeId
      ? chatModeRepo.getOwned(scope.settingsUserId, job.modeId)
      : null
    if (job.modeId && !mode) {
      throw new JobError('missing_dependency', 'Chat mode referenced by job no longer exists')
    }

    // Drop MCP ids that no longer exist (FK would crash the insert anyway).
    const rawMcpIds = jobMcpRepo.listProviderIds(jobId)
    let filteredMcpIds: string[] = []
    if (rawMcpIds.length > 0) {
      const validIds = new Set(
        mcpProviderRepo.list(scope.settingsUserId).map((p) => p.id)
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

    return getDb().transaction(() => {
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
      assigneeName: firstAnswerer ? ((agentRepo.getOwned(scope.settingsUserId, firstAnswerer) ?? agentRepo.getOwned(userId, firstAnswerer))?.name ?? null) : null,
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
    })
  }
}
