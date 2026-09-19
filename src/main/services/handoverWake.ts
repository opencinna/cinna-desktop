/**
 * Telling the origin how a handover ended (`drafts/file_handovers` §3.6).
 *
 * A brief may name where it came from: an agent, a chat, a task. When the work
 * reaches an end — a terminal `report.md`, a `blocked` question, or a
 * Cinna-run executor whose turn finished without a report — the chat that asked
 * gets a turn of its own carrying the **return packet**. That is the whole
 * asynchronous loop closing: an agent hands work to a project folder, goes on
 * with something else, and hears back.
 *
 * Three things this module is careful about, each of which was a decision:
 *
 * * **The origin is validated, never trusted.** `origin.chat` is a string out of
 *   a file in a project folder; anything that can write there can write a chat
 *   id. {@link HandoverWakeDeps.chatAnswersToAgent} is the same guard
 *   `followUpTurnService` applies before it opens a turn, and a chat that has
 *   been deleted, trashed or re-pointed is a refusal, not a send.
 * * **A busy chat is waited for, not raced.** The origin is very likely mid-turn
 *   — it is an agent that farmed work out and carried on. The wait loop is
 *   lifted from `followUpTurnService.openOne`, and the per-chat promise chain
 *   is what stops two handovers finishing together from opening two turns in
 *   one conversation.
 * * **A wake never blocks a scan.** Every entry point is fire-and-forget; the
 *   handover's own task and row are already written by the time this runs, so a
 *   failure here costs a notification, never the record of the work.
 */
import {
  buildHandoverGroupPacket,
  buildHandoverReturnPacket,
  type HandoverReportStatus
} from '../../shared/handovers'
import { handoverRepo, type HandoverRow } from '../db/handovers'
import { userActivation } from '../auth/activation'
import { getProfileScopeUserId } from '../auth/scope'
import { createLogger } from '../logger/logger'
import { chatAnswersToAgent } from './chatRouting'
import { createChatTurnQueue } from './handoverChatQueue'
import { inboxService } from './inboxService'
import { runExecutionService, type RunScope } from './runExecutionService'

/** How often a busy origin chat is looked at again. Matches the follow-up service. */
export const HANDOVER_WAKE_POLL_MS = 1_000

/**
 * How long a return packet waits for a busy origin chat.
 *
 * Shorter than the follow-up service's ceiling on purpose: a follow-up is part
 * of the turn that requested it and has to outwait the whole park window, while
 * this is a notification about work that is already finished and recorded. Half
 * an hour of a chat never going idle means something is wrong with that chat,
 * and the task page still has the answer.
 */
export const HANDOVER_WAKE_MAX_WAIT_MS = 30 * 60_000

/** Tests only: shorten the waits. */
export const handoverWakeTimings = {
  pollMs: HANDOVER_WAKE_POLL_MS,
  maxWaitMs: HANDOVER_WAKE_MAX_WAIT_MS
}

export interface HandoverWakeDeps {
  isActive(scope: RunScope): boolean
  isCurrent?(userId: string, rowId: string, expectedDigest: string): boolean
  chatAnswersToAgent(profileUserId: string, chatId: string, agentId: string): string | null
  isRunning(chatId: string): boolean
  /** Start the turn that carries the packet. Resolves once the row is persisted. */
  send(scope: RunScope, chatId: string, content: string): Promise<{ runId: string }>
  /** Record the outcome on the row — `wokeAt`/`wakeRunId`, or a warning. */
  record(userId: string, rowId: string, patch: { wokeAt?: Date; wakeRunId?: string; warning?: string }, expectedDigest?: string): void
  logger: { debug(msg: string, meta?: unknown): void; info(msg: string, meta?: unknown): void; warn(msg: string, meta?: unknown): void }
  now(): number
  delay(ms: number): Promise<void>
}

/** What the origin is being told about. */
export interface HandoverWakeInput {
  scope: RunScope
  onSettled?: () => void
  row: HandoverRow
  status: HandoverReportStatus
  summary: string
  question?: string | null
  artifacts?: string[]
  body?: string
  /** Channel-specific return instructions, composed by the delegation bus. */
  packet?: string
  expectedDigest?: string
}

/**
 * A whole fan-out group reaching its end at once (§3.7).
 *
 * `rows` is what the packet speaks for — every member still to be reported, in
 * scan order — and the first of them names the chat and the agent. The service
 * decides *when* a group is complete; this module only knows how to tell
 * somebody.
 */
export interface HandoverGroupWakeInput {
  scope: RunScope
  onSettled?: () => void
  groupId: string
  rows: HandoverRow[]
  expectedDigests?: Record<string, string>
}

export function createHandoverWake(deps: HandoverWakeDeps) {
  /**
   * One turn per origin chat at a time.
   *
   * Two handovers in the same project finishing in the same scan is ordinary —
   * a fan-out is the point of the feature — and `runExecutionService.start`
   * refuses a chat that already has a turn running. The queue is what turns
   * that refusal into a wait, and it is shared with the revision sender, which
   * has exactly the same problem from the other end.
   */
  const queue = createChatTurnQueue({
    isRunning: (chatId) => deps.isRunning(chatId),
    now: () => deps.now(),
    delay: (ms) => deps.delay(ms),
    timings: handoverWakeTimings
  })

  async function deliver(input: HandoverWakeInput, chatId: string, agentId: string): Promise<void> {
    const { scope, row } = input

    // The routing guard is re-checked here, after the wait: a chat deleted
    // while the queue held this packet is exactly where it matters.
    if (!deps.isActive(scope)) return
    if (input.expectedDigest && deps.isCurrent && !deps.isCurrent(row.userId, row.id, input.expectedDigest)) return
    const refusal = deps.chatAnswersToAgent(scope.profileUserId, chatId, agentId)
    if (refusal) {
      deps.record(row.userId, row.id, { warning: `wake_refused:${refusal}` }, input.expectedDigest)
      return
    }

    const packet = input.packet ?? buildHandoverReturnPacket({
      handoverId: row.handoverId,
      folderPath: row.folderPath,
      taskId: row.taskId,
      status: input.status,
      summary: input.summary,
      question: input.question,
      artifacts: input.artifacts,
      body: input.body
    })

    try {
      const { runId } = await deps.send(scope, chatId, packet)
      deps.record(row.userId, row.id, { wokeAt: new Date(deps.now()), wakeRunId: runId }, input.expectedDigest)
      deps.logger.info('an origin chat was told how its handover ended', {
        id: row.id,
        chatId,
        status: input.status
      })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      deps.logger.warn('a return packet could not be delivered', { id: row.id, chatId, message })
      deps.record(row.userId, row.id, { warning: `wake_failed:${message}` }, input.expectedDigest)
    }
  }

  async function deliverGroup(input: HandoverGroupWakeInput, chatId: string, agentId: string): Promise<void> {
    const { rows } = input
    if (!deps.isActive(input.scope)) return
    if (deps.isCurrent && rows.some((row) => input.expectedDigests?.[row.id] && !deps.isCurrent!(row.userId, row.id, input.expectedDigests[row.id]))) return
    const refusal = deps.chatAnswersToAgent(input.scope.profileUserId, chatId, agentId)
    if (refusal) {
      // Recorded on every member, not just the first: each row is what its own
      // task page shows, and "the group was told" is not true of any of them.
      for (const row of rows) deps.record(row.userId, row.id, { warning: `wake_refused:${refusal}` }, input.expectedDigests?.[row.id])
      return
    }

    const packet = buildHandoverGroupPacket({
      groupId: input.groupId,
      members: rows.map((row) => ({
        handoverId: row.handoverId,
        state: row.state,
        summary: row.summary,
        taskId: row.taskId
      }))
    })

    try {
      const { runId } = await deps.send(input.scope, chatId, packet)
      const wokeAt = new Date(deps.now())
      for (const row of rows) deps.record(row.userId, row.id, { wokeAt, wakeRunId: runId }, input.expectedDigests?.[row.id])
      deps.logger.info('an origin chat was told how a whole handover group ended', {
        groupId: input.groupId,
        chatId,
        members: rows.length
      })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      deps.logger.warn('a group packet could not be delivered', { groupId: input.groupId, chatId, message })
      for (const row of rows) deps.record(row.userId, row.id, { warning: `wake_failed:${message}` }, input.expectedDigests?.[row.id])
    }
  }

  return {
    /**
     * Tell the origin, if there is one. **Never throws and never blocks the
     * caller**: the handover's task and row are already written, so everything
     * from here is a notification, and a scan that awaited it would hold every
     * other folder behind one busy conversation.
     *
     * A handover with no origin — or one whose origin did not resolve at intake
     * — is a *human-origin* handover (§3.5). It runs exactly the same way and
     * simply has nobody to wake, so this returns without a warning: there is no
     * failure to report.
     */
    wake(input: HandoverWakeInput): void {
      const chatId = input.row.originChatId
      const agentId = input.row.originAgentId
      if (!chatId || !agentId) return

      queue.enqueue(chatId, {
        send: async () => {
          try {
            await deliver(input, chatId, agentId)
          } catch (error) {
            deps.logger.warn('a handover wake failed outright', {
              id: input.row.id,
              error: error instanceof Error ? error.message : String(error)
            })
          } finally {
            input.onSettled?.()
          }
        },
        onTimedOut: () => {
          deps.logger.warn('an origin chat never went idle; the return packet was dropped', {
            id: input.row.id,
            chatId
          })
          deps.record(input.row.userId, input.row.id, { warning: 'wake_timed_out' }, input.expectedDigest)
          input.onSettled?.()
        }
      })
    },

    /**
     * Tell the origin once for a whole group (§3.7).
     *
     * Same queue, same guards, same silence for a human origin — the only
     * difference is the packet and that `woke_at` lands on every member, so no
     * later scan tells that chat about the same handovers again.
     */
    wakeGroup(input: HandoverGroupWakeInput): void {
      const first = input.rows[0]
      if (!first) return
      const chatId = first.originChatId
      const agentId = first.originAgentId
      if (!chatId || !agentId) return

      queue.enqueue(chatId, {
        send: async () => {
          try {
            await deliverGroup(input, chatId, agentId)
          } catch (error) {
            deps.logger.warn('a handover group wake failed outright', {
              groupId: input.groupId,
              error: error instanceof Error ? error.message : String(error)
            })
          } finally {
            input.onSettled?.()
          }
        },
        onTimedOut: () => {
          deps.logger.warn('an origin chat never went idle; the group packet was dropped', {
            groupId: input.groupId,
            chatId
          })
          for (const row of input.rows) deps.record(row.userId, row.id, { warning: 'wake_timed_out' }, input.expectedDigests?.[row.id])
          input.onSettled?.()
        }
      })
    },

    /** Tests only: has every queued wake settled? */
    idle: () => queue.idle()
  }
}

export type HandoverWake = ReturnType<typeof createHandoverWake>

// ---------------------------------------------------------------------------
// The production wiring
// ---------------------------------------------------------------------------

/**
 * Static imports, deliberately.
 *
 * `runExecutionService` and `inboxService` are already in this feature's import
 * graph — `handoverService` reaches both through `taskExecutionService` — so
 * naming them here adds no cycle, and `isRunning` has to be answerable
 * synchronously inside the wait loop anyway.
 */
export const handoverWake = createHandoverWake({
  chatAnswersToAgent,
  isActive: (scope) => userActivation.isActivated() && getProfileScopeUserId() === scope.profileUserId,
  isRunning: (chatId) => runExecutionService.isRunning(chatId),
  async send(scope, chatId, content) {
    const handle = runExecutionService.start(scope, { chatId, content }, {
      observe: (ctx, event) => inboxService.recordRunEvent(ctx, event),
      // Neither a typed user message nor a runner prompt: a system row that
      // reads as "this came back from somewhere else". `runnerTaskId` is
      // deliberately absent — a return packet belongs to the **origin's** chat,
      // not to the handover's task, and attributing it to that task would put
      // the packet's asks on the wrong task's Inbox rows.
      inputOrigin: 'handover'
    })
    await handle.accepted
    return { runId: handle.id }
  },
  record(userId, rowId, patch) {
    handoverRepo.update(userId, rowId, patch)
  },
  logger: createLogger('handover-wake'),
  now: () => Date.now(),
  delay: (ms) =>
    new Promise((resolve) => {
      const timer = setTimeout(resolve, ms)
      timer.unref?.()
    })
})
