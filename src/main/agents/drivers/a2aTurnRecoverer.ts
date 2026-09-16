/**
 * Relaunch recovery for the `a2a` driver: ask the agent, through `tasks/get`,
 * how a turn the app was closed under ended (cinna-core's recovery contract).
 *
 * - No user row, no agent, no endpoint, no task id → interrupted. A turn
 *   killed before its first event has no task id, and a first message sent
 *   again without one is not deduplicated: it would start a second session.
 * - Credentials that need the user (a re-auth, or a 401/403 from a Cinna
 *   agent's card or `tasks/get`, in the plan or while polling) → deferred
 *   (`auth`), marker kept. Any other agent's refused `tasks/get` is a wrong
 *   token → interrupted.
 * - A server that cannot be reached (the card, the endpoint or the first
 *   `tasks/get` fails with a transport drop or a 408, 429 or 5xx, or the
 *   endpoint, the token, the card and that read take longer than
 *   {@link PLAN_TIMEOUT_MS} together) → deferred (`network`), marker kept,
 *   and nothing shown: the service retries later.
 * - A backend that answers but cannot report the turn (older Cinna, other
 *   A2A servers) → interrupted.
 * - Still running → polled, with a live "still running" line. Each poll
 *   client resolves the token again, and a refused poll is retried once with
 *   a fresh one; a refusal after that, or drops (or 408/429/5xx answers)
 *   that outlast the poll's patience, defer the turn after all (`auth` / `network`;
 *   a refusal of any other agent settles it as interrupted).
 * - Finished, our message found → its rows replace what the kill left, and
 *   the session's `task_state` becomes the collected state (as a live turn's
 *   end saves it), unless the chat has moved on past the turn.
 * - Finished, our message found with no agent reply after it (none, or only
 *   empty parts) → whatever rows the kill left stay (an empty history must
 *   not wipe them). A turn that ended any way but a stop or an ask lost its
 *   reply on the server (a backend crash its orphan repair closed): it
 *   settles as cut off, as a live turn does, with the cut-off card under the
 *   kept rows — also when the kill left none, so it never ends silently.
 *   Not when a later message follows ours and the agent answered after it
 *   (one reply may cover both): that turn reads completed.
 * - Finished with a reply that may be cut off (any ending but an answer or
 *   an ask, or a last message still `streaming`; `isCutOff`) that holds less
 *   than the rows the kill left (`serverCopyWins`) → those rows stay, with
 *   the server's state and its card (cut off for `aborted`, the task failure
 *   for `failed`) under them.
 * - Finished, our message not there → the send never arrived: sent again
 *   with the same `messageId` and task id — unless the history came back
 *   full (our message may just be older than it), or the turn already has
 *   rows (they prove it arrived; the service refuses the resend), which
 *   settle as interrupted.
 * - Stop → `tasks/cancel`, one more `tasks/get`, and whatever it has (the
 *   rows the kill left, when it has no reply or a thinner one).
 *
 * Takes the credential resolution by injection, as the driver does: the
 * production functions name Electron.
 */
import type { A2AClient } from '@a2a-js/sdk/client'
import { A2aHttpError } from '../a2a-client'
import type { AgentRow } from '../../db/agents'
import { agentSessionRepo } from '../../db/agents'
import { agentService } from '../../services/agentService'
import { createA2AClient } from '../a2a-client'
import { collectTask, readTask, replyLost, serverCopyWins, type CollectedTask, type TaskGetter, type TaskRead } from '../a2aTaskCollect'
import { isTransientHttpStatus, isTransportDrop } from '../a2aTransport'
import { a2aInputRequestOf } from '../../services/a2aStreamingService'
import { capabilitiesFor } from './capabilities'
import { authRejectionStatus } from './a2aErrors'
import { createLogger } from '../../logger/logger'
import {
  CUT_OFF_NOTICE,
  REPLY_CUT_OFF_CODE,
  STILL_RUNNING_NOTICE,
  TASK_FAILED_MESSAGE,
  type RecoveryIO,
  type RecoveryResult,
  type TurnRecoverer
} from '../../services/turnRecoverers'
import type { RecoveredRow, TurnEndNotice } from '../../db/inflightTurns'
import type { TurnOutcome } from '../../services/turnCompletion'

const logger = createLogger('A2A')

/** How long the plan phase waits for the card and the first `tasks/get` together. */
export const PLAN_TIMEOUT_MS = 30_000
/** How long a Stop waits for its client, `tasks/cancel` and the last read. */
const STOP_TIMEOUT_MS = 30_000

export interface A2aRecovererDeps {
  /** `resolveEndpointIfNeeded` — may throw a re-auth. */
  resolveEndpoint(userId: string, agent: AgentRow): Promise<string | null>
  /** `resolveAccessToken` — may throw a re-auth. */
  resolveAccessToken(userId: string, agent: AgentRow): Promise<string | undefined>
  /** Whether an error is `CinnaReauthRequired`. */
  isReauthRequired(err: unknown): boolean
  /** Bound on the plan phase; {@link PLAN_TIMEOUT_MS} when omitted. */
  planTimeoutMs?: number
}

/** `promise`, or a rejection with `signal.reason` once `signal` aborts first. */
function within<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason)
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => reject(signal.reason)
    signal.addEventListener('abort', onAbort, { once: true })
    promise.then(
      (value) => { signal.removeEventListener('abort', onAbort); resolve(value) },
      (err) => { signal.removeEventListener('abort', onAbort); reject(err) }
    )
  })
}

type Collected = Extract<CollectedTask, { supported: true }>

const errorText = (err: unknown): string => (err instanceof Error ? err.message : String(err))

/** The turn's rows as the agent has them, in transcript order. */
function rowsOf(collected: Collected, options: { failed: boolean }): RecoveredRow[] {
  const rows: RecoveredRow[] = collected.notices.map((notice) => ({ role: 'agent_transition', content: notice.text }))
  if (collected.parts.length) {
    rows.push({
      role: 'assistant',
      content: collected.text || collected.parts.map((part) => part.text).join(''),
      parts: collected.parts
    })
  }
  // A cut-off reply says so in a readable card; that card is also the
  // failure, so a failed turn does not get a second one.
  if (collected.lastAgentState === 'aborted') {
    rows.push({ role: 'error', short: CUT_OFF_NOTICE, detail: null, code: REPLY_CUT_OFF_CODE })
  } else if (options.failed) {
    rows.push({ role: 'error', short: TASK_FAILED_MESSAGE, detail: `The agent’s task ended as ${collected.state}.` })
  }
  return rows
}

/** Where a settled turn's A2A state is saved: the (chat, agent) session. */
interface SessionKey {
  chatId: string
  agentId: string
  taskId: string
}

/** Save the collected state on the session, keeping its context and task ids. */
function saveStateOf(session: SessionKey, state: string): () => void {
  return () => agentSessionRepo.upsert({ chatId: session.chatId, agentId: session.agentId, contextId: null, taskId: null, taskState: state })
}

const CUT_OFF_CARD: TurnEndNotice = { short: CUT_OFF_NOTICE, code: REPLY_CUT_OFF_CODE }
/** The task-failed card, with the code a live turn's task failure carries. */
const TASK_FAILED_CARD: TurnEndNotice = { short: TASK_FAILED_MESSAGE, code: 'agent_task_failed' }

/**
 * What goes under rows kept in place of the server's copy: the cut-off card
 * for a reply the agent cut off, else the task-failed card when the turn
 * settles as failed (the card its own rows would have carried).
 */
function keptEnding(collected: Collected, options: { failed: boolean }): { notice?: TurnEndNotice } {
  if (collected.state === 'aborted' || collected.lastAgentState === 'aborted') return { notice: CUT_OFF_CARD }
  return options.failed ? { notice: TASK_FAILED_CARD } : {}
}

/**
 * Whether the rows the kill left stay instead of the server's copy: they
 * exist, and the server has no reply or a cut-off one thinner than them.
 */
function keepsRows(collected: Collected, io: RecoveryIO): boolean {
  return io.hasRows() && !serverCopyWins(collected, io.savedOutputSize())
}

/**
 * A finished turn the agent has: its rows, its outcome, and the ask it ended
 * on — or the rows the kill left, when the server's copy is no better (see
 * the module note).
 */
function collectedResult(collected: Collected, session: SessionKey, io: RecoveryIO): RecoveryResult {
  if (replyLost(collected)) {
    logger.info('the agent has no reply for the turn; ending it as cut off', { chatId: session.chatId, state: collected.state })
    return {
      kind: 'collected',
      outcome: { state: 'failed', text: '', error: { message: CUT_OFF_NOTICE, code: REPLY_CUT_OFF_CODE } },
      rows: [],
      keepRows: { notice: CUT_OFF_CARD },
      // As a live turn saves a reply cut off.
      onSettled: saveStateOf(session, 'aborted')
    }
  }
  if (keepsRows(collected, io)) {
    if (collected.hasReply) logger.info('the agent’s cut-off reply holds less than the rows the kill left; keeping them', { chatId: session.chatId, state: collected.state })
    const result = collectedOutcome(collected, session.taskId)
    return {
      ...result,
      rows: [],
      keepRows: keptEnding(collected, { failed: result.outcome.state === 'failed' }),
      onSettled: saveStateOf(session, collected.state)
    }
  }
  return { ...collectedOutcome(collected, session.taskId), onSettled: saveStateOf(session, collected.state) }
}

function collectedOutcome(collected: Collected, taskId: string): Extract<RecoveryResult, { kind: 'collected' }> {
  const text = collected.text
  // A reply the agent marks cut off is a failure whatever the task says
  // (`collectTask` reports its state as `aborted`).
  if (collected.state === 'aborted' || collected.lastAgentState === 'aborted') {
    return {
      kind: 'collected',
      outcome: { state: 'failed', text, error: { message: CUT_OFF_NOTICE, code: REPLY_CUT_OFF_CODE } },
      rows: rowsOf(collected, { failed: true })
    }
  }
  switch (collected.state) {
    case 'completed':
      return { kind: 'collected', outcome: { state: 'completed', text }, rows: rowsOf(collected, { failed: false }) }
    case 'canceled':
      return { kind: 'collected', outcome: { state: 'canceled', text }, rows: rowsOf(collected, { failed: false }) }
    case 'input-required':
    case 'auth-required': {
      const request = a2aInputRequestOf(collected.state, collected.lastAgentMessage)!
      return {
        kind: 'collected',
        outcome: { state: 'needs_input', text },
        rows: rowsOf(collected, { failed: false }),
        ask: { requestId: taskId, request }
      }
    }
    default:
      // `failed`, `rejected`, and any state A2A adds later.
      return {
        kind: 'collected',
        outcome: { state: 'failed', text, error: { message: TASK_FAILED_MESSAGE } },
        rows: rowsOf(collected, { failed: true })
      }
  }
}

/** Stop pressed during recovery: cancel the task, then keep what the agent has. */
async function stopTurn(connect: (signal: AbortSignal) => Promise<A2AClient>, session: SessionKey, clientMessageId: string,
  io: RecoveryIO): Promise<RecoveryResult> {
  const { taskId } = session
  const canceled: TurnOutcome = { state: 'canceled', text: '' }
  // Its own bound: the run's signal is already aborted.
  const signal = AbortSignal.timeout(STOP_TIMEOUT_MS)
  let client: A2AClient
  try {
    client = await connect(signal)
  } catch (err) {
    logger.warn('no client to cancel a recovered task with', { taskId, error: errorText(err) })
    return { kind: 'kept', outcome: canceled }
  }
  try {
    await client.cancelTask({ id: taskId })
  } catch (err) {
    logger.warn('cancelTask failed during recovery', { taskId, error: errorText(err) })
  }
  // One read, no polling: a task still working after the cancel keeps the
  // rows the kill left.
  const once = new AbortController()
  let collected: CollectedTask | null = null
  try {
    collected = await collectTask({ client, taskId, clientMessageId, signal: once.signal, onPoll: () => once.abort() })
  } catch {
    collected = null
  }
  if (!collected?.supported || !collected.found) return { kind: 'kept', outcome: canceled }
  // No reply on the server, or a thinner one than the kill left: whatever
  // the kill left is all there is.
  if (!collected.hasReply || keepsRows(collected, io)) {
    return { kind: 'collected', outcome: canceled, rows: [], keepRows: keptEnding(collected, { failed: false }), onSettled: saveStateOf(session, collected.state) }
  }
  return {
    kind: 'collected',
    outcome: { ...canceled, text: collected.text },
    rows: rowsOf(collected, { failed: false }),
    onSettled: saveStateOf(session, collected.state)
  }
}

export function createA2aTurnRecoverer(deps: A2aRecovererDeps): TurnRecoverer {
  return {
    async plan(marker, scope) {
      const clientMessageId = marker.userMessageId
      if (!clientMessageId) return { kind: 'interrupted', reason: 'the turn has no user message' }
      const located = agentService.findAgent(scope.settingsUserId, marker.profileId, marker.agentId)
      if (!located || !located.row.cardUrl) return { kind: 'interrupted', reason: 'the agent is gone' }
      const { row: agent, userId: ownerId } = located
      const cardUrl = agent.cardUrl!
      const taskId = agentSessionRepo.getByChatAndAgent(marker.chatId, marker.agentId)?.taskId
      if (!taskId) return { kind: 'interrupted', reason: 'the turn never reached the agent' }

      const cinna = capabilitiesFor(agent).auth === 'cinna'
      /** A refused read: a Cinna session the user can renew, or a wrong token. */
      const refused = (): { kind: 'defer'; reason: 'auth' } | { kind: 'interrupted'; reason: string } =>
        cinna ? { kind: 'defer', reason: 'auth' } : { kind: 'interrupted', reason: 'the agent refused its access token' }
      const needsSignIn = (err: unknown): boolean => deps.isReauthRequired(err) || (cinna && authRejectionStatus(err) !== undefined)
      // The endpoint, the token, the card fetch and the first read share one
      // bound: a server that hangs is a server that cannot be reached now.
      const planSignal = AbortSignal.timeout(deps.planTimeoutMs ?? PLAN_TIMEOUT_MS)
      let endpointUrl: string
      let client: A2AClient
      try {
        const endpoint = await within(deps.resolveEndpoint(ownerId, agent), planSignal)
        if (!endpoint) return { kind: 'interrupted', reason: 'the agent has no endpoint' }
        endpointUrl = endpoint
        const accessToken = await within(deps.resolveAccessToken(ownerId, agent), planSignal)
        client = await createA2AClient(endpointUrl, cardUrl, accessToken, planSignal)
      } catch (err) {
        if (needsSignIn(err)) {
          logger.info('recovery waits for the Cinna session', { chatId: marker.chatId })
          return { kind: 'defer', reason: 'auth' }
        }
        if (isTransportDrop(err) || isTransientHttpStatus(err) || planSignal.aborted) {
          logger.info('recovery waits for the agent', { chatId: marker.chatId, error: errorText(err) })
          return { kind: 'defer', reason: 'network' }
        }
        return { kind: 'interrupted', reason: `the agent could not be reached: ${errorText(err)}` }
      }

      // Asked once before the turn is shown as running: a server that cannot
      // be reached, or refuses the session, leaves the marker for later.
      const first: TaskRead = await readTask(client, taskId, { transientStatusUnreachable: true })
      const failure = 'failed' in first ? first.failed : undefined
      if (failure === 'unreachable') return { kind: 'defer', reason: 'network' }
      if (failure === 'unauthorized') return refused()
      if (failure) return { kind: 'interrupted', reason: 'the agent cannot report the turn' }

      const session: SessionKey = { chatId: marker.chatId, agentId: marker.agentId, taskId }
      /** A client bound to `signal`, with the token resolved now. */
      const connect = async (signal: AbortSignal): Promise<A2AClient> =>
        createA2AClient(endpointUrl, cardUrl, await deps.resolveAccessToken(ownerId, agent), signal)

      return {
        kind: 'recover',
        async recover(io: RecoveryIO): Promise<RecoveryResult> {
          // Polls go through a client bound to the run's signal, so Stop
          // ends a hung request, built on first use and again after a
          // refusal. A token that cannot be had reads as a refusal.
          let pollClient: A2AClient | null = null
          const getter: TaskGetter = {
            async getTask(params) {
              if (!pollClient) {
                try {
                  pollClient = await connect(io.signal)
                } catch (err) {
                  if (deps.isReauthRequired(err) || authRejectionStatus(err) !== undefined) {
                    throw new A2aHttpError(401, 'Unauthorized', cardUrl)
                  }
                  throw err
                }
              }
              return pollClient.getTask(params)
            }
          }
          let collected: CollectedTask
          try {
            collected = await collectTask({
              client: getter,
              taskId,
              clientMessageId,
              signal: io.signal,
              initial: first,
              transientStatusUnreachable: true,
              renewClient: () => { pollClient = null },
              onPoll: () => io.notice(STILL_RUNNING_NOTICE)
            })
          } catch (err) {
            if (!io.signal.aborted) throw err
            return stopTurn(connect, session, clientMessageId, io)
          }
          if (io.signal.aborted) return stopTurn(connect, session, clientMessageId, io)
          if (!collected.supported) {
            if (collected.reason === 'unauthorized') return refused()
            if (collected.reason === 'unreachable') return { kind: 'defer', reason: 'network' }
            return { kind: 'interrupted' }
          }
          if (!collected.found) {
            if (collected.historyFull) {
              logger.info('the interrupted message is not in a full history; not sending it again', { chatId: marker.chatId, taskId })
              return { kind: 'interrupted' }
            }
            logger.info('the interrupted message never reached the agent; sending it again', { chatId: marker.chatId, taskId })
            return { kind: 'resent', outcome: await io.resend() }
          }
          return collectedResult(collected, session, io)
        }
      }
    }
  }
}
