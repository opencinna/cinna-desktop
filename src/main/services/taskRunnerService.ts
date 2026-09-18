import { nanoid } from 'nanoid'
import { getDb } from '../db/client'
import { taskRepo } from '../db/tasks'
import { taskRuntimeRepo } from '../db/taskRuntimes'
import { taskInputRequestRepo } from '../db/taskInputRequests'
import { chatRepo } from '../db/chats'
import { chatRunResultRepo } from '../db/chatRunResults'
import { chatOnDemandAgentRepo } from '../db/chatOnDemandAgent'
import { messageRepo } from '../db/messages'
import { agentOverrideRepo } from '../db/agents'
import { taskHandoffRepo } from '../db/taskHandoffs'
import { handingOffChats } from './taskOperationState'
import { runtimeBudget } from '../tasks/runtimeBudget'
import { taskSlots, withRuntimeAgent as withAgent } from '../tasks/runtimeAdmission'
import type { TaskRuntimeCheckpoint } from '../tasks/runtimeTypes'
import type { AutonomousTaskStart } from '../../shared/taskRuntime'
import type { RequestResolution } from '../../shared/localAgentRequests'
import type { InboxAnswerResult } from '../../shared/inbox'
import { taskService } from './taskService'
import { inboxService } from './inboxService'
import { runExecutionService, type RunHandle, type RunScope } from './runExecutionService'
import { taskRunnersByChat } from './taskRunnerState'
import { installTaskRunnerHooks } from './taskRunnerBridge'
import { CoordinatorToolProvider, type CoordinatorAgent } from './coordinatorToolProvider'
import { A2AAsMcpProvider } from './a2aAsMcpProvider'
import { agentService } from './agentService'
import { createLogger } from '../logger/logger'
import { canConduct } from '../../shared/chatRouting'
import { nestedToolCallId } from './nestedContinuationService'
import { chatConductorService } from './chatConductorService'

const logger = createLogger('task-runner')
const continuation = 'Continue coordinating the task from the saved conversation. Use finish only when the goal is achieved; use ask_user when a human decision is needed.'
interface Execution { controller: AbortController; handle?: RunHandle; timedOut: boolean; interruptedReason?: string; promise?: Promise<void> }
const executing = new Map<string, Execution>()
const keyOf = (userId: string, taskId: string): string => JSON.stringify([userId, taskId])

function owned(userId: string, taskId: string, requireChat = true) {
  const task = taskService.getById(userId, taskId)
  if (task.executor !== 'desktop' || !task.runsHere || !['in_progress', 'blocked'].includes(task.status)) {
    throw new Error('The task is no longer runnable on this device.')
  }
  if (requireChat && (!task.chatId || !chatRepo.getOwned(userId, task.chatId) || chatRepo.getOwned(userId, task.chatId)?.deletedAt)) {
    throw new Error('The task conversation is no longer available.')
  }
  return task
}
function checkpoint(userId: string, taskId: string): TaskRuntimeCheckpoint {
  const value = taskRuntimeRepo.get(userId, taskId)
  if (!value) throw new Error('This task has no local execution checkpoint.')
  return value
}
function agents(scope: RunScope, chatId: string): CoordinatorAgent[] {
  const conductorId = chatRepo.getOwned(scope.profileUserId, chatId)?.agentId
  return chatOnDemandAgentRepo.listAgentIds(chatId).flatMap((id) => {
    if (id === conductorId) return []
    const located = agentService.findAgent(scope.settingsUserId, scope.profileUserId, id)
    if (!located || !(agentOverrideRepo.get(scope.profileUserId, id)?.enabled ?? located.row.enabled)) return []
    return [{ id, name: located.row.name }]
  })
}
function reserve(userId: string, taskId: string, value: TaskRuntimeCheckpoint): void {
  const prior = taskRunnersByChat.get(value.chatId)
  if (prior && (prior.taskId !== taskId || prior.userId !== userId)) throw new Error('Another task owns this conversation.')
  taskRunnersByChat.set(value.chatId, { userId, taskId, id: value.attemptId,
    working: value.state === 'queued' || value.state === 'running', cancel: () => taskRunnerService.cancel(userId, taskId) })
}
function store(userId: string, taskId: string, value: TaskRuntimeCheckpoint): void {
  taskRuntimeRepo.save(userId, taskId, value)
  if (value.state === 'completed') taskRunnersByChat.delete(value.chatId)
  else reserve(userId, taskId, value)
}
function finish(userId: string, taskId: string, state: 'completed' | 'error' | 'cancelled', reason: string | null, persistError = true, requireChat = true): void {
  const task = owned(userId, taskId, requireChat)
  const saved = checkpoint(userId, taskId)
  getDb().transaction(() => {
    taskRuntimeRepo.save(userId, taskId, { ...saved, state: 'completed', activeStartedAt: null, reason })
    if (persistError && reason && state === 'error') messageRepo.saveError({ chatId: saved.chatId, short: reason, code: 'task_runtime' })
    taskService.setStatus(userId, taskId, state, { errorMessage: reason })
    // A failed/canceled task must not strand any gate from a prior invocation.
    taskInputRequestRepo.expireNextMessageForTask(task.id)
    if (chatRepo.getOwned(userId, saved.chatId)) {
      chatRunResultRepo.record(saved.chatId, nanoid(), state === 'error' ? 'failed' : state === 'cancelled' ? 'canceled' : 'completed')
    }
  })
  taskRunnersByChat.delete(saved.chatId)
}
function wait(userId: string, taskId: string, value: TaskRuntimeCheckpoint, reason: string): void {
  const pendingRequestIds = taskInputRequestRepo.listOpenForTask(taskId)
    .filter((request) => request.chatId === value.chatId &&
      (request.rootRunId === value.lastRunId || value.pendingRequestIds?.includes(request.id)))
    .map((request) => request.id)
  getDb().transaction(() => {
    store(userId, taskId, { ...value, pendingRequestIds, state: 'waiting', reason, activeStartedAt: null })
    taskService.applyRunState(userId, taskId, 'needs_input')
    chatRunResultRepo.record(value.chatId, nanoid(), 'needs_input')
  })
}
function interrupted(userId: string, taskId: string, value: TaskRuntimeCheckpoint, reason: string): void {
  getDb().transaction(() => {
    store(userId, taskId, { ...value, state: 'interrupted', reason, activeStartedAt: null })
    taskService.applyRunState(userId, taskId, 'needs_input')
    // Quit checkpoints synchronously, then the canceled leaf settles later.
    if (value.state !== 'interrupted') chatRunResultRepo.record(value.chatId, nanoid(), 'needs_input')
  })
}

async function drive(userId: string, taskId: string, execution: Execution): Promise<void> {
  let release: (() => void) | undefined
  let timer: ReturnType<typeof setTimeout> | undefined
  const began = Date.now()
  let initialElapsed = 0
  try {
    let saved = checkpoint(userId, taskId)
    initialElapsed = saved.elapsedMs
    if (saved.budget.maxTokens !== undefined) throw new Error('Token limits require usage reporting from every participant. Use a time and round limit for this task.')
    const remainingMs = saved.budget.maxMinutes * 60_000 - saved.elapsedMs
    if (remainingMs <= 0) { finish(userId, taskId, 'error', 'The task reached its time limit.'); return }
    timer = setTimeout(() => { execution.timedOut = true; execution.controller.abort(); execution.handle?.cancel() }, remainingMs)
    release = await taskSlots.acquire(execution.controller.signal)
    while (!execution.controller.signal.aborted) {
      owned(userId, taskId)
      saved = checkpoint(userId, taskId)
      if (saved.owner.kind === 'coordinator' && !saved.coordinator.agentId) {
        const chat = chatRepo.getOwned(userId, saved.chatId)!
        const bound = chat.agentId ? chat : chatConductorService.bind(userId, chat)
        if (bound.agentId) {
          const root = agentService.findAgent(saved.settingsUserId, userId, bound.agentId)?.row
          saved = { ...saved, coordinator: { ...saved.coordinator, agentId: bound.agentId, name: root?.name } }
          store(userId, taskId, saved)
        }
      }
      if (saved.ownerTurns >= saved.budget.maxRounds) { finish(userId, taskId, 'error', 'The task reached its owner-turn limit.'); return }
      const scope = { profileUserId: userId, settingsUserId: saved.settingsUserId }
      const assertCurrent = (): void => { owned(userId, taskId); if (execution.controller.signal.aborted) throw new Error('The task was stopped.') }
      const next = { ...saved, state: 'running' as const, reason: null, ownerTurns: saved.ownerTurns + 1,
        activeStartedAt: Date.now(), elapsedMs: initialElapsed + Date.now() - began }
      store(userId, taskId, next)
      const coordinator = next.owner.kind === 'coordinator' ? new CoordinatorToolProvider(taskId, agents(scope, next.chatId), {
        assertCurrent,
        delegate: (agentId, message, opts) => withAgent(agentId, execution.controller.signal, async () => {
          assertCurrent()
          const located = agentService.findAgent(scope.settingsUserId, userId, agentId)
          if (!located || !agents(scope, next.chatId).some((agent) => agent.id === agentId)) throw new Error('The delegated agent is no longer available.')
          const result = await new A2AAsMcpProvider(next.chatId, located.row, located.userId, 'delegate').callTool('delegate', { message }, { ...opts, queueWhenBusy: true })
          return { ...result, needsInput: taskInputRequestRepo.listOpenForTask(taskId).some((request) => request.agentId === agentId && request.resume === 'next_message') }
        }),
        askUser: (question, toolCallId) => {
          assertCurrent()
          if (!execution.handle) throw new Error('The coordinator turn has no execution identity.')
          const requestId = `runner:${next.attemptId}:${execution.handle.id}:${toolCallId}`
          getDb().transaction(() => {
            taskInputRequestRepo.open({ requestId, taskId, chatId: next.chatId, agentId: null, deliveryOwner: 'runner',
              rootRunId: execution.handle!.id, invocationId: execution.handle!.id,
              request: { kind: 'question', questions: [{ question, multiSelect: false, options: [] }] }, resume: 'reply' })
            store(userId, taskId, { ...checkpoint(userId, taskId), gateRequestId: requestId, gateToolCallId: toolCallId })
            taskService.applyRunState(userId, taskId, 'needs_input')
          })
          return { requestId }
        },
        updateTask: (update) => {
          assertCurrent()
          if (update.note !== undefined) taskService.setHandoffNote(userId, taskId, update.note)
          if (update.artifacts !== undefined) taskService.setArtifacts(userId, taskId, update.artifacts)
          messageRepo.saveTransition({ chatId: next.chatId, content: update.note ?? 'Task artifacts updated.' })
        }
      }) : undefined
      const perform = async () => {
        assertCurrent()
        const ownerAgentId = next.owner.kind === 'agent' ? next.owner.agentId : null
        if (ownerAgentId && !agents(scope, next.chatId).some((agent) => agent.id === ownerAgentId)) {
          throw new Error('The task agent is no longer enabled and attached to this conversation.')
        }
        execution.handle = runExecutionService.start(scope, { chatId: next.chatId, content: next.prompt }, {
          runnerTaskId: taskId, coordinator, inputOrigin: next.promptOrigin,
          agentId: next.owner.kind === 'agent' ? next.owner.agentId : undefined,
          handbackEligible: next.owner.kind === 'agent' && !next.owner.toolCallId,
          ...(next.owner.kind === 'agent' && next.owner.toolCallId ? { nested: { toolCallId: next.owner.toolCallId } } : {}),
          ...(next.owner.kind === 'coordinator' && next.coordinator.agentId ? {
            toolCallBudget: {
              get remaining() {
                const current = checkpoint(userId, taskId)
                return Math.max(0, current.budget.maxRounds - (current.toolCalls ?? 0))
              },
              consume() {
                assertCurrent()
                const current = checkpoint(userId, taskId)
                if ((current.toolCalls ?? 0) >= current.budget.maxRounds) throw new Error('The task reached its tool-call limit.')
                store(userId, taskId, { ...current, toolCalls: (current.toolCalls ?? 0) + 1 })
              }
            }
          } : {}),
          observe: (context, event) => inboxService.recordRunEvent(context,
            next.owner.kind === 'agent' && next.owner.toolCallId
              ? { type: 'child', toolCallId: next.owner.toolCallId, agentId: next.owner.agentId, event } : event),
          onAccepted: assertCurrent
        })
        store(userId, taskId, { ...checkpoint(userId, taskId), lastRunId: execution.handle.id })
        if (execution.controller.signal.aborted) execution.handle.cancel()
        return await execution.handle.completed
      }
      const outcome = next.owner.kind === 'agent'
        ? await withAgent(next.owner.agentId, execution.controller.signal, perform) : await perform()
      execution.handle = undefined
      assertCurrent()
      saved = { ...checkpoint(userId, taskId), elapsedMs: initialElapsed + Date.now() - began, activeStartedAt: null }
      store(userId, taskId, saved)
      if (outcome.inputRequestReadError) { interrupted(userId, taskId, saved, outcome.inputRequestReadError); return }
      if (outcome.state === 'canceled') { finish(userId, taskId, 'cancelled', null); return }
      if (outcome.state === 'failed' || outcome.state === 'budget') { finish(userId, taskId, 'error', outcome.error?.message ?? 'The task turn failed.', false); return }
      const open = taskInputRequestRepo.listOpenForTask(taskId)
      if (outcome.state === 'needs_input' && !open.length) {
        interrupted(userId, taskId, saved, 'The agent needs input, but no answerable question was saved. Review the conversation before resuming.'); return
      }
      if (outcome.state === 'needs_input' || open.length) {
        wait(userId, taskId, saved, 'Waiting for a human answer in the Inbox.'); return
      }
      if (outcome.control?.kind === 'finish') { finish(userId, taskId, 'completed', null); return }
      if (outcome.control?.kind === 'handoff') {
        const handoff = outcome.control
        getDb().transaction(() => {
          assertCurrent()
          taskService.setHandoffNote(userId, taskId, handoff.note)
          taskService.setAssignee(userId, taskId, { kind: 'agent', agentId: handoff.agentId, name: handoff.agentName })
          chatRepo.updateMeta(userId, next.chatId, { router: 'human' })
          messageRepo.saveTransition({ chatId: next.chatId, content: `Task handed to ${handoff.agentName}.\n${handoff.note}`, sourceAgentId: handoff.agentId })
          store(userId, taskId, { ...saved, state: 'queued', owner: { kind: 'agent', agentId: handoff.agentId, name: handoff.agentName, note: handoff.note },
            prompt: `Goal:\n${owned(userId, taskId).goal}\n\nContinue the task with this handoff note:\n${handoff.note}`, promptOrigin: 'runner' })
        })
      } else {
        getDb().transaction(() => {
          let prompt = continuation
          if (saved.owner.kind === 'agent') {
            taskService.setAssignee(userId, taskId, saved.coordinator.agentId
              ? { kind: 'agent', agentId: saved.coordinator.agentId, name: saved.coordinator.name ?? null }
              : { kind: 'model', agentId: null, name: null })
            chatRepo.updateMeta(userId, next.chatId, { router: 'coordinator', agentId: saved.coordinator.agentId ?? null,
              ...(saved.coordinator.providerId ? { providerId: saved.coordinator.providerId } : {}),
              ...(saved.coordinator.modelId ? { modelId: saved.coordinator.modelId } : {}) })
            const note = outcome.handback?.note
            const notice = `${saved.owner.name} handed the task back to the coordinator.${note ? `\nAgent-provided handback note: ${JSON.stringify(note)}` : ''}`
            messageRepo.saveTransition({ chatId: next.chatId, content: notice, sourceAgentId: saved.owner.agentId })
            // Transition rows are UI notices and are omitted from provider
            // history. Include this ownership change in the next wire turn.
            prompt = `${notice}\n\n${continuation}`
            if (saved.owner.toolCallId) prompt = `The specialist result below completes tool call ${JSON.stringify(saved.owner.toolCallId)} after its Inbox answer.\n\n${outcome.text}\n\n${prompt}`
          }
          store(userId, taskId, { ...saved, state: 'queued', owner: { kind: 'coordinator' }, prompt, promptOrigin: 'runner' })
        })
      }
    }
    throw new Error(execution.timedOut ? 'The task reached its time limit.' : 'The task was stopped.')
  } catch (error) {
    try {
      const task = taskService.getById(userId, taskId)
      if (task.executor === 'desktop' && task.runsHere && ['in_progress', 'blocked'].includes(task.status)) {
        const saved = checkpoint(userId, taskId)
        store(userId, taskId, { ...saved, elapsedMs: initialElapsed + Date.now() - began })
        if (execution.interruptedReason) interrupted(userId, taskId, checkpoint(userId, taskId), execution.interruptedReason)
        else finish(userId, taskId, execution.controller.signal.aborted && !execution.timedOut ? 'cancelled' : 'error',
          execution.timedOut ? 'The task reached its time limit.' : execution.controller.signal.aborted ? null : error instanceof Error ? error.message : String(error))
      }
    } catch (cleanup) { logger.warn('task execution ended after losing its task', { taskId, error: String(cleanup) }) }
  } finally {
    clearTimeout(timer)
    release?.()
    executing.delete(keyOf(userId, taskId))
    for (const [chatId, reservation] of taskRunnersByChat) {
      if (reservation.userId === userId && reservation.taskId === taskId && !reservation.controllerTaskId) taskRunnersByChat.delete(chatId)
    }
    const current = taskRuntimeRepo.get(userId, taskId)
    if (current && current.state !== 'completed') {
      try { owned(userId, taskId); reserve(userId, taskId, current) } catch { /* ownership loss is authoritative */ }
    }
  }
}
function enqueue(userId: string, taskId: string): void {
  const key = keyOf(userId, taskId)
  if (executing.has(key)) throw new Error('The task is already running.')
  const execution: Execution = { controller: new AbortController(), timedOut: false }
  executing.set(key, execution)
  reserve(userId, taskId, checkpoint(userId, taskId))
  execution.promise = drive(userId, taskId, execution)
  void execution.promise.catch((error) => logger.error('task runner cleanup failed', { taskId, error: String(error) }))
}

export const taskRunnerService = {
  /** Persist before aborting: Electron does not await its quit listeners. */
  interruptAll(reason: string): void {
    for (const [key, execution] of executing) {
      const [userId, taskId] = JSON.parse(key) as [string, string]
      execution.interruptedReason = reason
      try {
        const saved = checkpoint(userId, taskId)
        interrupted(userId, taskId, { ...saved,
          elapsedMs: saved.elapsedMs + (saved.activeStartedAt ? Math.max(0, Date.now() - saved.activeStartedAt) : 0) }, reason)
      } catch (error) { logger.warn('could not checkpoint interrupted task', { taskId, error: String(error) }) }
      execution.controller.abort()
      execution.handle?.cancel()
    }
  },

  start(scope: RunScope, input: AutonomousTaskStart): { taskId: string; chatId: string } {
    const prepared = this.prepare(scope, input)
    prepared.launch()
    return { taskId: prepared.taskId, chatId: prepared.chatId }
  },

  /** Main-only admission seam: a job transaction commits before launch is called. */
  prepare(scope: RunScope, input: AutonomousTaskStart): { taskId: string; chatId: string; launch(): void } {
    if (!input || typeof input.goal !== 'string' || !input.goal.trim() || input.goal.length > 64000) throw new Error('Enter a task goal of at most 64000 characters.')
    let chat = chatRepo.getOwned(scope.profileUserId, input.chatId)
    if (!chat || chat.deletedAt || chat.router !== 'coordinator') {
      throw new Error('Choose a coordinator before running on its own.')
    }
    if (!chat.agentId) chat = chatConductorService.bind(scope.profileUserId, chat)
    const conductor = chat.agentId ? agentService.findAgent(scope.settingsUserId, scope.profileUserId, chat.agentId)?.row : undefined
    if (chat.agentId) {
      if (!conductor || !(agentOverrideRepo.get(scope.profileUserId, conductor.id)?.enabled ?? conductor.enabled) ||
        !canConduct({ ...conductor, acpTransport: typeof conductor.driverConfig?.transport === 'string' ? conductor.driverConfig.transport : undefined })) {
        throw new Error('Choose an enabled local coordinator before running on its own.')
      }
    } else {
      throw new Error('Choose a configured coordinator runtime before running on its own.')
    }
    if (typeof conductor.driverConfig?.conductorChatId === 'string' && conductor.driverConfig.conductorToolPolicy === 'none') {
      throw new Error('Choose a chat mode with connected tools before running on its own. Autonomous work needs task controls.')
    }
    if (runExecutionService.isRunning(chat.id) || taskRunnersByChat.has(chat.id)) throw new Error('This conversation already has a task or turn running.')
    if (handingOffChats.has(chat.id) || taskHandoffRepo.unresolvedForChat(scope.profileUserId, chat.id)) throw new Error('Resolve this conversation’s pending remote handoff before starting autonomous work.')
    if (taskInputRequestRepo.listOpenForChat(chat.id).length) throw new Error('Answer the pending questions before starting autonomous work.')
    const budget = runtimeBudget(input.budget)
    if (budget.maxTokens !== undefined) throw new Error('Token limits require usage reporting from every participant. Use a time and round limit for this task.')
    const existing = taskRepo.getByChatId(scope.profileUserId, chat.id)
    if (existing && !['new', 'open', 'in_progress', 'error'].includes(existing.status)) throw new Error('Start a new conversation for another task.')
    if (existing && existing.goal.trim() !== input.goal.trim()) throw new Error('This conversation already belongs to a task. Use its original goal, or start a new conversation for a different goal.')
    const task = getDb().transaction(() => {
      const task = existing ? taskService.getById(scope.profileUserId, existing.id) : taskService.create(scope.profileUserId,
        { title: input.goal.trim().slice(0, 80), goal: input.goal.trim(), chatId: chat.id, router: 'coordinator', budget })
      taskService.start(scope.profileUserId, task.id)
      taskService.setRuntimeBudget(scope.profileUserId, task.id, budget)
      taskService.update(scope.profileUserId, task.id, { router: 'coordinator' })
      const saved: TaskRuntimeCheckpoint = { attemptId: nanoid(), lastRunId: null, pendingRequestIds: [], chatId: chat.id, settingsUserId: scope.settingsUserId,
        state: 'queued', reason: null, ownerTurns: 0, elapsedMs: 0, budget, owner: { kind: 'coordinator' },
        prompt: input.goal.trim(), promptOrigin: 'user', gateRequestId: null, gateToolCallId: null, activeStartedAt: null,
        coordinator: { agentId: chat.agentId, ...(conductor ? { name: conductor.name } : {}), providerId: chat.providerId, modelId: chat.modelId, modeId: chat.modeId }, toolCalls: 0 }
      taskRuntimeRepo.save(scope.profileUserId, task.id, saved)
      messageRepo.saveSystem({ chatId: chat.id, content: 'You coordinate this task autonomously. Delegate only to attached agents. Use ask_user for human decisions, handoff to change owner, update_task for progress, and finish with a verified final summary.' })
      return task
    })
    return { taskId: task.id, chatId: chat.id, launch: () => enqueue(scope.profileUserId, task.id) }
  },

  /** Restore waiting gates; never automatically repeat an interrupted turn. */
  recover(): void {
    for (const { userId, taskId, checkpoint: saved } of taskRuntimeRepo.list()) {
      if (saved.state === 'completed' || executing.has(keyOf(userId, taskId))) continue
      try {
        owned(userId, taskId)
        if (saved.state === 'running' || saved.state === 'queued') {
          // A crash gives no reliable end time. Charge the unfinished segment
          // through recovery, conservatively including downtime.
          interrupted(userId, taskId, { ...saved, elapsedMs: saved.elapsedMs +
            (saved.activeStartedAt ? Math.max(0, Date.now() - saved.activeStartedAt) : 0) },
          'Execution was interrupted. Review the conversation before resuming; an agent may already have made changes.')
        } else reserve(userId, taskId, saved)
      } catch { taskRunnersByChat.delete(saved.chatId) }
    }
  },

  resume(userId: string, taskId: string): void {
    owned(userId, taskId)
    const saved = checkpoint(userId, taskId)
    if (saved.state !== 'interrupted') throw new Error('Answer waiting questions in the Inbox, or wait for the running task.')
    if (executing.has(keyOf(userId, taskId))) throw new Error('The previous execution is still stopping.')
    getDb().transaction(() => {
      // Recover a partial model batch as historical facts. Missing calls are
      // explicitly not replayed; a recorded gate remains answerable.
      const rows = chatRepo.listMessages(saved.chatId)
      const lastAssistantIndex = rows.findLastIndex((row) => row.role === 'assistant')
      const lastAssistant = rows[lastAssistantIndex]
      const paired = new Set(rows.slice(lastAssistantIndex + 1).filter((row) => row.role === 'tool_call').map((row) => row.toolCallId))
      const gate = saved.gateRequestId ? taskInputRequestRepo.getById(saved.gateRequestId) : null
      for (const call of lastAssistant?.toolCalls ?? []) {
        if (paired.has(call.id)) continue
        const recordedGate = gate?.status === 'open' && saved.gateToolCallId === call.id
        const question = recordedGate && gate.request.kind === 'question' ? gate.request.questions.map((item) => item.question).join('\n') : ''
        messageRepo.saveToolCall({ chatId: saved.chatId, toolCallId: call.id, toolName: call.name, toolInput: call.input,
          toolError: !recordedGate, content: recordedGate ? `Waiting for a human answer: ${question}` : 'Not replayed: the previous execution was interrupted. Review existing work before continuing.' })
        paired.add(call.id)
      }
      const open = taskInputRequestRepo.listOpenForTask(taskId)
      if (open.some((request) => request.deliveryOwner === 'driver' && request.resume === 'reply')) {
        if (saved.lastRunId) taskInputRequestRepo.expireOpenForRun(saved.chatId, saved.lastRunId, true)
      }
      if (taskInputRequestRepo.listOpenForTask(taskId).length) {
        wait(userId, taskId, saved, 'Waiting for a human answer in the Inbox.')
      } else {
        store(userId, taskId, { ...saved, state: 'queued', reason: null, promptOrigin: 'runner', gateRequestId: null, gateToolCallId: null,
          prompt: 'The previous execution was interrupted. Review the saved conversation and existing work before taking new action. Do not repeat completed side effects. Continue toward the task goal.' })
        taskService.applyRunState(userId, taskId, 'working')
      }
    })
    if (checkpoint(userId, taskId).state === 'queued') enqueue(userId, taskId)
  },

  cancel(userId: string, taskId: string): void {
    owned(userId, taskId)
    const active = executing.get(keyOf(userId, taskId))
    if (active) { active.controller.abort(); active.handle?.cancel() }
    else finish(userId, taskId, 'cancelled', null)
  },

  answer(userId: string, requestId: string, resolution: RequestResolution): Promise<InboxAnswerResult> | null {
    const request = taskInputRequestRepo.getById(requestId)
    if (!request) return null
    const saved = taskRuntimeRepo.get(userId, request.taskId)
    if (!saved || saved.state === 'completed') return null
    if (request.deliveryOwner !== 'runner' && request.resume !== 'next_message') return null
    return (async () => {
      try {
        owned(userId, request.taskId)
        if (request.chatId !== saved.chatId || !saved.pendingRequestIds?.includes(requestId)) return { ok: false, code: 'no_longer_waiting', reason: 'This question no longer belongs to the current execution.' }
        if (request.deliveryOwner === 'runner' && saved.gateRequestId !== requestId) return { ok: false, code: 'no_longer_waiting', reason: 'This question no longer belongs to the task checkpoint.' }
        if (request.status !== 'open') return { ok: false, code: 'already_answered', reason: 'This question has already been answered.' }
        if (saved.state !== 'waiting' || executing.has(keyOf(userId, request.taskId))) return { ok: false, code: 'unavailable', reason: 'The task is still settling its turn. Try again shortly.' }
        if (resolution.kind !== 'question' || !resolution.answers.some((answers) => answers.some((answer) => answer.trim()))) return { ok: false, code: 'malformed', reason: 'Enter an answer before sending.' }
        const answer = resolution.answers.map((answers) => answers.join(', ')).join('\n')
        if (answer.length > 64000) return { ok: false, code: 'malformed', reason: 'The answer is too long.' }
        const target = request.agentId ? agents({ profileUserId: userId, settingsUserId: saved.settingsUserId }, saved.chatId)
          .find((agent) => agent.id === request.agentId) : undefined
        if (request.deliveryOwner === 'driver' && !target) return { ok: false, code: 'unavailable', reason: 'The waiting agent is no longer enabled and attached to this conversation.' }
        const toolCallId = nestedToolCallId(request)
        const owner = request.deliveryOwner === 'runner' ? { kind: 'coordinator' as const }
          : { kind: 'agent' as const, agentId: target!.id, name: target!.name, note: '', ...(toolCallId ? { toolCallId } : {}) }
        getDb().transaction(() => {
          if (!taskInputRequestRepo.settle(requestId, 'answered', resolution)) throw new Error('This question has already been answered.')
          store(userId, request.taskId, { ...saved, pendingRequestIds: saved.pendingRequestIds.filter((id) => id !== requestId),
            state: 'queued', reason: null, owner, prompt: answer, promptOrigin: 'user', gateRequestId: null, gateToolCallId: null })
          chatRepo.updateMeta(userId, saved.chatId, { router: owner.kind === 'coordinator' ? 'coordinator' : 'human' })
          taskService.applyRunState(userId, request.taskId, taskInputRequestRepo.listOpenForTask(request.taskId).length ? 'needs_input' : 'working')
        })
        enqueue(userId, request.taskId)
        return { ok: true }
      } catch (error) { return { ok: false, code: 'unavailable', reason: error instanceof Error ? error.message : String(error) } }
    })()
  }
}

installTaskRunnerHooks({
  answer: (userId, requestId, resolution) => taskRunnerService.answer(userId, requestId, resolution),
  chatRemoved: (userId, chatId) => {
    const reservation = taskRunnersByChat.get(chatId)
    if (reservation?.userId !== userId || !taskRuntimeRepo.get(userId, reservation.taskId)) return
    const active = executing.get(keyOf(userId, reservation.taskId))
    try {
      finish(userId, reservation.taskId, 'cancelled', 'The task conversation was deleted.', false, false)
    } catch (error) { logger.warn('deleted conversation task could not be finalized', { taskId: reservation.taskId, error: String(error) }) }
    active?.controller.abort(); active?.handle?.cancel()
    taskRunnersByChat.delete(chatId)
  },
  profileRemoved: (userId) => {
    for (const [chatId, reservation] of taskRunnersByChat) {
      if (reservation.userId !== userId || !taskRuntimeRepo.get(userId, reservation.taskId)) continue
      const active = executing.get(keyOf(userId, reservation.taskId))
      active?.controller.abort(); active?.handle?.cancel()
      taskRunnersByChat.delete(chatId)
    }
  },
  taskChanged: (userId, taskId) => {
    const saved = taskRuntimeRepo.get(userId, taskId)
    if (!saved) {
      const active = executing.get(keyOf(userId, taskId))
      active?.controller.abort(); active?.handle?.cancel()
      for (const [chatId, reservation] of taskRunnersByChat) {
        if (reservation.userId === userId && reservation.taskId === taskId && !reservation.controllerTaskId) taskRunnersByChat.delete(chatId)
      }
      return
    }
    if (saved.state === 'completed') return
    try { owned(userId, taskId) }
    catch {
      const active = executing.get(keyOf(userId, taskId))
      active?.controller.abort(); active?.handle?.cancel()
      taskRunnersByChat.delete(saved.chatId)
      try {
        getDb().transaction(() => {
          taskRuntimeRepo.save(userId, taskId, { ...saved, state: 'interrupted', activeStartedAt: null, reason: 'Execution stopped because this device no longer owns a runnable task.' })
          const task = taskRepo.getById(userId, taskId)
          if (task?.chatId === saved.chatId && chatRepo.getOwned(userId, saved.chatId)) {
            const status = task.deletedAt || ['cancelled', 'archived'].includes(task.status)
              ? 'canceled' : task.status === 'completed' ? 'completed' : task.status === 'error' ? 'failed' : 'needs_input'
            // Metadata edits after an external stop do not produce a new result.
            if (saved.state !== 'interrupted' || chatRunResultRepo.get(userId, saved.chatId)?.status !== status) {
              chatRunResultRepo.record(saved.chatId, nanoid(), status)
            }
          }
        })
      } catch { /* deleted task */ }
    }
  }
})
