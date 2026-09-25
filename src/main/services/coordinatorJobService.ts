import { getDb, getRawSqlite } from '../db/client'
import { taskRuntimeRepo } from '../db/taskRuntimes'
import { chatRunResultRepo } from '../db/chatRunResults'
import { jobsRepo, jobAgentRepo, jobMcpRepo, jobRunsRepo, type JobRow } from '../db/jobs'
import { agentOverrideRepo } from '../db/agents'
import { mcpProviderRepo } from '../db/mcpProviders'
import { jobRuntimeDefinition } from '../tasks/jobRuntimeDefinition'
import { runtimeBudget } from '../tasks/runtimeBudget'
import { agentService } from './agentService'
import { taskService } from './taskService'
import { taskRunnerService } from './taskRunnerService'
import { resolveTaskModelConfig } from './taskModelConfig'
import type { RunScope } from './runExecutionService'
import { agentIdentityKey, agentRowToDescriptor, normalizeUrl } from '../sync/identity'
import { profileServerUrl } from '../sync/resolvers'

export interface PreparedCoordinatorJob {
  chatId: string
  taskId: string
  runId: string
  launch(): void
  interrupt(reason: string): void
}

/** Async configuration lookup precedes the caller's atomic admission transaction. */
export async function prepareCoordinatorJob(scope: RunScope, job: JobRow, current: () => boolean = () => true): Promise<() => PreparedCoordinatorJob> {
  const assertScope = () => { if (!current()) throw new Error('The active profile changed before this job started.') }
  assertScope()
  jobRuntimeDefinition(job)
  const budget = runtimeBudget(job.budget)
  if (budget.maxTokens !== undefined) throw new Error('Token limits require usage reporting from every participant. Use a time and round limit.')
  if (!job.prompt.trim() || job.prompt.length > 64000) throw new Error('The task goal must contain 1–64000 characters.')
  const snapshot = () => {
    const current = jobsRepo.getById(scope.profileUserId, job.id)
    if (!current || current.deletedAt || current.router !== 'coordinator') throw new Error('This coordinator job is no longer available.')
    const agentIds = jobAgentRepo.listAgentIds(job.id)
    const agents = agentIds.map((agentId) => {
      const located = agentService.findAgent(scope.settingsUserId, scope.profileUserId, agentId)
      if (!located || !(agentOverrideRepo.get(scope.profileUserId, agentId)?.enabled ?? located.row.enabled)) throw new Error('A coordinator job agent is missing or disabled.')
      return located.row
    })
    // A missing portable agent must not disappear through an empty join list.
    const serverUrl = profileServerUrl(scope.profileUserId)
    const actual = agents.flatMap((row) => {
      const ref = agentRowToDescriptor(row, serverUrl)
      return ref ? [ref] : []
    })
    for (const required of current.syncDeps?.deps ?? []) {
      if (required.kind !== 'agent') continue
      const found = actual.some((ref) => agentIdentityKey(ref) === agentIdentityKey(required) &&
        (!('serverUrl' in required) || !!serverUrl && normalizeUrl(required.serverUrl ?? '') === normalizeUrl(serverUrl)))
      if (!found) throw new Error(`This coordinator job needs an unavailable agent: ${required.name ?? 'Agent'}.`)
    }
    const mcpIds = jobMcpRepo.listProviderIds(job.id)
    if (mcpIds.some((id) => !mcpProviderRepo.getOwned(scope.settingsUserId, id))) throw new Error('A coordinator job tool is no longer available.')
    return { current, agentIds, mcpIds }
  }
  const before = snapshot()
  const fields = (value: JobRow) => JSON.stringify([value.userId, value.type, value.title, value.prompt, value.router, value.script, value.budget, value.modeId])
  if (fields(before.current) !== fields(job)) throw new Error('The job changed before this attempt started.')
  const fingerprint = JSON.stringify(before)
  const model = await resolveTaskModelConfig(scope, job.modeId ?? undefined)
  assertScope()
  model.assertCurrent()
  const fresh = snapshot()
  if (JSON.stringify(fresh) !== fingerprint) throw new Error('The job changed while its model was being prepared. Try again.')
  return () => {
    assertScope()
    model.assertCurrent()
    if (JSON.stringify(snapshot()) !== fingerprint) throw new Error('The job changed before this attempt was admitted.')
    const prepared = getDb().transaction(() => {
    const { chatId, runId } = jobRunsRepo.createLocalChatAndRun({ userId: scope.profileUserId, jobId: job.id,
      title: fresh.current.title, prompt: fresh.current.prompt, router: 'coordinator', rootAgentId: null,
      providerId: model.providerId, modelId: model.modelId, modeId: model.modeId,
      onDemandAgentIds: fresh.agentIds, onDemandMcpIds: [...new Set([...fresh.mcpIds, ...model.mcpIds])] })
    const task = taskService.create(scope.profileUserId, { title: fresh.current.title, goal: fresh.current.prompt,
      router: 'coordinator', budget, chatId, jobId: job.id, jobRunId: runId })
    jobRunsRepo.setTaskId(runId, task.id)
    const accepted = taskRunnerService.prepare(scope, { chatId, goal: fresh.current.prompt, budget })
    return { ...accepted, runId }
    })
    let launched = false
    return { chatId: prepared.chatId, taskId: prepared.taskId, runId: prepared.runId,
      launch() {
        assertScope()
        if (getRawSqlite().inTransaction) throw new Error('Commit the job admission before launching it.')
        if (launched) throw new Error('This prepared job was already launched.')
        const checkpoint = taskRuntimeRepo.get(scope.profileUserId, prepared.taskId)
        if (!checkpoint || checkpoint.state !== 'queued') throw new Error('This prepared job is no longer queued.')
        prepared.launch()
        launched = true
      },
      interrupt(reason) {
        const checkpoint = taskRuntimeRepo.get(scope.profileUserId, prepared.taskId)
        if (!checkpoint || checkpoint.state !== 'queued' || launched) throw new Error('This prepared job is no longer awaiting launch.')
        getDb().transaction(() => {
          taskRuntimeRepo.save(scope.profileUserId, prepared.taskId, { ...checkpoint, state: 'interrupted', reason, activeStartedAt: null })
          taskService.applyRunState(scope.profileUserId, prepared.taskId, 'needs_input')
          chatRunResultRepo.record(prepared.chatId, checkpoint.attemptId, 'needs_input')
        })
      }
    }
  }
}

/** Manual runs retain the same preparation and launch path as scheduled runs. */
export async function startCoordinatorJob(scope: RunScope, job: JobRow): Promise<{ chatId: string; taskId: string; runId: string }> {
  const prepare = await prepareCoordinatorJob(scope, job)
  const prepared = prepare()
  prepared.launch()
  return { chatId: prepared.chatId, taskId: prepared.taskId, runId: prepared.runId }
}
