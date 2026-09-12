import { nanoid } from 'nanoid'
import { getDb, getRawSqlite } from '../db/client'
import { taskRepo } from '../db/tasks'
import { chatRepo } from '../db/chats'
import { jobsRepo, jobRunsRepo, type JobRow } from '../db/jobs'
import { messageRepo } from '../db/messages'
import { taskInputRequestRepo } from '../db/taskInputRequests'
import { scriptRuntimeRepo } from '../db/scriptRuntimes'
import { taskService } from './taskService'
import { inboxService } from './inboxService'
import { taskRunnersByChat } from './taskRunnerState'
import { installTaskRunnerHooks } from './taskRunnerBridge'
import { runExecutionService, type RunHandle, type RunScope } from './runExecutionService'
import { taskSlots, withRuntimeAgent } from '../tasks/runtimeAdmission'
import { runtimeBudget } from '../tasks/runtimeBudget'
import { jobRuntimeDefinition } from '../tasks/jobRuntimeDefinition'
import { compactScriptOutput, expandScriptTemplate, readyScriptSteps, validateTaskScript } from '../tasks/scriptRouter'
import { assertScriptTargets, resolveScriptTargets } from '../sync/scriptAgents'
import type { ScriptRuntimeCheckpoint, ScriptStepCheckpoint } from '../tasks/scriptRuntimeTypes'
import type { ScriptStep } from '../../shared/taskScript'
import type { RequestResolution } from '../../shared/localAgentRequests'
import type { InboxAnswerResult } from '../../shared/inbox'
import { createLogger } from '../logger/logger'

const logger = createLogger('script-runtime')
const keyOf = (userId: string, taskId: string): string => JSON.stringify([userId, taskId])
const terminalSteps = new Set(['completed', 'failed', 'canceled'])
interface Execution {
  snapshot: ScriptRuntimeCheckpoint
  controller: AbortController
  handles: Map<string, RunHandle>
  steps: Map<string, Promise<void>>
  interruptedReason?: string
  failure?: string
  timedOut: boolean
  promise?: Promise<void>
  wake?: () => void
}
const executing = new Map<string, Execution>()
// Keep the last reserved checkpoint through a root's FK cascade notification.
const retained = new Map<string, ScriptRuntimeCheckpoint>()
const mutating = new Set<string>()

function checkpoint(userId: string, taskId: string): ScriptRuntimeCheckpoint {
  const value = scriptRuntimeRepo.get(userId, taskId)
  if (!value) throw new Error('This task has no local script checkpoint.')
  return value
}
function owned(userId: string, taskId: string, requireChat = true) {
  const task = taskService.getById(userId, taskId)
  if (task.executor !== 'desktop' || !task.runsHere || !['in_progress', 'blocked'].includes(task.status)) throw new Error('This device no longer owns a runnable script task.')
  if (requireChat && (!task.chatId || !chatRepo.getOwned(userId, task.chatId) || chatRepo.getOwned(userId, task.chatId)?.deletedAt)) throw new Error('The script conversation was deleted.')
  return task
}
function releaseReservations(userId: string, taskId: string): void {
  for (const [chatId, value] of taskRunnersByChat) {
    if (value.userId === userId && value.controllerTaskId === taskId) taskRunnersByChat.delete(chatId)
  }
}
function reserve(userId: string, taskId: string, saved: ScriptRuntimeCheckpoint): void {
  retained.set(keyOf(userId, taskId), saved)
  try { owned(userId, taskId) } catch { return }
  const chats = [{ chatId: saved.chatId, taskId, working: saved.state === 'running' || saved.state === 'queued' },
    ...Object.values(saved.steps).map((step) => ({ ...step,
      working: step.state === 'running' || step.state === 'queued' }))]
  for (const chat of chats) {
    const row = taskRepo.getById(userId, chat.taskId)
    if (!row || row.deletedAt || row.chatId !== chat.chatId) continue
    const task = taskService.getById(userId, chat.taskId)
    if (task.executor !== 'desktop' || !task.runsHere || (chat.taskId !== taskId && task.parentTaskId !== taskId)) continue
    const prior = taskRunnersByChat.get(chat.chatId)
    if (prior && (prior.userId !== userId || prior.taskId !== chat.taskId)) throw new Error('Another execution owns a script conversation.')
    taskRunnersByChat.set(chat.chatId, { userId, taskId: chat.taskId, controllerTaskId: taskId, id: saved.attemptId,
      working: chat.working && saved.state !== 'waiting' && saved.state !== 'interrupted',
      cancel: () => scriptRuntimeService.cancel(userId, taskId) })
  }
}
/** Internal child writes notify the shared bridge too; do not treat them as external takeover. */
function write<T>(userId: string, taskId: string, update: (saved: ScriptRuntimeCheckpoint) => T): T {
  const key = keyOf(userId, taskId)
  mutating.add(key)
  try {
    const result = getDb().transaction(() => update(checkpoint(userId, taskId)))
    const saved = checkpoint(userId, taskId)
    const active = executing.get(key)
    if (active) active.snapshot = saved
    releaseReservations(userId, taskId)
    if (saved.state !== 'completed') reserve(userId, taskId, saved)
    return result
  } finally { mutating.delete(key) }
}
function abort(execution: Execution): void {
  execution.controller.abort()
  execution.handles.forEach((handle) => handle.cancel())
}
function scopeFor(userId: string, saved: ScriptRuntimeCheckpoint): RunScope {
  return { profileUserId: userId, settingsUserId: saved.settingsUserId }
}
/** Every saved child must still belong to this root, including completed predecessors. */
function assertBindings(userId: string, taskId: string, saved: ScriptRuntimeCheckpoint): void {
  const root = owned(userId, taskId)
  if (root.parentTaskId !== null || root.chatId !== saved.chatId || root.goal !== saved.goal || root.router !== 'script' || JSON.stringify(root.script) !== JSON.stringify(saved.definition)) throw new Error('The script task definition changed. Stop this attempt and review the job before starting again.')
  for (const step of Object.values(saved.steps)) {
    const child = taskService.getById(userId, step.taskId)
    if (child.executor !== 'desktop' || !child.runsHere || child.parentTaskId !== taskId || child.chatId !== step.chatId ||
      !chatRepo.getOwned(userId, step.chatId) || chatRepo.getOwned(userId, step.chatId)?.deletedAt) {
      throw new Error('A script step no longer belongs to this execution on this device. Stop this attempt and review its tasks.')
    }
    if (!terminalSteps.has(step.state)) owned(userId, step.taskId)
  }
}
function assertCurrent(userId: string, taskId: string, execution: Execution, stepId?: string): void {
  if (execution.controller.signal.aborted) throw new Error('The script was stopped.')
  const saved = checkpoint(userId, taskId)
  assertBindings(userId, taskId, saved)
  if (stepId) {
    const step = saved.steps[stepId]
    const task = owned(userId, step.taskId)
    if (task.parentTaskId !== taskId || task.chatId !== step.chatId) throw new Error('A script step no longer belongs to this execution.')
  }
}
function reflectStatus(userId: string, taskId: string, saved: ScriptRuntimeCheckpoint): void {
  const remaining = Object.values(saved.steps).filter((step) => !terminalSteps.has(step.state))
  const allBlocked = remaining.length > 0 && remaining.every((step) => step.state === 'waiting' ||
    (step.state === 'running' && taskRepo.getById(userId, step.taskId)?.status === 'blocked') || step.state === 'pending')
  const ready = readyScriptSteps(saved.definition, Object.fromEntries(Object.entries(saved.steps).map(([id, step]) => [id, step.state])))
  taskService.applyRunState(userId, taskId, allBlocked && !ready.length ? 'needs_input' : 'working')
}
function finish(userId: string, taskId: string, state: 'completed' | 'error' | 'cancelled', reason: string | null, requireChat = true, writeRoot = true): void {
  if (writeRoot) owned(userId, taskId, requireChat)
  const key = keyOf(userId, taskId)
  const saved = scriptRuntimeRepo.get(userId, taskId) ?? executing.get(key)?.snapshot ?? retained.get(key)
  if (!saved) return
  mutating.add(key)
  try {
    getDb().transaction(() => {
      saved.elapsedMs += saved.activeStartedAt === null ? 0 : Math.max(0, Date.now() - saved.activeStartedAt)
      saved.state = 'completed'; saved.activeStartedAt = null; saved.reason = reason
      for (const step of Object.values(saved.steps)) {
        if (!terminalSteps.has(step.state)) {
          step.state = state === 'error' ? 'failed' : 'canceled'
          const child = taskRepo.getById(userId, step.taskId)
          if (child && !child.deletedAt && ['new', 'open', 'in_progress', 'blocked'].includes(child.status)) {
            const current = taskService.getById(userId, child.id)
            if (current.executor === 'desktop' && current.runsHere && current.parentTaskId === taskId && current.chatId === step.chatId) taskService.applyRunState(userId, child.id, state === 'error' ? 'failed' : 'canceled')
          }
        }
        for (const request of taskInputRequestRepo.listOpenForTask(step.taskId)) {
          if (request.chatId === step.chatId && (step.pendingRequestIds.includes(request.id) || (step.lastRunId !== null && request.rootRunId === step.lastRunId) ||
            (request.deliveryOwner === 'runner' && request.rootRunId === saved.attemptId))) {
            taskInputRequestRepo.settle(request.id, 'expired', null)
          }
        }
      }
      const row = taskRepo.getById(userId, taskId)
      if (row && !row.deletedAt) {
        scriptRuntimeRepo.save(userId, taskId, saved)
        if (writeRoot) {
          if (state === 'completed') {
            const summary = saved.definition.steps.map((step) => `${step.id}:\n${saved.steps[step.id].text ?? ''}`).join('\n\n')
            messageRepo.saveAssistant({ chatId: saved.chatId, content: `Script completed.\n\n${summary}` })
          } else if (state === 'error' && reason && chatRepo.getOwned(userId, saved.chatId)) {
            messageRepo.saveError({ chatId: saved.chatId, short: reason, code: 'script_runtime' })
          }
          taskService.setStatus(userId, taskId, state, { errorMessage: reason })
        }
      }
      const run = jobRunsRepo.getById(userId, saved.jobRunId)
      if (run?.taskId === taskId && run.localChatId === saved.chatId && ['pending', 'running'].includes(run.status)) {
        jobRunsRepo.updateStatus(run.id, state === 'completed' ? 'succeeded' : state === 'error' ? 'failed' : 'cancelled', { errorMessage: state === 'error' ? reason : null })
      }
    })
    const active = executing.get(key)
    if (active) active.snapshot = saved
    else { releaseReservations(userId, taskId); retained.delete(key) }
  } finally { mutating.delete(key) }
}
function interrupt(userId: string, taskId: string, reason: string): void {
  write(userId, taskId, (saved) => {
    saved.elapsedMs += saved.activeStartedAt === null ? 0 : Math.max(0, Date.now() - saved.activeStartedAt)
    saved.activeStartedAt = null; saved.state = 'interrupted'; saved.reason = reason
    const root = taskService.getById(userId, taskId)
    const localOwner = root.executor === 'desktop' && root.runsHere
    for (const step of Object.values(saved.steps)) {
      if (step.state === 'running' || step.state === 'queued') step.state = 'interrupted'
      if (localOwner && !terminalSteps.has(step.state)) {
        const row = taskRepo.getById(userId, step.taskId)
        if (row && !row.deletedAt && ['in_progress', 'blocked'].includes(row.status)) {
          const child = taskService.getById(userId, step.taskId)
          if (child.executor === 'desktop' && child.runsHere && child.parentTaskId === taskId && child.chatId === step.chatId) {
            taskService.applyRunState(userId, step.taskId, 'needs_input')
          }
        }
      }
    }
    scriptRuntimeRepo.save(userId, taskId, saved)
    if (localOwner && ['in_progress', 'blocked'].includes(root.status)) taskService.applyRunState(userId, taskId, 'needs_input')
  })
}

async function runStep(userId: string, taskId: string, definition: ScriptStep, execution: Execution): Promise<void> {
  const stepId = definition.id
  try {
    assertCurrent(userId, taskId, execution, stepId)
    const initial = checkpoint(userId, taskId)
    const step = initial.steps[stepId]
    const outputs = Object.fromEntries(Object.entries(initial.steps).filter(([, value]) => value.state === 'completed' && value.text !== null)
      .map(([id, value]) => [id, value.text!]))
    const prompt = step.prompt ?? expandScriptTemplate(definition.agent === undefined ? definition.ask_user : definition.prompt,
      initial.goal, outputs)
    if (definition.agent === undefined) {
      write(userId, taskId, (saved) => {
        const child = saved.steps[stepId]
        const requestId = `script:${saved.attemptId}:${stepId}`
        taskInputRequestRepo.open({ requestId, taskId: child.taskId, chatId: child.chatId, agentId: null,
          deliveryOwner: 'runner', rootRunId: saved.attemptId, invocationId: stepId,
          request: { kind: 'question', questions: [{ question: prompt, multiSelect: false, options: [] }] }, resume: 'reply' })
        child.state = 'waiting'; child.prompt = prompt; child.pendingRequestIds = [requestId]
        messageRepo.saveTransition({ chatId: child.chatId, content: prompt })
        scriptRuntimeRepo.save(userId, taskId, saved)
        taskService.applyRunState(userId, child.taskId, 'needs_input')
        reflectStatus(userId, taskId, saved)
      })
      return
    }
    const target = initial.targets[definition.agent]
    write(userId, taskId, (saved) => { saved.steps[stepId].prompt = prompt; scriptRuntimeRepo.save(userId, taskId, saved) })
    await withRuntimeAgent(target.agentId, execution.controller.signal, async () => {
      assertCurrent(userId, taskId, execution, stepId)
      const current = checkpoint(userId, taskId)
      assertScriptTargets(scopeFor(userId, current), current.definition, current.targets)
      write(userId, taskId, (saved) => {
        if (saved.ownerTurns >= saved.budget.maxRounds) throw new Error('The script reached its agent-turn limit.')
        saved.ownerTurns++
        saved.steps[stepId] = { ...saved.steps[stepId], state: 'running', prompt }
        scriptRuntimeRepo.save(userId, taskId, saved)
        taskService.applyRunState(userId, step.taskId, 'working')
      })
      const handle = runExecutionService.start(scopeFor(userId, current), { chatId: step.chatId, content: prompt }, {
        runnerTaskId: step.taskId, agentId: target.agentId, inputOrigin: step.promptOrigin,
        onAccepted: () => assertCurrent(userId, taskId, execution, stepId),
        observe: (context, event) => {
          inboxService.recordRunEvent(context, event)
          if (!execution.controller.signal.aborted && ['needs_input', 'input_resolved', 'status'].includes(event.type)) write(userId, taskId, (saved) => reflectStatus(userId, taskId, saved))
        }
      })
      execution.handles.set(stepId, handle)
      write(userId, taskId, (saved) => { saved.steps[stepId].lastRunId = handle.id; scriptRuntimeRepo.save(userId, taskId, saved) })
      if (execution.controller.signal.aborted) handle.cancel()
      const outcome = await handle.completed
      execution.handles.delete(stepId)
      assertCurrent(userId, taskId, execution, stepId)
      if (outcome.inputRequestReadError) {
        execution.interruptedReason = outcome.inputRequestReadError
        abort(execution); return
      }
      if (outcome.state === 'canceled') { abort(execution); return }
      if (outcome.state === 'failed' || outcome.state === 'budget') throw new Error(outcome.error?.message ?? `Script step ${stepId} failed.`)
      const open = taskInputRequestRepo.listOpenForTask(step.taskId)
      if (outcome.state === 'needs_input' && !open.length) {
        execution.interruptedReason = `Step ${stepId} needs input, but no answerable question was saved. Review the conversation before resuming.`
        abort(execution); return
      }
      write(userId, taskId, (saved) => {
        const child = saved.steps[stepId]
        child.text = compactScriptOutput(outcome.text ?? '')
        if (open.length) {
          child.state = 'waiting'
          child.pendingRequestIds = open.filter((request) => request.chatId === child.chatId &&
            (request.rootRunId === handle.id || child.pendingRequestIds.includes(request.id))).map((request) => request.id)
          if (child.pendingRequestIds.length !== open.length) throw new Error(`Step ${stepId} has a question outside its execution.`)
          taskService.applyRunState(userId, child.taskId, 'needs_input')
        } else {
          child.state = 'completed'; child.pendingRequestIds = []
          taskService.applyRunState(userId, child.taskId, 'completed')
          messageRepo.saveTransition({ chatId: saved.chatId, content: `Step ${stepId} completed.\n${child.text}` })
        }
        scriptRuntimeRepo.save(userId, taskId, saved)
        reflectStatus(userId, taskId, saved)
      })
    })
  } catch (error) {
    if (!execution.controller.signal.aborted) execution.failure = error instanceof Error ? error.message : String(error)
    abort(execution)
  } finally {
    const handle = execution.handles.get(stepId)
    if (handle) { await handle.completed; execution.handles.delete(stepId) }
  }
}

async function drive(userId: string, taskId: string, execution: Execution): Promise<void> {
  let release: (() => void) | undefined
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const saved = checkpoint(userId, taskId)
    const remainingMs = saved.budget.maxMinutes * 60_000 - saved.elapsedMs
    if (saved.budget.maxTokens !== undefined) throw new Error('Token limits require usage reporting from every participant.')
    if (remainingMs <= 0) throw new Error('The script reached its time limit.')
    write(userId, taskId, (current) => {
      current.activeStartedAt = Date.now(); current.state = 'queued'; current.reason = null
      scriptRuntimeRepo.save(userId, taskId, current)
    })
    timer = setTimeout(() => { execution.timedOut = true; abort(execution) }, remainingMs)
    release = await taskSlots.acquire(execution.controller.signal)
    while (!execution.controller.signal.aborted) {
      assertCurrent(userId, taskId, execution)
      const saved = checkpoint(userId, taskId)
      const ready = readyScriptSteps(saved.definition, Object.fromEntries(Object.entries(saved.steps).map(([id, step]) => [id, step.state])))
      // Answer continuations are queued already and do not re-expand the original prompt.
      const resumable = saved.definition.steps.filter((step) => saved.steps[step.id].state === 'queued' && !execution.steps.has(step.id))
      for (const definition of [...ready, ...resumable]) {
        write(userId, taskId, (current) => {
          current.state = 'running'; current.steps[definition.id].state = 'queued'
          scriptRuntimeRepo.save(userId, taskId, current)
        })
        const promise = runStep(userId, taskId, definition, execution)
        execution.steps.set(definition.id, promise)
        void promise.finally(() => execution.steps.delete(definition.id)).catch(() => {})
      }
      if (execution.controller.signal.aborted) break
      if (execution.steps.size) {
        await Promise.race([...execution.steps.values(), new Promise<void>((resolve) => { execution.wake = resolve })])
        execution.wake = undefined
        continue
      }
      const current = checkpoint(userId, taskId)
      if (Object.values(current.steps).every((step) => step.state === 'completed')) {
        finish(userId, taskId, 'completed', null); return
      }
      if (Object.values(current.steps).some((step) => step.state === 'waiting')) {
        write(userId, taskId, (value) => {
          value.elapsedMs += value.activeStartedAt === null ? 0 : Math.max(0, Date.now() - value.activeStartedAt)
          value.activeStartedAt = null; value.state = 'waiting'; value.reason = 'Waiting for script answers in the Inbox.'
          scriptRuntimeRepo.save(userId, taskId, value)
          taskService.applyRunState(userId, taskId, 'needs_input')
        })
        return
      }
      throw new Error('The script has no ready steps. Review its saved execution before resuming.')
    }
  } catch (error) {
    if (!execution.controller.signal.aborted) execution.failure = error instanceof Error ? error.message : String(error)
    abort(execution)
  } finally {
    clearTimeout(timer)
    await Promise.allSettled(execution.steps.values())
    try {
      const current = checkpoint(userId, taskId)
      if (current.state !== 'completed' && execution.controller.signal.aborted) {
        if (execution.interruptedReason) interrupt(userId, taskId, execution.interruptedReason)
        else {
          write(userId, taskId, (value) => {
            value.elapsedMs += value.activeStartedAt === null ? 0 : Math.max(0, Date.now() - value.activeStartedAt)
            value.activeStartedAt = null; scriptRuntimeRepo.save(userId, taskId, value)
          })
          finish(userId, taskId, execution.failure || execution.timedOut ? 'error' : 'cancelled',
            execution.timedOut ? 'The script reached its time limit.' : execution.failure ?? null)
        }
      }
    } catch (error) { logger.warn('script stopped after losing its task', { taskId, error: String(error) }) }
    release?.()
    executing.delete(keyOf(userId, taskId))
    retained.delete(keyOf(userId, taskId))
    const current = scriptRuntimeRepo.get(userId, taskId)
    releaseReservations(userId, taskId)
    if (current && current.state !== 'completed') {
      try { owned(userId, taskId); reserve(userId, taskId, current) } catch { /* ownership loss */ }
    }
  }
}
function enqueue(userId: string, taskId: string): void {
  const key = keyOf(userId, taskId)
  if (executing.has(key)) throw new Error('The script is already running or still stopping.')
  const execution: Execution = { snapshot: checkpoint(userId, taskId), controller: new AbortController(), handles: new Map(), steps: new Map(), timedOut: false }
  executing.set(key, execution)
  reserve(userId, taskId, checkpoint(userId, taskId))
  execution.promise = drive(userId, taskId, execution)
  void execution.promise.catch((error) => logger.error('script cleanup failed', { taskId, error: String(error) }))
}

export const scriptRuntimeService = {
  startJob(scope: RunScope, job: JobRow): { chatId: string; taskId: string; runId: string } {
    const prepared = this.prepareJob(scope, job)
    prepared.launch()
    return { chatId: prepared.chatId, taskId: prepared.taskId, runId: prepared.runId }
  },

  /** May join an occurrence transaction. No reservation or driver work until launch. */
  prepareJob(scope: RunScope, job: JobRow): { chatId: string; taskId: string; runId: string; launch: () => void } {
    jobRuntimeDefinition(job)
    const definition = validateTaskScript(job.script)
    const budget = runtimeBudget(job.budget)
    if (budget.maxTokens !== undefined) throw new Error('Token limits require usage reporting from every participant. Use a time and round limit.')
    if (!job.prompt.trim() || job.prompt.length > 64000) throw new Error('The script goal must contain 1–64000 characters.')
    const targets = resolveScriptTargets(scope, definition)
    const currentJob = jobsRepo.getById(scope.profileUserId, job.id)
    if (!currentJob || currentJob.deletedAt || JSON.stringify([currentJob.type, currentJob.userId, currentJob.title, currentJob.prompt, currentJob.router, currentJob.script, currentJob.budget]) !== JSON.stringify([job.type, job.userId, job.title, job.prompt, job.router, job.script, job.budget])) throw new Error('The job changed before this attempt started.')
    const result = getDb().transaction(() => {
      const { chatId, runId } = jobRunsRepo.createLocalChatAndRun({ userId: scope.profileUserId, jobId: job.id, title: job.title, prompt: job.prompt,
        rootAgentId: null, router: 'direct', modeId: null, providerId: null, modelId: null, onDemandAgentIds: [], onDemandMcpIds: [] })
      const root = taskService.create(scope.profileUserId, { title: job.title, goal: job.prompt, router: 'script', script: definition, assigneeKind: 'script',
        budget, chatId, jobId: job.id, jobRunId: runId })
      taskService.start(scope.profileUserId, root.id)
      jobRunsRepo.setTaskId(runId, root.id)
      const steps: Record<string, ScriptStepCheckpoint> = {}
      for (const step of definition.steps) {
        const target = step.agent === undefined ? null : targets[step.agent]
        const chat = chatRepo.create(scope.profileUserId, { title: `${job.title} · ${step.id}`, agentId: target?.agentId ?? null, router: 'direct', hiddenFromList: true })
        const child = taskService.create(scope.profileUserId, { title: step.id, goal: `Script step ${step.id} for: ${job.prompt}`, chatId: chat.id, parentTaskId: root.id,
          assigneeKind: target ? 'agent' : 'human', assigneeAgentId: target?.agentId ?? null, assigneeName: target?.name ?? null })
        taskService.start(scope.profileUserId, child.id)
        steps[step.id] = { taskId: child.id, chatId: chat.id, state: 'pending', text: null, prompt: null, promptOrigin: 'runner', lastRunId: null, pendingRequestIds: [] }
      }
      scriptRuntimeRepo.save(scope.profileUserId, root.id, { jobRunId: runId, goal: root.goal, attemptId: nanoid(), chatId, settingsUserId: scope.settingsUserId,
        state: 'queued', reason: null, ownerTurns: 0, elapsedMs: 0, budget, definition, targets, steps, activeStartedAt: null })
      messageRepo.saveUser({ chatId, content: job.prompt })
      return { chatId, runId, taskId: root.id }
    })
    const attemptId = checkpoint(scope.profileUserId, result.taskId).attemptId
    return { ...result, launch: () => {
      if (getRawSqlite().inTransaction) throw new Error('Commit the script admission before launching it.')
      const saved = checkpoint(scope.profileUserId, result.taskId)
      if (saved.attemptId !== attemptId || saved.settingsUserId !== scope.settingsUserId || saved.state !== 'queued') throw new Error('The prepared script attempt is no longer queued.')
      assertBindings(scope.profileUserId, result.taskId, saved)
      enqueue(scope.profileUserId, result.taskId)
    } }
  },

  /** A committed admission which lost its scheduler before launch requires review. */
  interruptPrepared(userId: string, taskId: string, reason: string): void {
    const saved = checkpoint(userId, taskId)
    if (saved.state !== 'queued' || executing.has(keyOf(userId, taskId))) throw new Error('The prepared script is no longer awaiting launch.')
    interrupt(userId, taskId, reason)
  },

  recover(): void {
    for (const { userId, taskId, checkpoint: saved } of scriptRuntimeRepo.list()) {
      if (saved.state === 'completed' || executing.has(keyOf(userId, taskId))) continue
      try {
        assertBindings(userId, taskId, saved)
        if (saved.state === 'running' || saved.state === 'queued') interrupt(userId, taskId,
          'The script was interrupted. Review step conversations before resuming; an agent may already have made changes.')
        else reserve(userId, taskId, saved)
      } catch (error) {
        try { interrupt(userId, taskId, error instanceof Error ? error.message : String(error)) } catch { /* removed task */ }
        releaseReservations(userId, taskId)
      }
    }
  },

  interruptAll(reason: string): void {
    for (const [key, execution] of executing) {
      const [userId, taskId] = JSON.parse(key) as [string, string]
      execution.interruptedReason = reason
      try { interrupt(userId, taskId, reason) } catch (error) { logger.warn('could not checkpoint script interruption', { taskId, error: String(error) }) }
      abort(execution)
    }
  },

  resume(userId: string, inputTaskId: string): void {
    const root = scriptRuntimeRepo.owner(userId, inputTaskId)
    if (!root) throw new Error('This task has no script execution.')
    const taskId = root.taskId
    owned(userId, taskId)
    assertBindings(userId, taskId, root.checkpoint)
    if (root.checkpoint.state !== 'interrupted') throw new Error('Answer waiting questions in the Inbox, or wait for the script.')
    if (executing.has(keyOf(userId, taskId))) throw new Error('The script is still stopping.')
    write(userId, taskId, (saved) => {
      for (const [stepId, step] of Object.entries(saved.steps)) {
        if (terminalSteps.has(step.state)) continue
        owned(userId, step.taskId)
        if (step.lastRunId) taskInputRequestRepo.expireOpenForRun(step.chatId, step.lastRunId, true)
        const open = taskInputRequestRepo.listOpenForTask(step.taskId)
        if (open.length) {
          step.state = 'waiting'
          step.pendingRequestIds = open.filter((request) => request.deliveryOwner === 'runner' || request.rootRunId === step.lastRunId || step.pendingRequestIds.includes(request.id)).map((request) => request.id)
          if (open.length !== step.pendingRequestIds.length) throw new Error(`Step ${stepId} has an unrecognized waiting question.`)
        } else if (step.state === 'interrupted' && !step.lastRunId) {
          step.state = 'pending'; step.prompt = null; step.promptOrigin = 'runner'
        } else if (step.state === 'interrupted') {
          step.state = 'queued'; step.promptOrigin = 'runner'
          step.prompt = `The previous execution of script step ${stepId} was interrupted. Review the saved conversation and existing work before acting. Do not repeat completed side effects. Reconcile the current state and finish this step.\n\nStep intent:\n${step.prompt ?? ''}`
          if (step.prompt.length > 64000) throw new Error(`Step ${stepId} is too large to resume safely. Start a revised job after reviewing its work.`)
        }
      }
      saved.state = Object.values(saved.steps).some((step) => step.state === 'queued' || step.state === 'pending') ? 'queued' : 'waiting'
      saved.reason = saved.state === 'waiting' ? 'Waiting for script answers in the Inbox.' : null
      scriptRuntimeRepo.save(userId, taskId, saved)
      reflectStatus(userId, taskId, saved)
    })
    if (checkpoint(userId, taskId).state === 'queued') enqueue(userId, taskId)
  },

  cancel(userId: string, inputTaskId: string): void {
    const root = scriptRuntimeRepo.owner(userId, inputTaskId)
    if (!root) throw new Error('This task has no script execution.')
    owned(userId, root.taskId)
    const active = executing.get(keyOf(userId, root.taskId))
    if (active) abort(active)
    else finish(userId, root.taskId, 'cancelled', null)
  },

  answer(userId: string, requestId: string, resolution: RequestResolution): Promise<InboxAnswerResult> | null {
    const request = taskInputRequestRepo.getById(requestId)
    if (!request || (request.deliveryOwner !== 'runner' && request.resume !== 'next_message')) return null
    const root = scriptRuntimeRepo.owner(userId, request.taskId)
    if (!root) return null
    return (async () => {
      try {
        const taskId = root.taskId
        owned(userId, taskId); owned(userId, request.taskId)
        const saved = checkpoint(userId, taskId)
        assertBindings(userId, taskId, saved)
        const entry = Object.entries(saved.steps).find(([, step]) => step.taskId === request.taskId)
        if (!entry) return { ok: false, code: 'no_longer_waiting', reason: 'This question is outside the script execution.' }
        const [stepId, step] = entry
        if (request.status !== 'open') return { ok: false, code: 'already_answered', reason: 'This question has already been answered.' }
        if (step.chatId !== request.chatId || !step.pendingRequestIds.includes(requestId)) return { ok: false, code: 'no_longer_waiting', reason: 'This question no longer belongs to the step checkpoint.' }
        const active = executing.get(keyOf(userId, taskId))
        if (active?.controller.signal.aborted || ['interrupted', 'completed'].includes(saved.state) || step.state !== 'waiting' || active?.steps.has(stepId)) return { ok: false, code: 'unavailable', reason: 'This script step is still settling or needs recovery. Try again after it settles.' }
        if (resolution.kind !== 'question' || !resolution.answers.some((answers) => answers.some((answer) => answer.trim()))) return { ok: false, code: 'malformed', reason: 'Enter an answer before sending.' }
        const answer = resolution.answers.map((answers) => answers.join(', ')).join('\n')
        if (answer.length > 64000) return { ok: false, code: 'malformed', reason: 'The answer is too long.' }
        const definition = saved.definition.steps.find((item) => item.id === stepId)!
        if (definition.agent !== undefined) assertScriptTargets(scopeFor(userId, saved), saved.definition, saved.targets)
        if (request.deliveryOwner === 'runner' && requestId !== `script:${saved.attemptId}:${stepId}`) return { ok: false, code: 'no_longer_waiting', reason: 'This question belongs to another script attempt.' }
        write(userId, taskId, (current) => {
          if (!taskInputRequestRepo.settle(requestId, 'answered', resolution)) throw new Error('This question was already answered.')
          const child = current.steps[stepId]
          child.pendingRequestIds = child.pendingRequestIds.filter((id) => id !== requestId)
          if (definition.agent === undefined) {
            child.state = 'completed'; child.text = compactScriptOutput(answer)
            messageRepo.saveUser({ chatId: child.chatId, content: answer })
            taskService.applyRunState(userId, child.taskId, 'completed')
            messageRepo.saveTransition({ chatId: current.chatId, content: `Human answer for step ${stepId}:\n${child.text}` })
          } else {
            child.state = 'queued'; child.prompt = answer; child.promptOrigin = 'user'
            taskService.applyRunState(userId, child.taskId, child.pendingRequestIds.length ? 'needs_input' : 'working')
          }
          current.state = active ? 'running' : 'queued'; current.reason = null
          scriptRuntimeRepo.save(userId, taskId, current)
          reflectStatus(userId, taskId, current)
        })
        if (active) active.wake?.()
        else enqueue(userId, taskId)
        return { ok: true }
      } catch (error) { return { ok: false, code: 'unavailable', reason: error instanceof Error ? error.message : String(error) } }
    })()
  }
}

installTaskRunnerHooks({
  answer: (userId, requestId, resolution) => scriptRuntimeService.answer(userId, requestId, resolution),
  profileRemoved: (userId) => {
    for (const [key, execution] of executing) if ((JSON.parse(key) as string[])[0] === userId) abort(execution)
    for (const [chatId, reservation] of taskRunnersByChat) if (reservation.userId === userId && reservation.controllerTaskId) taskRunnersByChat.delete(chatId)
    for (const key of retained.keys()) if ((JSON.parse(key) as string[])[0] === userId) retained.delete(key)
  },
  chatRemoved: (userId, chatId) => {
    const row = scriptRuntimeRepo.list(userId).find(({ checkpoint: saved }) => saved.chatId === chatId || Object.values(saved.steps).some((step) => step.chatId === chatId))
    if (!row || row.checkpoint.state === 'completed') return
    const active = executing.get(keyOf(userId, row.taskId))
    try { finish(userId, row.taskId, 'cancelled', 'A script conversation was deleted.', false) }
    catch (error) { logger.warn('deleted script conversation could not be finalized', { taskId: row.taskId, error: String(error) }) }
    if (active) abort(active)
  },
  taskChanged: (userId, inputTaskId) => {
    const root = scriptRuntimeRepo.owner(userId, inputTaskId)
    if (!root) {
      const active = executing.get(keyOf(userId, inputTaskId))
      if (active) abort(active)
      if (active || retained.has(keyOf(userId, inputTaskId))) {
        try { finish(userId, inputTaskId, 'cancelled', 'The script task was deleted.', false, false) } catch { /* cleanup is best effort after deletion */ }
      }
      if (!active) releaseReservations(userId, inputTaskId)
      return
    }
    if (root.checkpoint.state === 'completed' || mutating.has(keyOf(userId, root.taskId))) return
    const changed = taskRepo.getById(userId, inputTaskId)
    const changedStep = Object.values(root.checkpoint.steps).find((step) => step.taskId === inputTaskId)
    const newlyTerminal = ['completed', 'error', 'cancelled', 'archived'].includes(changed?.status ?? '') &&
      (!changedStep || !terminalSteps.has(changedStep.state))
    if (!changed || changed.deletedAt || newlyTerminal) {
      const active = executing.get(keyOf(userId, root.taskId))
      if (active) abort(active)
      try { finish(userId, root.taskId, 'cancelled', 'A script task was stopped or deleted.', false, inputTaskId !== root.taskId) }
      catch (error) { logger.warn('could not settle stopped script children', { taskId: root.taskId, error: String(error) }) }
      return
    }
    try {
      assertBindings(userId, root.taskId, root.checkpoint)
    } catch {
      const active = executing.get(keyOf(userId, root.taskId))
      const reason = 'The script stopped because a task was removed or its execution ownership changed.'
      if (active) { active.interruptedReason = reason; abort(active) }
      try { interrupt(userId, root.taskId, reason) } catch { releaseReservations(userId, root.taskId) }
    }
  }
}, 'script')
