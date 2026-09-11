import { nanoid } from 'nanoid'
import { taskInputRequestRepo, type TaskInputRequestRow } from '../db/taskInputRequests'
import { taskRepo, type TaskRow } from '../db/tasks'
import { chatRepo } from '../db/chats'
import { jobRunsRepo } from '../db/jobs'
import { messageRepo } from '../db/messages'
import { agentRepo } from '../db/agents'
import { routerOf } from '../../shared/chatRouting'
import { taskService } from './taskService'
import { deliverAnswer } from './askDelivery'
import { remoteInboxService } from './remoteInboxService'
import { runExecutionService } from './runExecutionService'
import { agentService } from './agentService'
import { getSettingsScopeUserId } from '../auth/scope'
import { createLogger } from '../logger/logger'
import type { RequestResolution } from '../../shared/localAgentRequests'
import type { RunEvent, RunState } from '../../shared/runEvents'
import { ASK_NO_LONGER_WAITING } from '../../shared/inbox'
import type { InboxAnswerResult, InboxEntry } from '../../shared/inbox'
import type { TaskInputRequestStatus } from '../../shared/tasks'

const logger = createLogger('inbox')

/**
 * Persistent human-input requests, answerable with the conversation closed.
 *
 * Reply requests mirror a live driver's pending address and expire at turn end
 * or boot. Next-message requests instead retain the A2A session in SQLite and
 * survive normal turn completion and restart. Their address includes the local
 * turn/child invocation, because a protocol task id may ask again later.
 *
 * Every attributable ask gets a task, creating one for a hand-opened chat when
 * needed. The shared execution service observes events before forwarding them
 * to an optional renderer. Inbox answers and typed messages use the same local
 * acceptance transaction: save the user message, settle this agent's prior
 * request, and validate that this device may continue the task. The driver then
 * runs independently of the view. A refused dispatch preserves the old ask.
 *
 * Stream observation must never throw into execution. The recorder catches
 * bookkeeping errors; explicit answer/admission methods report refusals to the
 * caller. One agent finishing does not consume another agent's next-message ask.
 */

/**
 * How a turn ended, in the run vocabulary.
 *
 * `stopReason` is optional and most drivers omit it, so `done` alone means the
 * turn finished — which is what `taskStatusForRunState` turns into `completed`.
 * A cancel is the one worth telling apart: a stopped turn is not a completed
 * one, and a task marked `completed` because the user pressed Stop is a lie the
 * task list would keep.
 */
function endedAs(event: Extract<RunEvent, { type: 'done' | 'error' }>): RunState {
  if (event.type === 'error' || event.stopReason === 'error' || event.stopReason === 'budget') return 'failed'
  return event.stopReason === 'canceled' ? 'canceled' : 'completed'
}

/** Where a settled ask stands, from what the user (or the registry) decided. */
function settledStatus(resolution: RequestResolution): Exclude<TaskInputRequestStatus, 'open'> {
  // A denied permission and a dismissed question are the user declining, which
  // is an answer. `{kind: 'rejected'}` is the registry settling an ask nobody
  // answered — the park timed out, or the turn ended underneath it — and that
  // is the expiry, not a decision.
  if (resolution.kind === 'rejected') return 'expired'
  if (resolution.kind === 'permission' && resolution.reply === 'reject') return 'rejected'
  return 'answered'
}

function toEntry(row: TaskInputRequestRow, taskTitle: string): InboxEntry {
  return {
    requestId: row.id,
    source: 'local',
    taskId: row.taskId,
    taskTitle,
    chatId: row.chatId,
    agentId: row.agentId,
    request: row.request,
    resume: row.resume,
    createdAt: row.createdAt
  }
}

/** The turn this event belongs to, as much of it as the send path knows. */
export interface RunEventContext {
  userId: string
  chatId: string
  /** Who is answering. Null on the model's own turn; a `child` event names its own. */
  agentId: string | null
  /** Main-owned turn identity, independent of any protocol task id. */
  turnId?: string
  rootRunId?: string
  completionOwner?: 'turn' | 'runner'
}

/**
 * Move a task to where a run state says it is, swallowing anything that goes
 * wrong.
 *
 * Through `applyRunState` rather than `setStatus` on purpose: the run
 * vocabulary and the task vocabulary do not step in lockstep, and a status this
 * task cannot legally reach must be a no-op here rather than a throw inside the
 * stream (see `taskService.applyRunState`). The catch is for everything else —
 * a task claimed by another device, a task deleted mid-turn.
 */
function markTask(userId: string, taskId: string, state: RunState): void {
  try {
    taskService.applyRunState(userId, taskId, state)
  } catch (err) {
    logger.warn('could not record an ask on its task', {
      taskId,
      state,
      error: err instanceof Error ? err.message : String(err)
    })
  }
}

function markAfterAskChange(userId: string, taskId: string): void {
  markTask(userId, taskId, taskInputRequestRepo.listOpenForTask(taskId).length ? 'needs_input' : 'working')
}

/**
 * The task an ask lands on, for a chat that had none — created here, at the
 * first ask, and this is the phase's exit criterion (§5.9).
 *
 * **Why lazily, and why at all.** `task_input_requests.task_id` is `NOT NULL`
 * and it is the scope every read of that table goes through, so until step 11
 * only a job run's chat could hold an ask: one raised in a chat the user opened
 * by hand was answerable in the transcript and **in no list at all**. That is
 * the commonest way a person meets an agent in this app, and "every open ask is
 * in one list" was untrue for exactly it.
 *
 * The three alternatives, and why this one (the user's call, 2026-09-11). A
 * task per *chat* is the plan's eventual target model, but it changes what the
 * word means to a user and multiplies the synced `task` collection by the size
 * of the chats table — a phase 6/7 shape change, not a step. A nullable
 * `task_id` is the smallest change and breaks the one rule the whole phase is
 * built on. Moving the criterion to phase 6 leaves the phase's headline claim
 * untrue.
 *
 * **It is created started.** A fresh task is `new`, and `new → blocked` is not
 * in the transition table — so a task created and left alone would stay `new`
 * while `applyRunState` no-ops, and the row would hang off a task that does not
 * say it is waiting on anybody. `start` takes the legal step through
 * `in_progress`, which is also true: a turn is running, and it is this one.
 *
 * **The goal is the first thing the user said**, not the chat's title. `goal`
 * is the original ask and is immutable once written (`TaskPatch` refuses it),
 * and the title is a forty-character truncation of the same message — so
 * writing the title into both would make the permanent field the lossy one.
 *
 * Null when the chat is gone, which is not a fault: a chat deleted underneath a
 * parked turn leaves an ask nobody can attribute, and the ask itself is still
 * answerable in the transcript that is also gone. Nothing is thrown from here —
 * see this module's header — and the caller treats null exactly as it treated a
 * missing task before.
 */
function taskForChat(ctx: RunEventContext): TaskRow | null {
  const chat = chatRepo.getOwned(ctx.userId, ctx.chatId)
  if (!chat) {
    logger.debug('an ask arrived in a chat that is not there; it stays in the transcript', {
      chatId: ctx.chatId
    })
    return null
  }
  const firstUserMessage = messageRepo.firstByRole(ctx.chatId, 'user')?.content?.trim()
  const agent = ctx.agentId ? agentRepo.getOwned(ctx.userId, ctx.agentId) : null
  const created = taskService.create(ctx.userId, {
    title: chat.title,
    // A chat with no user message at all is reachable — an agent can speak
    // first — and an empty goal is refused by `taskRepo.create`.
    goal: firstUserMessage && firstUserMessage.length > 0 ? firstUserMessage : chat.title,
    // The chat's own router, read through the one helper that knows about the
    // `orchestrated` mirror. A `TaskRouter` is a `ChatRouter` plus `script`,
    // which nothing writes yet (phase 6).
    router: routerOf(chat),
    origin: 'local',
    executor: 'desktop',
    chatId: ctx.chatId,
    // Who is actually answering, which for a `child` event is the nested agent
    // the wrapper named rather than the chat's own root.
    assigneeAgentId: ctx.agentId,
    assigneeName: agent?.name ?? null,
    assigneeKind: ctx.agentId ? 'agent' : 'model'
  })
  taskService.start(ctx.userId, created.id, { chatId: ctx.chatId })
  logger.info('a chat raised its first ask, so it has a task now', {
    chatId: ctx.chatId,
    taskId: created.id
  })
  return taskService.getRow(ctx.userId, created.id)
}

export const inboxService = {
  /**
   * Mirror one run event into the inbox. Called for every event on the send
   * path, before it reaches the renderer. Never throws.
   *
   * Only ask and terminal events change rows; deltas pass through without
   * database work, since they arrive by the thousand.
   */
  recordRunEvent(ctx: RunEventContext, event: RunEvent): void {
    try {
      // A nested agent's ask is still an ask, and the wrapper is the only thing
      // that knows which agent raised it. The orchestrator's own `agentId` (the
      // model, so null) would be the wrong answer.
      if (event.type === 'child') {
        // Only ask and terminal events need the invocation context this allocates:
        // a nested agent's deltas come through here by the thousand.
        const inner = event.event
        if (inner.type === 'needs_input' || inner.type === 'input_resolved' ||
          (ctx.rootRunId && (inner.type === 'done' || inner.type === 'error'))) {
          this.recordRunEvent({ ...ctx, agentId: event.agentId, completionOwner: 'runner',
            turnId: `${ctx.turnId ?? ctx.chatId}:${event.toolCallId}` }, inner)
        }
        return
      }
      if (event.type === 'needs_input') this.openAsk(ctx, event)
      else if (event.type === 'input_resolved') this.closeAsk(ctx, event.requestId, event.resolution)
      // Driver.run has no terminal event. The model's tool pair is the real
      // child ending, including a driver that silently released its parks.
      else if (ctx.rootRunId && (event.type === 'tool_result' || event.type === 'tool_error')) {
        this.endTurn({ ...ctx, turnId: `${ctx.turnId ?? ctx.chatId}:${event.id}`, completionOwner: 'runner' },
          event.type === 'tool_error' ? { type: 'error', error: event.error } : { type: 'done', stopReason: 'end_turn' })
      }
      // A terminal event is the turn saying every address it held is gone —
      // including the ones it abandoned without saying so — and, for a chat
      // that owns its task outright, how the work ended.
      else if (event.type === 'done' || event.type === 'error') this.endTurn(ctx, event)
    } catch (err) {
      logger.warn('an ask could not be recorded', {
        chatId: ctx.chatId,
        type: event.type,
        error: err instanceof Error ? err.message : String(err)
      })
    }
  },

  /** A run parked on a human. The row first, then the task's status. */
  openAsk(ctx: RunEventContext, event: Extract<RunEvent, { type: 'needs_input' }>): void {
    // An attributable ask always has a delivery path: a parked driver address
    // or a new message to the same agent through the main execution service.
    const writesRow = !!ctx.agentId
    const task =
      taskRepo.getByChatId(ctx.userId, ctx.chatId) ?? (writesRow ? taskForChat(ctx) : null)
    if (!task) return

    // The row before the status, deliberately. The ask is the thing the user
    // has to act on; a `blocked` task whose ask was never recorded is a dead
    // end, while a recorded ask on a task that is still `in_progress` is merely
    // a status one beat behind.
    if (ctx.agentId) {
      const requestId = event.resume === 'next_message'
        ? `next-message:${JSON.stringify([ctx.chatId, ctx.agentId, ctx.turnId ?? nanoid(), event.requestId])}`
        : event.requestId
      // A status frame may repeat during a turn. A later turn has a fresh
      // address, so answering an old retained card cannot answer its new ask.
      if (event.resume === 'next_message' && taskInputRequestRepo.getById(requestId)) return
      taskInputRequestRepo.open({
        requestId,
        taskId: task.id,
        chatId: ctx.chatId,
        agentId: ctx.agentId,
        rootRunId: ctx.rootRunId,
        invocationId: ctx.turnId,
        request: event.request,
        resume: event.resume
      })
    } else if (event.resume === 'reply') {
      // An address with nobody to send an answer to. The model does not park,
      // so this is a driver emitting an ask outside a turn the send path could
      // attribute — worth a warning rather than a row nothing can answer.
      logger.warn('a parked ask named no agent; it is not in the inbox', {
        chatId: ctx.chatId,
        requestId: event.requestId
      })
    }

    markTask(ctx.userId, task.id, 'needs_input')
  },

  /**
   * An ask was settled — by the user here, from the transcript, by the engine
   * itself, or by the park timing out.
   *
   * Idempotent: `settle` only touches an open row, so whichever of the two
   * paths (this one, or {@link inboxService.answer} writing directly) lands
   * first wins and the other does nothing.
   */
  closeAsk(ctx: RunEventContext, requestId: string, resolution: RequestResolution): void {
    if (!chatRepo.getOwned(ctx.userId, ctx.chatId)) return
    const row = taskInputRequestRepo.settle(requestId, settledStatus(resolution), resolution,
      { chatId: ctx.chatId, rootRunId: ctx.rootRunId, invocationId: ctx.turnId })
    // Missing/settled rows are harmless. Next-message requests settle through
    // message acceptance, rather than a driver's input_resolved frame.
    if (!row) return
    markAfterAskChange(ctx.userId, row.taskId)
  },

  /**
   * A normal ending expires only live reply addresses; next-message requests
   * survive. Failure/stop also abandons this agent's continuation ask, while
   * another agent's waiting question keeps the enclosing task blocked. A root
   * model cancellation abandons its child asks along with the enclosing turn.
   */
  endTurn(
    ctx: RunEventContext,
    event: Extract<RunEvent, { type: 'done' | 'error' }>
  ): void {
    const normalEnd = event.type === 'done' && (!event.stopReason || event.stopReason === 'end_turn')
    if (!chatRepo.getOwned(ctx.userId, ctx.chatId)) return
    const expired = ctx.rootRunId
      ? taskInputRequestRepo.expireOpenForRun(ctx.chatId, ctx.rootRunId, normalEnd,
          ctx.turnId !== ctx.rootRunId ? ctx.turnId : undefined)
      : taskInputRequestRepo.expireOpenForChat(ctx.chatId, normalEnd, ctx.agentId ?? undefined)
    const task = taskRepo.getByChatId(ctx.userId, ctx.chatId)
    if (expired > 0) {
      logger.info('a turn ended while it was still parked; its asks are expired', {
        chatId: ctx.chatId,
        taskId: task?.id
      })
    }
    if (!task) return
    if (taskInputRequestRepo.listOpenForTask(task.id).length) {
      markTask(ctx.userId, task.id, 'needs_input')
      return
    }

    if (ctx.completionOwner === 'runner') {
      if (expired > 0) markAfterAskChange(ctx.userId, task.id)
      return
    }

    // **A task a job run owns is finished by the job run**, and must be left in
    // `in_progress` for it to find: `jobService.reportRunCompletion` knows the
    // outcome this event cannot — a stop, a refusal, a budget ceiling — and
    // writes it a beat later through the same `applyRunState`. Writing a
    // terminal status here would be a second, worse answer racing the real one.
    const currentJobRun = task.jobRunId ? jobRunsRepo.getByLocalChatId(ctx.chatId) : null
    if (currentJobRun?.taskId === task.id) {
      if (expired > 0) markAfterAskChange(ctx.userId, task.id)
      return
    }

    // **A task this chat made for itself has no such hook, and without this it
    // never ends.** `reportRunCompletion` is keyed on
    // `jobRunsRepo.getByLocalChatId`, which answers nothing for a chat the user
    // opened by hand — so a lazily created task went `in_progress → blocked →
    // in_progress` and stopped there for the life of the profile: listed as
    // running, holding this device's claim, and *synced*, so the user's second
    // device offered Take over on it for ever. One per hand-opened chat that
    // ever raises an ask.
    //
    // The turn's own ending is the outcome here, because for this chat the turn
    // *is* the work. A child ending carries runner ownership, so it can clean up its
    // requests without finishing the coordinator's task.
    markTask(ctx.userId, task.id, endedAs(event))
  },

  hasNextMessage(userId: string, chatId: string): boolean {
    return !!chatRepo.getOwned(userId, chatId) && taskInputRequestRepo.listOpenForChat(chatId)
      .some((row) => row.resume === 'next_message')
  },

  /** A typed chat message and an Inbox answer resume the same waiting turn. */
  resumeChat(ctx: RunEventContext, content: string): void {
    if (!chatRepo.getOwned(ctx.userId, ctx.chatId)) return
    const linked = taskRepo.getByChatId(ctx.userId, ctx.chatId)
    if (linked && ['new', 'refining', 'open', 'in_progress', 'blocked'].includes(linked.status)) {
      const task = taskService.getById(ctx.userId, linked.id)
      if (task.executor !== 'desktop' || !task.runsHere) {
        throw new Error('This task is running elsewhere. Take it over before continuing here.')
      }
    }
    for (const row of taskInputRequestRepo.listOpenForChat(ctx.chatId)) {
      if (row.resume !== 'next_message' || row.agentId !== ctx.agentId) continue
      const task = taskService.getById(ctx.userId, row.taskId)
      if (!['blocked', 'in_progress'].includes(task.status) || task.executor !== 'desktop' || !task.runsHere) {
        throw new Error('This task is no longer waiting for this answer.')
      }
      taskInputRequestRepo.settle(row.id, 'answered', { kind: 'question', answers: [[content]] })
      markAfterAskChange(ctx.userId, row.taskId)
    }
  },

  /** Everything waiting on this profile, newest first. */
  async list(userId: string): Promise<InboxEntry[]> {
    const remote = await remoteInboxService.list(userId)
    const local = taskInputRequestRepo
      .listOpen(userId)
      .filter(({ row }) => {
        if (row.resume === 'reply') return true
        const task = taskService.getById(userId, row.taskId)
        return task.executor === 'desktop' && task.runsHere && ['blocked', 'in_progress'].includes(task.status)
      })
      .map(({ row, taskTitle }) => toEntry(row, taskTitle))
    return [...local, ...remote].sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
  },

  /**
   * Answer an ask from the inbox.
   *
   * The row is settled **here** rather than left to the `input_resolved` event
   * the driver emits: that event rides the turn's port, and the whole point of
   * the inbox is that it is answered when nobody is watching that port. The
   * event still arrives and still settles — at an already-settled row, where it
   * does nothing.
   *
   * Returns data, never throws (see {@link InboxAnswerResult}).
   */
  async answer(userId: string, requestId: string, resolution: RequestResolution): Promise<InboxAnswerResult> {
    if (remoteInboxService.isRemoteAddress(requestId)) {
      return remoteInboxService.answer(userId, requestId, resolution)
    }
    const row = taskInputRequestRepo.getById(requestId)
    if (!row) return { ok: false, reason: ASK_NO_LONGER_WAITING, code: 'no_longer_waiting' }
    // Scoped through the task, because that is where the user id lives — and a
    // soft-deleted task is not a task, so its asks are nobody's.
    const task = taskRepo.getById(userId, row.taskId)
    if (!task || task.deletedAt) {
      return { ok: false, reason: ASK_NO_LONGER_WAITING, code: 'no_longer_waiting' }
    }
    // **`expired` is not `answered`, and the difference is the whole sentence.**
    // A row settled by `endTurn`, by the park timing out or by the boot sweep
    // was never decided by anybody; reporting it as answered over an ask to run
    // `rm -rf build` tells the user somebody allowed it. Both are refusals, and
    // only one of them is a claim about what happened.
    if (row.status === 'expired') {
      return { ok: false, reason: ASK_NO_LONGER_WAITING, code: 'no_longer_waiting' }
    }
    if (row.status !== 'open') {
      return {
        ok: false,
        reason: 'This request has already been answered.',
        code: 'already_answered'
      }
    }
    if (row.resume === 'next_message') {
      if (!['blocked', 'in_progress'].includes(task.status)) {
        taskInputRequestRepo.settle(requestId, 'expired')
        return { ok: false, reason: ASK_NO_LONGER_WAITING, code: 'no_longer_waiting' }
      }
      if (resolution.kind !== 'question' || resolution.answers.length === 0 ||
        !resolution.answers.some((answers) => answers.some((text) => text.trim().length > 0))) {
        return { ok: false, reason: 'Enter an answer before sending.', code: 'malformed' }
      }
      if (!taskService.getById(userId, task.id).runsHere || task.executor !== 'desktop') {
        return { ok: false, reason: 'This task is now running elsewhere.', code: 'not_here' }
      }
      const settingsUserId = getSettingsScopeUserId()
      if (!chatRepo.getOwned(userId, row.chatId) ||
        !agentService.findAgent(settingsUserId, userId, row.agentId)) {
        return { ok: false, reason: 'The conversation or its agent is no longer available.', code: 'not_here' }
      }
      // Check the active owner before consuming the ask. A simultaneous typed
      // answer or another card must not launch a second turn in this chat.
      if (runExecutionService.isRunning(row.chatId)) {
        return { ok: false, reason: 'This conversation is still finishing its turn. Try again shortly.', code: 'unavailable' }
      }
      const content = resolution.answers.map((answers) => answers.join(', ')).join('\n')
      try {
        const handle = runExecutionService.start({ profileUserId: userId, settingsUserId }, {
          chatId: row.chatId, content, addressedAgentId: row.agentId
        }, {
          observe: (ctx, event) => this.recordRunEvent(ctx, event),
          preserveOnRefusal: true,
          agentId: row.agentId,
          onAccepted: (ctx) => this.resumeChat(ctx, content)
        })
        await handle.accepted
        return { ok: true }
      } catch (error) {
        return { ok: false, reason: error instanceof Error ? error.message : 'The answer could not be sent.', code: 'unavailable' }
      }
    }

    const outcome = deliverAnswer(userId, requestId, resolution)
    if (!outcome.ok) {
      // The address is gone — the app restarted under it, the turn was
      // cancelled, the park timed out. The row says so, so the entry stops
      // offering a button whose only outcome is this same message.
      if (outcome.code === 'no_longer_waiting') {
        taskInputRequestRepo.settle(requestId, 'expired')
        markAfterAskChange(userId, row.taskId)
      }
      return outcome
    }

    taskInputRequestRepo.settle(requestId, settledStatus(resolution), resolution)
    markAfterAskChange(userId, row.taskId)
    logger.info('an ask was answered from the inbox', {
      requestId,
      taskId: row.taskId,
      kind: resolution.kind
    })
    return outcome
  }
}
