/**
 * Delivering a `revisions/NNN.md` to the executor (`drafts/file_handovers`
 * §3.2, §3.7 — phase 4).
 *
 * The requester's half of a handover does not end when the brief is written. It
 * may come back — "also retry 429", "the ticket moved, do the other branch" —
 * and the contract's answer is a new immutable file beside the brief. This
 * module is what puts that file in front of the executor: **a new turn on the
 * handover's own chat**, so the ACP session, the folder and everything the
 * agent already read are still there and the revision lands as a follow-up
 * rather than as a second task.
 *
 * It is the mirror image of `handoverWake`, and shares its wait loop
 * (`handoverChatQueue`): there the origin chat is busy because the requester
 * carried on, here the executor's chat is busy because it is still working. In
 * both cases `runExecutionService.start` refuses a chat with a live turn, so
 * the send waits for the chat instead of racing it.
 *
 * **Never blocks a scan, never throws at one.** Whether the turn is accepted or
 * refused, the revision is on disk and the row records what happened.
 */
import type { HandoverRow } from '../db/handovers'
import { handoverRepo } from '../db/handovers'
import { createLogger } from '../logger/logger'
import { chatAnswersToAgent } from './chatRouting'
import { createChatTurnQueue } from './handoverChatQueue'
// Type-only, and therefore no cycle at runtime: `handoverService` imports this
// module for its sender, and this one names only the shape of a turn's end.
import type { HandoverTurnOutcome } from './handoverService'
import { HANDOVER_WAKE_MAX_WAIT_MS, HANDOVER_WAKE_POLL_MS } from './handoverWake'
import { inboxService } from './inboxService'
import { runExecutionService, type RunScope } from './runExecutionService'

/** Tests only: shorten the waits. Same numbers as the wake, for the same reasons. */
export const handoverRevisionTimings = {
  pollMs: HANDOVER_WAKE_POLL_MS,
  maxWaitMs: HANDOVER_WAKE_MAX_WAIT_MS
}

export interface HandoverRevisionDeps {
  /** Why this chat may not be addressed by this agent, or null. `chatRouting`. */
  chatAnswersToAgent(profileUserId: string, chatId: string, agentId: string): string | null
  isRunning(chatId: string): boolean
  /**
   * Start the revision's turn. Resolves once it is accepted, and hands back the
   * turn's own end — a revision is a turn like any other, and whoever started
   * the handover has to hear how it finished (see {@link
   * HandoverRevisionSendInput.watch}).
   */
  send(
    scope: RunScope,
    chatId: string,
    content: string
  ): Promise<{ runId: string; completed: Promise<HandoverTurnOutcome> }>
  record(userId: string, rowId: string, patch: { warning?: string; runId?: string }): void
  logger: { info(msg: string, meta?: unknown): void; warn(msg: string, meta?: unknown): void }
  now(): number
  delay(ms: number): Promise<void>
}

export interface HandoverRevisionSendInput {
  scope: RunScope
  row: HandoverRow
  /** The handover task's chat — the one the executor is already talking in. */
  chatId: string
  /** The file being delivered, for the log and nothing else. */
  file: string
  /** Built by `buildHandoverRevisionTurn`, so this module stays free of wording. */
  content: string
  /**
   * Follow this turn, as `handoverService` follows the first one.
   *
   * Handed the turn's `completed` the moment the send is accepted. Without it
   * a revision left the row `running` behind a turn nobody was watching: the
   * executor finished without writing a report, no outcome was ever applied,
   * and two minutes later the lost-run sweep closed the task as "the app
   * closed" while the app was open (§3.6). Optional so a caller that only
   * wants the delivery — a test, a future one-way sender — need not care.
   */
  watch?: (completed: Promise<HandoverTurnOutcome>) => void
  /**
   * Called instead of {@link watch} when there will be no turn at all: the chat
   * no longer answers to this agent, the start was refused, or the chat never
   * went idle.
   *
   * `handoverService` counts the revisions a row is still owed a turn for and
   * holds the task open until the last of them has ended, so a revision that is
   * never going to arrive has to say so — otherwise the row would stay
   * `running` waiting for it. The reason is the same string the row's warning
   * carries, for the caller's log and nothing else.
   */
  onNotSent?: (reason: string) => void
}

export function createHandoverRevisions(deps: HandoverRevisionDeps) {
  const queue = createChatTurnQueue({
    isRunning: (chatId) => deps.isRunning(chatId),
    now: () => deps.now(),
    delay: (ms) => deps.delay(ms),
    timings: handoverRevisionTimings
  })

  async function deliver(input: HandoverRevisionSendInput): Promise<void> {
    const { row, chatId } = input
    // Checked after the wait, not before it: the chat can be deleted while a
    // revision sits in the queue, and that is the case worth catching.
    const refusal = deps.chatAnswersToAgent(input.scope.profileUserId, chatId, row.agentId)
    if (refusal) {
      deps.record(row.userId, row.id, { warning: `revision_send_failed:${refusal}` })
      input.onNotSent?.(refusal)
      return
    }

    try {
      const { runId, completed } = await deps.send(input.scope, chatId, input.content)
      // The run id moves to the revision's turn: it is the live one now, and
      // the lost-run sweep reads the row's state, not this column.
      deps.record(row.userId, row.id, { runId })
      // Recorded first, watched second: the watcher's continuation writes the
      // row too, and it must not find the run id of the turn before this one.
      input.watch?.(completed)
      deps.logger.info('a handover revision was delivered', { id: row.id, file: input.file, chatId })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      deps.logger.warn('a handover revision could not be delivered', { id: row.id, file: input.file, message })
      deps.record(row.userId, row.id, { warning: `revision_send_failed:${message}` })
      input.onNotSent?.(message)
    }
  }

  return {
    /**
     * Send one revision, behind anything else queued for that chat.
     *
     * Fire-and-forget by design: the caller is a folder scan, and the chat may
     * be busy for the length of a turn. The row was already marked as having
     * delivered this file — see `handoverService` — so a scan a minute later
     * does not queue it a second time while this one waits.
     */
    send(input: HandoverRevisionSendInput): void {
      queue.enqueue(input.chatId, {
        send: async () => {
          try {
            await deliver(input)
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error)
            deps.logger.warn('a handover revision send failed outright', { id: input.row.id, error: message })
            input.onNotSent?.(message)
          }
        },
        onTimedOut: () => {
          deps.logger.warn('an executor chat never went idle; the revision was not sent', {
            id: input.row.id,
            file: input.file
          })
          deps.record(input.row.userId, input.row.id, { warning: 'revision_send_timed_out' })
          input.onNotSent?.('revision_send_timed_out')
        }
      })
    },

    /** Tests only: has every queued revision settled? */
    idle: () => queue.idle()
  }
}

export type HandoverRevisionSender = ReturnType<typeof createHandoverRevisions>

// ---------------------------------------------------------------------------
// The production wiring
// ---------------------------------------------------------------------------

export const handoverRevisions = createHandoverRevisions({
  chatAnswersToAgent,
  isRunning: (chatId) => runExecutionService.isRunning(chatId),
  async send(scope, chatId, content) {
    const handle = runExecutionService.start(scope, { chatId, content }, {
      observe: (ctx, event) => inboxService.recordRunEvent(ctx, event),
      // The same origin the return packet uses: desktop-authored text that is
      // neither a person typing nor a runner prompt. `runnerTaskId` is absent
      // for the same reason — the turn belongs to the handover's own chat, and
      // its asks are already that task's.
      inputOrigin: 'handover'
    })
    await handle.accepted
    return { runId: handle.id, completed: handle.completed }
  },
  record(userId, rowId, patch) {
    handoverRepo.update(userId, rowId, patch)
  },
  logger: createLogger('handover-revisions'),
  now: () => Date.now(),
  delay: (ms) =>
    new Promise((resolve) => {
      const timer = setTimeout(resolve, ms)
      timer.unref?.()
    })
})
