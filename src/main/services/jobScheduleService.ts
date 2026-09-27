import { createHash } from 'node:crypto'
import { nanoid } from 'nanoid'
import { getDb } from '../db/client'
import { jobsRepo, jobAgentRepo, jobMcpRepo, type JobRow } from '../db/jobs'
import { localScheduleRepo, type ScheduleBindingRow, type ScheduleOccurrenceRow } from '../db/localSchedules'
import { agentRepo } from '../db/agents'
import { chatModeRepo } from '../db/chatModes'
import { mcpProviderRepo } from '../db/mcpProviders'
import { taskRuntimeRepo } from '../db/taskRuntimes'
import { scriptRuntimeRepo } from '../db/scriptRuntimes'
import { taskRepo } from '../db/tasks'
import { jobRuntimeDefinition } from '../tasks/jobRuntimeDefinition'
import { nextScheduleOccurrence, scheduleMinute, scheduleTimezone, parseScheduleCron } from '../tasks/scheduleCron'
import { normalizeScheduleEditorMetadata } from '../../shared/scheduleTemplates'
import { canScheduleJob, type LocalJobScheduleSnapshot, type JobScheduleSaveInput, type JobScheduleMutationInput, type JobScheduleEnableInput } from '../../shared/localJobSchedules'
import type { LocalJobScheduleDefinition, LocalScheduleHistoryInput, LocalScheduleStopInput } from '../../shared/localSchedules'
import { localScheduleService, occurrenceDto, overlap, reconcileOccurrence } from './localScheduleService'
import { prepareScheduledJob } from './jobExecution/scheduled'
import { runExecutionService, type RunScope } from './runExecutionService'
import { taskRuntimeService } from './taskRuntimeService'
import { taskService } from './taskService'

const message = (error: unknown) => error instanceof Error ? error.message : String(error)
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex')
type JobBinding = Omit<ScheduleBindingRow, 'definition'> & { definition: LocalJobScheduleDefinition }
const isJobBinding = (row: ScheduleBindingRow): row is JobBinding => row.definition.executionType === 'job'
const pending = new Set<string>()

/** Include attachments: changing tools/participants is an execution change too. */
export function jobScheduleRevision(job: JobRow): string {
  return hash([job.userId, job.id, job.type, job.title, job.prompt, job.router, job.script, job.budget, job.modeId,
    job.agentId, job.cinnaPriority, job.syncDeps, jobAgentRepo.listAgentIds(job.id).sort(), jobMcpRepo.listProviderIds(job.id).sort()])
}
function requireJob(scope: RunScope, id: string): JobRow {
  const job = typeof id === 'string' ? jobsRepo.getById(scope.profileUserId, id) : undefined
  if (!job || job.deletedAt) throw new Error('This Job is no longer available in the active profile.')
  if (!canScheduleJob(job.type)) throw new Error('Only local Jobs can run on this device’s scheduler.')
  jobRuntimeDefinition(job)
  if (!job.prompt.trim() || job.prompt.length > 64000) throw new Error('The Job needs instructions of 1–64000 characters before scheduling.')
  return job
}
function assertScope(scope: RunScope, input: { profileUserId: string }): void {
  if (!input || input.profileUserId !== scope.profileUserId) throw new Error('The active profile changed. Reopen this Job’s schedules.')
}
function requireBinding(scope: RunScope, id: string, jobId?: string, includeDeleted = false): JobBinding {
  const row = localScheduleRepo.get(scope.profileUserId, id)
  if (!row || !isJobBinding(row) || (!includeDeleted && row.definition.deletedAt) || (jobId !== undefined && row.jobId !== jobId)) throw new Error('This Job schedule is no longer available.')
  return row
}
function reviewedBinding(scope: RunScope, input: JobScheduleMutationInput): JobBinding {
  assertScope(scope, input)
  const row = requireBinding(scope, input.id, input.jobId)
  if (row.revision !== input.revision) throw new Error('This schedule changed a moment ago. Try again.')
  return row
}
function rows(scope: RunScope, jobId: string): JobBinding[] {
  return localScheduleRepo.list(scope.profileUserId).filter(isJobBinding).filter(row => row.jobId === jobId && !row.definition.deletedAt)
}
function jobProblem(scope: RunScope, binding: JobBinding): string | null {
  try {
    const job = requireJob(scope, binding.jobId)
    if (jobScheduleRevision(job) !== binding.definition.jobRevision) return 'The Job changed since this schedule was turned on. Turn it on again to use the Job as it is now.'
    return null
  } catch (error) { return message(error) }
}
function summary(scope: RunScope, job: JobRow): string {
  const agents = job.router === 'script' && job.script
    ? Object.entries(job.script.agents).map(([alias, descriptor]) => descriptor.name || alias)
    : jobAgentRepo.listAgentIds(job.id).map(id => (agentRepo.getOwned(scope.settingsUserId, id) ?? agentRepo.getOwned(scope.profileUserId, id))?.name ?? 'Unavailable agent')
  const tools = jobMcpRepo.listProviderIds(job.id).map(id => mcpProviderRepo.getOwned(scope.settingsUserId, id)?.name ?? 'Unavailable tool')
  const mode = job.modeId ? chatModeRepo.getOwned(scope.settingsUserId, job.modeId)?.name ?? 'Unavailable chat mode' : 'Default chat mode'
  const routing = job.router === 'script' ? 'Script Job' : job.router === 'coordinator' ? 'Coordinator Job' : 'Ordinary Job'
  const budget = job.router ? `${job.budget?.maxRounds ?? 20} turns / ${job.budget?.maxMinutes ?? 60} minutes` : 'Same routing and turn controls as Run'
  return `${routing} · Agents: ${agents.join(', ') || 'none'} · Tools: ${tools.join(', ') || 'none'} · ${mode} · ${budget}`
}

export const jobScheduleService = {
  list(scope: RunScope, jobId: string): LocalJobScheduleSnapshot {
    const job = requireJob(scope, jobId), jobRevision = jobScheduleRevision(job)
    return { profileUserId: scope.profileUserId, jobId, jobTitle: job.title, jobPrompt: job.prompt, jobSummary: summary(scope, job), jobScript: job.script, jobRevision,
      items: rows(scope, jobId).map(row => {
        const problem = jobProblem(scope, row)
        const last = localScheduleRepo.latest(scope.profileUserId, row.id)
        return { profileUserId: scope.profileUserId, name: row.name, cron: row.definition.cron, timezone: row.definition.timezone,
          prompt: job.prompt, revision: row.revision, problem, editorMetadata: normalizeScheduleEditorMetadata(row.editorMetadata, row.definition.cron),
          binding: { id: row.id, enabled: row.enabled && !problem, reason: problem ?? row.reason, jobId,
            nextDueAt: row.nextDueAt, last: last ? occurrenceDto(last) : null } }
      }) }
  },

  save(scope: RunScope, input: JobScheduleSaveInput, now = Date.now()): LocalJobScheduleSnapshot {
    assertScope(scope, input)
    const job = requireJob(scope, input.jobId), jobRevision = jobScheduleRevision(job)
    if (jobRevision !== input.jobRevision) throw new Error('The Job changed a moment ago. Try again.')
    if (typeof input.name !== 'string' || !input.name.trim() || input.name !== input.name.trim() || input.name.length > 255) throw new Error('Enter a schedule name of 1–255 characters without surrounding spaces.')
    if (typeof input.enabled !== 'boolean' || typeof input.cron !== 'string' || typeof input.timezone !== 'string') throw new Error('The schedule form is invalid.')
    const cron = input.cron.trim().replace(/\s+/g, ' '), timezone = scheduleTimezone(input.timezone)
    const nextDueAt = nextScheduleOccurrence(cron, timezone, now)
    const editorMetadata = normalizeScheduleEditorMetadata(input.editorMetadata, cron)
    if (input.editorMetadata && !editorMetadata) throw new Error('The selected days and hours do not match this schedule.')
    const prior = input.id ? reviewedBinding(scope, { ...input, id: input.id, revision: input.revision ?? null }) : undefined
    if (rows(scope, job.id).some(row => row.name === input.name && row.id !== prior?.id)) throw new Error('Schedule names must be unique within this Job.')
    const definition: LocalJobScheduleDefinition = { executionType: 'job', jobId: job.id, jobTitle: job.title, jobRevision, prompt: job.prompt, name: input.name, cron, timezone }
    getDb().transaction(() => {
      localScheduleRepo.save({ id: prior?.id ?? nanoid(), userId: scope.profileUserId, manifestId: `job:${job.id}`, name: input.name,
        definition, revision: nanoid(), jobId: job.id, jobFingerprint: jobRevision, jobIds: [job.id], enabled: input.enabled, reason: null,
        watermark: Math.max(prior?.watermark ?? -Infinity, Math.floor(now / 60000)), nextDueAt: input.enabled ? nextDueAt : null,
        enabledSince: input.enabled ? now : null, lastAttemptAt: prior?.lastAttemptAt ?? null, lastCompletedAt: prior?.lastCompletedAt ?? null,
        cursorVersion: (prior?.cursorVersion ?? 0) + 1, editorMetadata })
    })
    return this.list(scope, job.id)
  },

  enable(scope: RunScope, input: JobScheduleEnableInput, now = Date.now()): LocalJobScheduleSnapshot {
    const row = reviewedBinding(scope, input)
    return this.save(scope, { ...input, name: row.name, cron: row.definition.cron, timezone: row.definition.timezone, enabled: true, editorMetadata: row.editorMetadata }, now)
  },
  disable(scope: RunScope, input: JobScheduleMutationInput): void {
    const row = reviewedBinding(scope, input)
    localScheduleRepo.save({ ...row, enabled: false, reason: null, revision: nanoid(), cursorVersion: row.cursorVersion + 1 })
  },
  delete(scope: RunScope, input: JobScheduleMutationInput): void {
    const row = reviewedBinding(scope, input)
    localScheduleRepo.save({ ...row, name: `${row.name} [deleted ${row.id}]`, definition: { ...row.definition, deletedAt: Date.now() },
      enabled: false, reason: 'This schedule was deleted.', revision: nanoid(), cursorVersion: row.cursorVersion + 1 })
  },
  history(scope: RunScope, input: LocalScheduleHistoryInput) {
    assertScope(scope, input); requireBinding(scope, input.bindingId, undefined, true)
    return localScheduleService.history(scope, input)
  },
  stop(scope: RunScope, input: LocalScheduleStopInput): void {
    assertScope(scope, input); requireBinding(scope, input.bindingId, undefined, true)
    const receipt = localScheduleRepo.unfinished(scope.profileUserId, input.bindingId).find(row => row.id === input.occurrenceId)
    if (!receipt) return
    if (!receipt.taskId) {
      localScheduleRepo.updateOccurrence(scope.profileUserId, receipt.id, { status: 'cancelled', reason: 'Interrupted admission dismissed.', finishedAt: Date.now() })
    } else if (scriptRuntimeRepo.owner(scope.profileUserId, receipt.taskId) || taskRuntimeRepo.get(scope.profileUserId, receipt.taskId)) {
      taskRuntimeService.cancel(scope.profileUserId, receipt.taskId)
    } else if (receipt.chatId && runExecutionService.isRunning(receipt.chatId)) {
      runExecutionService.cancelChat(scope.profileUserId, receipt.chatId)
    } else if (taskRepo.getById(scope.profileUserId, receipt.taskId)) {
      taskService.setStatus(scope.profileUserId, receipt.taskId, 'cancelled')
    }
  },

  /** Shares the activated scheduler; async preflight is parallel, actual runs are detached. */
  async check(scope: RunScope, current: () => boolean, now: () => number = Date.now): Promise<void> {
    const due: Promise<void>[] = []
    for (const binding of localScheduleRepo.list(scope.profileUserId).filter(isJobBinding)) {
      if (!current()) return
      for (const row of localScheduleRepo.unfinished(scope.profileUserId, binding.id)) reconcileOccurrence(row)
      if (!binding.enabled || binding.definition.deletedAt) continue
      const problem = jobProblem(scope, binding)
      if (problem) { localScheduleRepo.save({ ...binding, enabled: false, reason: problem }); continue }
      const observedAt = now(), observed = Math.floor(observedAt / 60000)
      if (observed <= binding.watermark) continue
      if (binding.nextDueAt == null || binding.nextDueAt > observedAt) { localScheduleRepo.observe(scope.profileUserId, binding.id, observed); continue }
      if (pending.has(binding.id)) continue
      pending.add(binding.id)
      due.push(admit(scope, binding, current, now, observedAt).finally(() => pending.delete(binding.id)))
    }
    await Promise.all(due)
  }
}

async function admit(scope: RunScope, binding: JobBinding, current: () => boolean, now: () => number, observedAt: number): Promise<void> {
  const observed = Math.floor(observedAt / 60000)
  const valid = () => current() && Math.floor(now() / 60000) === observed
  const minute = scheduleMinute(parseScheduleCron(binding.definition.cron), binding.definition.timezone, binding.nextDueAt!)
  const nextDueAt = nextScheduleOccurrence(binding.definition.cron, binding.definition.timezone, observedAt, minute.civilKey)
  const receipt: ScheduleOccurrenceRow = { id: nanoid(), bindingId: binding.id, userId: scope.profileUserId,
    civilKey: minute.civilKey, utcMinute: minute.utcMinute, definition: binding.definition, revision: binding.revision,
    status: 'prepared', taskId: null, runId: null, chatId: null, reason: null, scheduledFor: binding.nextDueAt, observedAt,
    coveredThrough: observedAt, startedAt: null, finishedAt: null, triggerKind: minute.utcMinute < observed ? 'catch_up' : 'scheduled', resultKind: null, commandOutcome: null }
  let prepared: ReturnType<Awaited<ReturnType<typeof prepareScheduledJob>>> | undefined
  try {
    // Overlap is checked again transactionally after preflight. Skips do not need
    // model credentials or agent availability, and consume exactly one period.
    let factory: Awaited<ReturnType<typeof prepareScheduledJob>> | undefined
    if (!overlap(binding)) factory = await prepareScheduledJob(scope, requireJob(scope, binding.jobId), current)
    if (!valid()) return
    const live = requireBinding(scope, binding.id)
    if (!live.enabled || live.revision !== binding.revision || jobProblem(scope, live)) return
    getDb().transaction(() => {
      if (!valid() || !localScheduleRepo.claim(binding, nextDueAt, observedAt)) return
      if (localScheduleRepo.occurrence(scope.profileUserId, binding.id, minute.civilKey)) return
      const busy = overlap(binding)
      if (busy) {
        localScheduleRepo.insertOccurrence({ ...receipt, status: 'skipped_overlap', taskId: busy.taskId, reason: busy.reason, finishedAt: observedAt })
        return
      }
      if (!factory) throw new Error('The previous Job run changed during admission. This occurrence was not launched.')
      prepared = factory()
      localScheduleRepo.insertOccurrence({ ...receipt, taskId: prepared.taskId, runId: prepared.runId, chatId: prepared.chatId, resultKind: 'agent_started' })
    })
  } catch (error) {
    prepared = undefined
    if (!valid()) return
    const live = localScheduleRepo.get(scope.profileUserId, binding.id)
    if (!live || !isJobBinding(live) || live.revision !== binding.revision || !live.enabled) return
    const problem = jobProblem(scope, live)
    if (problem) { localScheduleRepo.save({ ...live, enabled: false, reason: problem }); return }
    getDb().transaction(() => {
      if (localScheduleRepo.claim(binding, nextDueAt, observedAt) && !localScheduleRepo.occurrence(scope.profileUserId, binding.id, minute.civilKey))
        localScheduleRepo.insertOccurrence({ ...receipt, status: 'failed', resultKind: 'execution_error', reason: message(error), finishedAt: now() })
    })
  }
  if (!prepared) return
  try {
    // The minute check guards the claim only; an admitted run launches even if
    // a minute boundary passed since.
    if (!current()) throw new Error('The active profile changed before launch. Review the interrupted task.')
    localScheduleRepo.updateOccurrence(scope.profileUserId, receipt.id, { status: 'dispatched', startedAt: now() })
    prepared.launch()
  } catch (error) {
    const reason = message(error)
    prepared.interrupt(reason)
    localScheduleRepo.updateOccurrence(scope.profileUserId, receipt.id, { status: 'interrupted', reason })
  }
}
