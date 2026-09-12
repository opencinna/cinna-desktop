import { createHash } from 'node:crypto'
import { nanoid } from 'nanoid'
import { getDb } from '../db/client'
import { localScheduleRepo, type ScheduleBindingRow, type ScheduleOccurrenceRow } from '../db/localSchedules'
import { jobsRepo, jobRunsRepo, type JobRow } from '../db/jobs'
import { taskRepo } from '../db/tasks'
import { scriptRuntimeRepo } from '../db/scriptRuntimes'
import { agentOverrideRepo } from '../db/agents'
import { localAgentService } from './localAgents/localAgentService'
import { scriptRuntimeService } from './scriptRuntimeService'
import { taskRunnersByChat } from './taskRunnerState'
import { parseScheduleCron, scheduleMinute, scheduleTimezone } from '../tasks/scheduleCron'
import type { RunScope } from './runExecutionService'
import type { LocalAgentDto } from '../../shared/localAgents'
import type { LocalScheduleDefinition, LocalScheduleItem, LocalScheduleOccurrence, LocalScheduleReview } from '../../shared/localSchedules'
import type { TaskScript } from '../../shared/taskScript'

const message = (error: unknown) => error instanceof Error ? error.message : String(error)
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const finished = new Set(['completed', 'failed', 'cancelled', 'skipped_overlap'])
const terminalTasks = new Set(['completed', 'error', 'cancelled', 'archived'])
const jobFingerprint = (job: JobRow) => hash([job.userId, job.type, job.title, job.prompt, job.router, job.script, job.budget])
const revisionOf = (definition: LocalScheduleDefinition) => hash(definition)

function definitionFor(scope: RunScope, agent: LocalAgentDto, raw: unknown, fallbackZone?: string): LocalScheduleDefinition {
  if (agent.kind !== 'kit' || typeof agent.manifest.id !== 'string' || agent.id !== `folder:${agent.manifest.id}`) throw new Error('Local schedules require a kit agent with a stable manifest identity.')
  if (!(agentOverrideRepo.get(scope.profileUserId, agent.id)?.enabled ?? agent.enabled)) throw new Error('Enable this agent before reviewing its schedules.')
  if (agent.readiness !== 'ok') throw new Error(agent.readinessReason ?? 'Finish this agent’s setup before enabling schedules.')
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('This schedule definition is invalid.')
  const value = raw as Record<string, unknown>
  if (typeof value.name !== 'string' || !value.name.trim() || value.name !== value.name.trim() || value.name.length > 255) throw new Error('Use a unique schedule name of 1–255 characters without surrounding spaces.')
  if (value.enabled !== undefined && typeof value.enabled !== 'boolean') throw new Error('The manifest schedule enabled field must be a boolean.')
  if (value.enabled === false) throw new Error('This schedule is disabled in the manifest.')
  if (value.schedule_type !== 'static_prompt') throw new Error('Only static-prompt schedules run locally. Command schedules are unsupported.')
  if (typeof value.prompt !== 'string' || !value.prompt.trim() || value.prompt.length > 64000) throw new Error('The schedule prompt must contain 1–64000 characters.')
  if (typeof value.cron_string !== 'string') throw new Error('Use a five-field numeric cron schedule.')
  parseScheduleCron(value.cron_string)
  if (value.timezone !== undefined && value.timezone !== null && typeof value.timezone !== 'string') throw new Error('Choose a valid IANA timezone.')
  const timezone = scheduleTimezone((value.timezone as string | null | undefined) ?? fallbackZone)
  return { manifestId: agent.manifest.id, agentId: agent.id, agentName: agent.name, name: value.name,
    cron: value.cron_string.trim().replace(/\s+/g, ' '), timezone, prompt: value.prompt }
}

function scriptFor(definition: LocalScheduleDefinition): TaskScript {
  return { version: 1, agents: { worker: { kind: 'agent', source: 'folder', manifestId: definition.manifestId, name: definition.agentName } },
    steps: [{ id: 'run', agent: 'worker', prompt: '{{goal}}' }] }
}

/** Reconcile receipts from durable runtime/job state, independent of renderer watching. */
function reconcileOccurrence(row: ScheduleOccurrenceRow): ScheduleOccurrenceRow {
  if (finished.has(row.status) || !row.taskId) return row
  const run = row.runId ? jobRunsRepo.getById(row.userId, row.runId) : undefined
  const task = taskRepo.getById(row.userId, row.taskId)
  const runtime = scriptRuntimeRepo.get(row.userId, row.taskId)
  const held = row.chatId && taskRunnersByChat.has(row.chatId)
  let status = row.status, reason = row.reason
  if (!held && run && ['succeeded', 'failed', 'cancelled'].includes(run.status)) {
    status = run.status === 'succeeded' ? 'completed' : run.status as 'failed' | 'cancelled'
    reason = run.errorMessage
  } else if (!held && task && terminalTasks.has(task.status)) {
    status = task.status === 'completed' ? 'completed' : task.status === 'error' ? 'failed' : 'cancelled'
    reason = task.errorMessage
  } else if (!task || task.deletedAt) {
    status = 'interrupted'; reason = 'The previous task is unavailable. Its execution cannot be confirmed.'
  } else if (runtime?.state === 'interrupted') {
    status = 'interrupted'; reason = runtime.reason
  } else if (runtime && runtime.state !== 'completed') {
    status = row.status === 'prepared' && runtime.state === 'queued' ? 'prepared' : 'dispatched'; reason = runtime.reason
  }
  if (row.status !== status || row.reason !== reason) localScheduleRepo.updateOccurrence(row.userId, row.id, { status, reason })
  return { ...row, status, reason }
}

function occurrenceDto(row: ScheduleOccurrenceRow): LocalScheduleOccurrence {
  const value = reconcileOccurrence(row)
  return { id: value.id, utcMinute: value.utcMinute, civilKey: value.civilKey, status: value.status,
    taskId: value.taskId, runId: value.runId, chatId: value.chatId, reason: value.reason }
}

function rowsFor(scope: RunScope, agentId: string): LocalScheduleItem[] {
  const bindings = localScheduleRepo.list(scope.profileUserId).filter((binding) => binding.definition.agentId === agentId)
  let agent: LocalAgentDto | undefined, failure: string | null = null
  try { agent = localAgentService.get(scope.settingsUserId, agentId) } catch (error) { failure = message(error) }
  const schedules: unknown[] = Array.isArray(agent?.manifest.schedules) ? agent.manifest.schedules : []
  if (agent?.manifest.schedules !== undefined && !Array.isArray(agent.manifest.schedules)) failure = 'The manifest schedules field must be an array.'
  const nameOf = (raw: unknown) => raw && typeof raw === 'object' && 'name' in raw && typeof raw.name === 'string' ? raw.name : ''
  const names = schedules.map(nameOf)
  const entries = [...schedules, ...bindings.filter((binding) => !names.includes(binding.name)).map((binding) => ({ name: binding.name }))]
  return entries.map((raw, index) => {
    const name = nameOf(raw)
    const binding = bindings.find((item) => item.name === name)
    let definition: LocalScheduleDefinition | undefined, problem: string | null = failure
    try {
      if (problem) throw new Error(problem)
      if (index >= schedules.length) throw new Error('This schedule was removed from the manifest.')
      if (names.filter((item) => item === name).length !== 1) throw new Error('Schedule names must be unique in this manifest.')
      definition = definitionFor(scope, agent!, raw, binding?.definition.timezone)
    } catch (error) { problem = message(error) }
    const revision = definition ? revisionOf(definition) : null
    let reason = binding?.reason ?? null
    if (binding?.enabled) {
      const job = jobsRepo.getById(scope.profileUserId, binding.jobId)
      reason = problem ?? (revision !== binding.revision ? 'The schedule changed. Review it before enabling again.' :
        !job || job.deletedAt || jobFingerprint(job) !== binding.jobFingerprint ? 'The scheduled job changed or was deleted. Review the schedule again.' : null)
      if (reason) localScheduleRepo.save({ ...binding, enabled: false, reason })
    }
    const value = raw && typeof raw === 'object' ? raw as Record<string, unknown> : {}
    const last = binding ? localScheduleRepo.latest(scope.profileUserId, binding.id) : undefined
    return { profileUserId: scope.profileUserId, name: name || `Invalid schedule ${index + 1}`, cron: definition?.cron ?? (typeof value.cron_string === 'string' ? value.cron_string : binding?.definition.cron ?? ''),
      timezone: definition?.timezone ?? binding?.definition.timezone ?? '', prompt: definition?.prompt ?? (typeof value.prompt === 'string' ? value.prompt : binding?.definition.prompt ?? ''),
      revision, problem, binding: binding ? { id: binding.id, enabled: binding.enabled && !reason, reason, jobId: binding.jobId,
        last: last ? occurrenceDto(last) : null } : null }
  })
}

function overlap(binding: ScheduleBindingRow): { taskId: string | null; reason: string } | null {
  const prior = localScheduleRepo.unfinished(binding.userId, binding.id).map(reconcileOccurrence).find((row) => !finished.has(row.status))
  if (prior) return { taskId: prior.taskId, reason: 'Skipped because a previous scheduled task is unfinished or needs review.' }
  // The generated Job is also visible in Jobs. A manual run must count too,
  // including historical generated jobs retained after a definition review.
  const manual = localScheduleRepo.unfinishedRuns(binding.userId, binding.jobIds)[0]
  if (manual) return { taskId: manual.taskId, reason: 'Skipped because a previous run of this scheduled job is unfinished.' }
  for (const reservation of taskRunnersByChat.values()) {
    if (reservation.userId !== binding.userId) continue
    const task = taskRepo.getById(binding.userId, reservation.controllerTaskId ?? reservation.taskId)
    if (task?.jobId && binding.jobIds.includes(task.jobId)) return { taskId: task.id, reason: 'Skipped because a previous run is still stopping.' }
  }
  return null
}

export const localScheduleService = {
  list(scope: RunScope, agentId: string): LocalScheduleItem[] { return rowsFor(scope, agentId) },

  enable(scope: RunScope, review: LocalScheduleReview, now = Date.now()): LocalScheduleItem[] {
    if (!review || typeof review.agentId !== 'string' || typeof review.name !== 'string' || typeof review.revision !== 'string' || typeof review.timezone !== 'string') throw new Error('Review this schedule before enabling it.')
    if (review.profileUserId !== scope.profileUserId) throw new Error('The active profile changed. Review this schedule again.')
    const rows = rowsFor(scope, review.agentId)
    const row = rows.find((item) => item.name === review.name)
    if (!row || row.problem || !row.revision) throw new Error(row?.problem ?? 'The schedule is no longer available.')
    // Missing timezone is frozen to the exact zone shown in this review,
    // including when the OS timezone changes while the dialog is open.
    const agent = localAgentService.get(scope.settingsUserId, review.agentId)
    const candidates = Array.isArray(agent.manifest.schedules) ? agent.manifest.schedules.filter((item) =>
      item && typeof item === 'object' && item.name === review.name) : []
    if (candidates.length !== 1) throw new Error('The schedule was removed or its name is no longer unique. Refresh and review again.')
    const raw = candidates[0]
    const definition = definitionFor(scope, agent, raw, review.timezone)
    if (revisionOf(definition) !== review.revision || definition.timezone !== review.timezone) throw new Error('The schedule changed while you were reviewing it. Refresh and review again.')
    const prior = localScheduleRepo.list(scope.profileUserId).find((item) => item.manifestId === definition.manifestId && item.name === definition.name)
    getDb().transaction(() => {
      let job = prior ? jobsRepo.getById(scope.profileUserId, prior.jobId) : undefined
      if (!job || job.deletedAt || !prior || jobFingerprint(job) !== prior.jobFingerprint || prior.revision !== review.revision) {
        job = jobsRepo.create(scope.profileUserId, { type: 'local', title: `${definition.agentName} · ${definition.name}`, prompt: definition.prompt,
          router: 'script', script: scriptFor(definition), budget: { maxRounds: 20, maxMinutes: 60 } })
      }
      localScheduleRepo.save({ id: prior?.id ?? nanoid(), userId: scope.profileUserId, manifestId: definition.manifestId, name: definition.name,
        definition, revision: review.revision, jobId: job.id, jobFingerprint: jobFingerprint(job), jobIds: [...new Set([...(prior?.jobIds ?? []), job.id])],
        enabled: true, reason: null, watermark: Math.max(prior?.watermark ?? -Infinity, Math.floor(now / 60000)) })
    })
    return rowsFor(scope, review.agentId)
  },

  disable(scope: RunScope, id: string): void {
    const row = localScheduleRepo.get(scope.profileUserId, id)
    if (!row) throw new Error('This schedule belongs to another profile or no longer exists.')
    localScheduleRepo.save({ ...row, enabled: false, reason: null })
  },

  /** Called only by the activated scheduler. All admission after its await is synchronous. */
  check(scope: RunScope, current: () => boolean, now: () => number = Date.now): void {
    const observed = Math.floor(now() / 60000)
    const valid = () => current() && Math.floor(now() / 60000) === observed
    const agentIds = [...new Set(localScheduleRepo.list(scope.profileUserId).filter((binding) => binding.enabled).map((binding) => binding.definition.agentId))]
    for (const agentId of agentIds) {
      if (!valid()) return
      rowsFor(scope, agentId)
      for (const binding of localScheduleRepo.list(scope.profileUserId).filter((item) => item.enabled && item.definition.agentId === agentId)) {
        if (!valid()) return
        if (observed <= binding.watermark) continue
        const minute = scheduleMinute(parseScheduleCron(binding.definition.cron), binding.definition.timezone, observed * 60000)
        let prepared: ReturnType<typeof scriptRuntimeService.prepareJob> | undefined
        const receipt: ScheduleOccurrenceRow = { id: nanoid(), bindingId: binding.id, userId: scope.profileUserId,
          civilKey: minute.civilKey, utcMinute: observed, definition: binding.definition, revision: binding.revision,
          status: 'prepared', taskId: null, runId: null, chatId: null, reason: null }
        try {
          getDb().transaction(() => {
            if (!valid()) return
            localScheduleRepo.save({ ...binding, watermark: observed })
            if (!minute.matches || localScheduleRepo.occurrence(scope.profileUserId, binding.id, minute.civilKey)) return
            const busy = overlap(binding)
            if (busy) {
              localScheduleRepo.insertOccurrence({ ...receipt, status: 'skipped_overlap', taskId: busy.taskId, reason: busy.reason })
              return
            }
            const job = jobsRepo.getById(scope.profileUserId, binding.jobId)
            if (!job || job.deletedAt || jobFingerprint(job) !== binding.jobFingerprint) throw new Error('The scheduled job changed before admission.')
            prepared = scriptRuntimeService.prepareJob(scope, job)
            localScheduleRepo.insertOccurrence({ ...receipt, taskId: prepared.taskId, runId: prepared.runId, chatId: prepared.chatId })
          })
        } catch (error) {
          // Preparation rolled back its tasks AND claim. Preserve one failed
          // observation separately so focus cannot retry an uncertain minute.
          prepared = undefined
          if (valid()) getDb().transaction(() => {
            localScheduleRepo.save({ ...binding, watermark: observed })
            if (!localScheduleRepo.occurrence(scope.profileUserId, binding.id, minute.civilKey)) localScheduleRepo.insertOccurrence({ ...receipt, status: 'failed', reason: message(error) })
          })
        }
        if (!prepared) continue
        try {
          if (!valid()) throw new Error('The active profile or schedule minute changed before launch. Review the interrupted task.')
          // Durable dispatch intent precedes the first external side effect.
          localScheduleRepo.updateOccurrence(scope.profileUserId, receipt.id, { status: 'dispatched' })
          prepared.launch()
        } catch (error) {
          const reason = message(error)
          scriptRuntimeService.interruptPrepared(scope.profileUserId, prepared.taskId, reason)
          localScheduleRepo.updateOccurrence(scope.profileUserId, receipt.id, { status: 'interrupted', reason })
        }
      }
    }
  }
}
