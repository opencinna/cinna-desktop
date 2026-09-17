/**
 * Turns an agent starts on its own, between the user's turns, shown and saved
 * as runs of the chat.
 *
 * Claude over ACP answers "I'll watch CI in the background and merge", its
 * prompt returns, and minutes later the CLI polls, merges and says "Merged." —
 * a turn nobody prompted. The driver notices it (`acp/acpFollowUp.ts`) and
 * asks for it here with a {@link FollowUpRequest}. This service decides
 * whether and when it opens, and runs it through the same machinery as a sent
 * turn:
 *
 * - **Guards.** The chat still exists, is the profile's, is not in the trash,
 *   and still answers to the agent — its root agent, or an agent attached to a
 *   `human` chat. Otherwise the request is abandoned: its asks are refused, its
 *   traffic dropped, and the session no longer listened to. The guard also
 *   covers an observer re-armed by a turn that ended after the chat's router
 *   changed.
 * - **A busy chat waits**, as relaunch recovery does: behind the chat's run,
 *   then polled while a task runner or a handoff holds it, up to
 *   {@link FOLLOW_UP_MAX_WAIT_MS}; past it the held traffic is dropped, but
 *   the session stays listened to. A turn of the same session that the user
 *   starts meanwhile takes the held traffic (`wanted()` turns false) and
 *   nothing is opened.
 * - **The run** is `runExecutionService.adopt` — spinner, live view, Stop, the
 *   queue for messages sent meanwhile — and `drive` is the direct-chat wrapper
 *   `a2aStreamingService.streamToAgent`: the rows (an assistant turn, no user
 *   row), the in-flight marker, the draft, the quit-time save and the cursor
 *   are a sent turn's. `drive` then records the result as `start`'s close
 *   does — the sidebar's unread result and the job run through
 *   `recordTurnResult`, the terminal event through the Inbox observer — so a
 *   chat that is not on screen reads "Completed — unread results" as for any
 *   finished turn.
 * - **One chat at a time.** Requests for one chat run in order; two follow-ups
 *   in a row are two runs.
 */
import { nanoid } from 'nanoid'
import { chatRepo } from '../db/chats'
import { chatOnDemandAgentRepo } from '../db/chatOnDemandAgent'
import { chatAgentCursorRepo } from '../db/chatAgentCursors'
import { messageRepo } from '../db/messages'
import { routingOf } from '../../shared/chatRouting'
import { REQUEST_PARK_TIMEOUT_MS } from '../../shared/localAgentRequests'
import { createLogger } from '../logger/logger'
import type { FollowUpRequest } from '../agents/drivers/driver'
import type { RunEvent } from '../../shared/runEvents'
import { a2aStreamingService, type StreamPort } from './a2aStreamingService'
import { inboxService } from './inboxService'
import { activeRunsByChat } from './runExecutionState'
import { remainingRunRequests, runExecutionService, type RunHandle } from './runExecutionService'
import { recordTurnResult, terminalEventOf } from './turnRecord'
import type { TurnOutcome } from './turnCompletion'

const logger = createLogger('follow-up-turn')

/** How often a chat a task runner or a handoff holds is looked at again. */
export const FOLLOW_UP_BUSY_POLL_MS = 1_000

/**
 * How long a follow-up waits for a busy chat before it is abandoned. The
 * agent's turn is running meanwhile, and its traffic is held (bounded) until
 * then; twenty minutes matches the turn ceiling.
 */
// Matches `ACP_TURN_CEILING_MS`: a chat parked on an ask for the whole park window
// is still busy, and the follow-up must outwait it.
export const FOLLOW_UP_MAX_WAIT_MS = REQUEST_PARK_TIMEOUT_MS + 20 * 60_000

/** Tests only: shorten the waits. */
export const followUpTimings = { pollMs: FOLLOW_UP_BUSY_POLL_MS, maxWaitMs: FOLLOW_UP_MAX_WAIT_MS }

const NO_OUTCOME: TurnOutcome = { state: 'failed', text: '', error: { message: 'The follow-up turn ended without an outcome.' } }

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/** Why the chat may not show this follow-up, or null when it may. */
function refusal(request: FollowUpRequest): string | null {
  const chat = chatRepo.getOwned(request.scope.profileUserId, request.chatId)
  if (!chat) return 'the chat is gone'
  if (chat.deletedAt) return 'the chat is in the trash'
  const routing = routingOf(chat)
  if (routing.rootAgentId === request.agentId) return null
  if (routing.router === 'human' && chatOnDemandAgentRepo.listAgentIds(request.chatId).includes(request.agentId)) return null
  return 'the chat no longer answers to this agent'
}

function abandon(request: FollowUpRequest, reason: string, options?: { keepListening: true }): void {
  logger.info('a follow-up turn was not opened', { chatId: request.chatId, agentId: request.agentId, reason })
  try {
    if (options) request.abandon(reason, options)
    else request.abandon(reason)
  } catch (err) {
    logger.warn('a follow-up turn could not be abandoned cleanly', { chatId: request.chatId, error: errorText(err) })
  }
}

const delay = (ms: number): Promise<void> => new Promise((resolve) => {
  const timer = setTimeout(resolve, ms)
  timer.unref?.()
})

/** The run that shows and saves one follow-up turn. */
function adopt(request: FollowUpRequest): RunHandle {
  const { chatId, agentId, scope } = request
  const runId = nanoid()
  return runExecutionService.adopt(scope, {
    chatId,
    agentId,
    runId,
    observe: (ctx, event) => inboxService.recordRunEvent(ctx, event)
  }, async (io) => {
    let outcome: TurnOutcome | null = null
    let terminalSeen = false
    // Every event is recorded, then posted — the asks for the Inbox, the
    // terminal event for the task the chat owns — as `start`'s port does.
    const port: StreamPort = {
      postMessage(event: RunEvent) {
        if (event.type === 'done' || event.type === 'error') terminalSeen = true
        io.observe(event)
      },
      close() {}
    }
    await a2aStreamingService.streamToAgent({
      run: (turnIo) => request.run(turnIo),
      chatId,
      agentId,
      port,
      onFinished: (finished) => { outcome ??= finished },
      marker: { profileId: scope.profileUserId, userMessageId: null, driver: request.driverId },
      // The agent wrote these rows itself: it has seen everything up to them.
      onCompleted: () => {
        const last = messageRepo.lastId(chatId)
        if (last) chatAgentCursorRepo.advance(chatId, agentId, last)
      }
    })
    const result: TurnOutcome = outcome ?? NO_OUTCOME
    if (!terminalSeen) io.observe(terminalEventOf(result))
    const remaining = remainingRunRequests(chatId, runId)
    const recorded = {
      ...result,
      state: result.state === 'completed' && remaining.inputRequestIds.length ? 'needs_input' as const : result.state,
      ...(remaining.inputRequestReadError ? { inputRequestReadError: remaining.inputRequestReadError } : {})
    }
    recordTurnResult(chatId, runId, recorded, { canceled: io.signal.aborted })
    return result
  })
}

async function openOne(request: FollowUpRequest): Promise<void> {
  const started = Date.now()
  let handle: RunHandle | null = null
  while (!handle) {
    if (!request.wanted()) {
      logger.info('a follow-up turn is no longer wanted', { chatId: request.chatId, agentId: request.agentId })
      return
    }
    const refused = refusal(request)
    if (refused) return abandon(request, refused)
    const active = activeRunsByChat.get(request.chatId)
    if (active) {
      // Behind whatever holds the chat now; its outcome is not ours to read.
      await active.completed.catch(() => undefined)
      continue
    }
    try {
      handle = adopt(request)
    } catch (err) {
      // A task runner, a handoff, or a run that started between the check
      // and here. Looked at again shortly, for a while.
      if (Date.now() - started >= followUpTimings.maxWaitMs) {
        // The chat still answers to the agent: its session stays listened to.
        return abandon(request, `the chat stayed busy: ${errorText(err)}`, { keepListening: true })
      }
      await delay(followUpTimings.pollMs)
    }
  }
  logger.info('a follow-up turn opened', { chatId: request.chatId, agentId: request.agentId, runId: handle.id })
  const outcome = await handle.completed
  logger.info('a follow-up turn ended', { chatId: request.chatId, agentId: request.agentId, state: outcome.state })
}

/** Each chat's follow-ups, one after another. */
const chains = new Map<string, Promise<void>>()

export const followUpTurnService = {
  /**
   * Open a follow-up turn for `request`, when the chat may show it and is
   * free. Returns at once; never throws. The returned promise (tests await
   * it) settles once the turn has ended or was not opened.
   */
  open(request: FollowUpRequest): Promise<void> {
    const previous = chains.get(request.chatId) ?? Promise.resolve()
    const next = previous.then(() => openOne(request)).catch((err: unknown) => {
      logger.error('a follow-up turn failed to open', { chatId: request.chatId, error: errorText(err) })
      abandon(request, 'opening it failed')
    })
    chains.set(request.chatId, next)
    void next.finally(() => { if (chains.get(request.chatId) === next) chains.delete(request.chatId) })
    return next
  }
}
