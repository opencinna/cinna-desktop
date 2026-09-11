import { taskInputRequestRepo, type TaskInputRequestRow } from '../db/taskInputRequests'
import { taskRepo } from '../db/tasks'
import { taskService } from './taskService'
import { deliverAnswer } from './askDelivery'
import { createLogger } from '../logger/logger'
import type { RequestResolution } from '../../shared/localAgentRequests'
import type { RunEvent } from '../../shared/runEvents'
import { ASK_NO_LONGER_WAITING } from '../../shared/inbox'
import type { InboxAnswerResult, InboxEntry } from '../../shared/inbox'
import type { TaskInputRequestStatus } from '../../shared/tasks'

const logger = createLogger('inbox')

/**
 * The inbox — every ask waiting on a human, in one list, answerable with the
 * chat closed.
 *
 * ## Two registries, and only one of them is the truth the user sees
 *
 * `agentTurn/pendingRequests` is the **live address**: an in-memory entry
 * inside the driver process that is parked on the ask, which dies with the
 * turn and with the app. `task_input_requests` is the **record**: it outlives
 * the chat view, survives a navigation, and is what the inbox renders. They are
 * written at the same moment and settled at the same moment, and this service
 * is the only place that knows about both.
 *
 * The inbox never reads `pendingRequests` to build a list (the plan's first
 * risk). It reads it exactly once, at the moment of answering, because that is
 * when "is this address still live" is the question being asked.
 *
 * ## What gets a row
 *
 * A `reply` ask — parked, answerable *now*, by request id. A `next_message`
 * ask (A2A `input-required`) writes **no row**: the protocol ended the turn and
 * the answer is the user's next message in the chat, so a row would be a button
 * with nothing behind it. Its task is marked `blocked`, but only until the turn
 * that asked reports how it ended — **and for A2A that ending is a success**,
 * because ending the turn *is* how the protocol asks. So
 * `jobService.reportRunCompletion` immediately walks the task on to
 * `completed`, and a job run whose agent is waiting for a reply reads as
 * finished.
 *
 * That is a real gap and it is deliberately left open here: closing it means
 * mirroring the run's *state* onto the task (a `status` event per A2A
 * status-update, on a path that has no task index), or teaching
 * `reportRunCompletion` that a blocked task stays blocked — which on its own
 * would strand the task in `blocked` for ever, since nothing would move it back
 * when the user's next message resumes the work. It belongs with step 11, where
 * the A2A/remote path folds onto the adapter. Recorded in the phase file.
 *
 * An ask in a chat with no task also writes no row — the table's `task_id` is
 * the scope every read goes through, and a plain chat the user opened by hand
 * has no task until a later phase gives every chat one. Such an ask stays
 * answerable in the transcript, exactly as it was before this phase.
 *
 * ## Nothing here is allowed to throw into a stream
 *
 * {@link inboxService.recordRunEvent} runs inside the turn's event pump, ahead
 * of `port.postMessage`. A throw from it would surface as a failure of the
 * *turn* — the ask would never reach the renderer and the agent would sit
 * parked — so every path through it is caught and logged. Bookkeeping is not
 * allowed to break the work it is recording, the same rule
 * `jobService.reportRunCompletion` follows for the same reason.
 */

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
function markTask(userId: string, taskId: string, state: 'needs_input' | 'working'): void {
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

export const inboxService = {
  /**
   * Mirror one run event into the inbox. Called for every event on the send
   * path, before it reaches the renderer. Never throws.
   *
   * Only two of the eleven `RunEvent` types do any work; the rest cost one
   * comparison, which matters because deltas come through here by the thousand.
   */
  recordRunEvent(ctx: RunEventContext, event: RunEvent): void {
    try {
      // A nested agent's ask is still an ask, and the wrapper is the only thing
      // that knows which agent raised it. The orchestrator's own `agentId` (the
      // model, so null) would be the wrong answer.
      if (event.type === 'child') {
        // Only the two types that do work are worth the object this allocates:
        // a nested agent's deltas come through here by the thousand.
        const inner = event.event
        if (inner.type === 'needs_input' || inner.type === 'input_resolved') {
          this.recordRunEvent({ ...ctx, agentId: event.agentId }, inner)
        }
        return
      }
      if (event.type === 'needs_input') this.openAsk(ctx, event)
      else if (event.type === 'input_resolved') this.closeAsk(ctx, event.requestId, event.resolution)
      // A terminal event is the turn saying every address it held is gone —
      // including the ones it abandoned without saying so.
      else if (event.type === 'done' || event.type === 'error') this.endTurn(ctx)
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
    const task = taskRepo.getByChatId(ctx.userId, ctx.chatId)
    if (!task) {
      logger.debug('an ask arrived in a chat with no task; it stays in the transcript', {
        chatId: ctx.chatId
      })
      return
    }

    // The row before the status, deliberately. The ask is the thing the user
    // has to act on; a `blocked` task whose ask was never recorded is a dead
    // end, while a recorded ask on a task that is still `in_progress` is merely
    // a status one beat behind.
    if (event.resume === 'reply' && ctx.agentId) {
      taskInputRequestRepo.open({
        requestId: event.requestId,
        taskId: task.id,
        chatId: ctx.chatId,
        agentId: ctx.agentId,
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
    const row = taskInputRequestRepo.settle(requestId, settledStatus(resolution), resolution)
    // No row: a `next_message` ask, an ask in a chat with no task, or one this
    // service has already settled. None of them is a fault, and none of them
    // changes a task's status — the answer path did that already.
    if (!row) return
    markTask(ctx.userId, row.taskId, 'working')
  },

  /**
   * The turn ended. Anything it was still parked on died with it.
   *
   * **A driver does not always announce the asks it abandons.** The ACP driver
   * closes the turn before releasing its parks, and `input_resolved` is gated on
   * the turn being open — so a Stop, the turn ceiling and a crash all settle the
   * registry in silence. An ask recorded by such a turn would otherwise stay
   * open until the next restart, offering a button whose only outcome is "no
   * longer waiting for an answer".
   *
   * Only a **top-level** ending sweeps, never a `child`'s: a coordinator can
   * have several agents in flight in one chat, and one of them finishing says
   * nothing about what another is parked on.
   *
   * A task left `blocked` by an ask that has just died is no longer waiting for
   * anybody, so it goes back to `in_progress` — which is also the state
   * `jobService.reportRunCompletion` needs to find it in a beat later, when it
   * writes the outcome the run actually had.
   */
  endTurn(ctx: RunEventContext): void {
    if (taskInputRequestRepo.expireOpenForChat(ctx.chatId) === 0) return
    const task = taskRepo.getByChatId(ctx.userId, ctx.chatId)
    logger.info('a turn ended while it was still parked; its asks are expired', {
      chatId: ctx.chatId,
      taskId: task?.id
    })
    if (task) markTask(ctx.userId, task.id, 'working')
  },

  /** Everything waiting on this profile, newest first. */
  list(userId: string): InboxEntry[] {
    return taskInputRequestRepo
      .listOpen(userId)
      .map(({ row, taskTitle }) => toEntry(row, taskTitle))
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
  answer(userId: string, requestId: string, resolution: RequestResolution): InboxAnswerResult {
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
    if (row.resume !== 'reply') {
      // Unreachable while only `reply` asks get rows, and here so that stays
      // true out loud: a `next_message` ask is answered by writing in the chat,
      // and there is no address for this path to post to.
      return {
        ok: false,
        reason: 'Open the conversation to answer this one.',
        code: 'not_here'
      }
    }

    const outcome = deliverAnswer(userId, requestId, resolution)
    if (!outcome.ok) {
      // The address is gone — the app restarted under it, the turn was
      // cancelled, the park timed out. The row says so, so the entry stops
      // offering a button whose only outcome is this same message.
      if (outcome.code === 'no_longer_waiting') {
        taskInputRequestRepo.settle(requestId, 'expired')
      }
      return outcome
    }

    taskInputRequestRepo.settle(requestId, settledStatus(resolution), resolution)
    markTask(userId, row.taskId, 'working')
    logger.info('an ask was answered from the inbox', {
      requestId,
      taskId: row.taskId,
      kind: resolution.kind
    })
    return outcome
  }
}
