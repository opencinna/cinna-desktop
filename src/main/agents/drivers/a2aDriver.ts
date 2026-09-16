/**
 * The `a2a` driver: an agent reached over A2A — hand-added by URL, or synced
 * from the user's Cinna account — through `runAgentTurn`, unchanged.
 *
 * What this driver adds around the runner is the pre-flight that used to sit
 * twice around it, once in the chat IPC handler and once in the orchestrator's
 * agent tool: the card check, the endpoint and token resolution, the Cinna
 * re-auth mapping, whether a stream-level 401 is a re-auth, and telling the
 * agent to cancel its task when the turn is stopped. Both call sites now get
 * the same sentences and the same cancel.
 *
 * Takes its world by injection. `CinnaReauthRequired` in particular arrives as
 * a predicate rather than an import: its module names Electron, and the golden
 * tests drive this driver without it.
 */
import type { A2AClient } from '@a2a-js/sdk/client'
import type { AgentRow } from '../../db/agents'
import type { A2ARunAgentTurnInput, RunAgentTurnResult } from '../../services/a2aStreamingService'
import { A2aHttpError, AgentCardFetchError, humanizeA2AError } from '../a2a-client'
import { AgentError } from '../../errors'
import { createLogger } from '../../logger/logger'
import {
  CINNA_REAUTH_REQUIRED_CODE,
  CINNA_SESSION_EXPIRED_MESSAGE
} from '../../../shared/cinnaErrors'
import { capabilitiesFor } from './capabilities'
import { authRejectionStatus } from './a2aErrors'
import type { AgentDriver, AgentReadiness } from './driver'

const logger = createLogger('A2A')

/** A row with no card to reach the agent through. The chat handler's sentence. */
export const AGENT_NOT_CONFIGURED = 'Agent not found or not configured'
/** A resolution that answered "there is none" for an agent that needs one. */
export const NO_ENDPOINT_CONFIGURED = 'This agent has no endpoint configured.'

/** How long readiness waits on a card before calling the agent unreachable. */
export const A2A_READINESS_TIMEOUT_MS = 5_000

/** How long a stopped turn waits for the `tasks/cancel` answer. */
export const CANCEL_ANSWER_WAIT_MS = 500
/** How much longer it waits for the one `tasks/get` a cancel answered without a state asks for. */
export const CANCEL_READ_WAIT_MS = 1_000

export interface A2aDriverDeps {
  /** `runAgentTurn`. */
  runTurn(input: A2ARunAgentTurnInput): Promise<RunAgentTurnResult>
  /** `resolveEndpointIfNeeded` — may throw `AgentError` or a re-auth. */
  resolveEndpoint(userId: string, agent: AgentRow): Promise<string | null>
  /** `resolveAccessToken` — may throw a re-auth. */
  resolveAccessToken(userId: string, agent: AgentRow): Promise<string | undefined>
  /** `fetchAgentCard`, for readiness. Must not write anything. */
  fetchCard(cardUrl: string, accessToken?: string): Promise<unknown>
  /** Whether an error is `CinnaReauthRequired`. */
  isReauthRequired(err: unknown): boolean
  /** Override {@link A2A_READINESS_TIMEOUT_MS}. Tests only. */
  readinessTimeoutMs?: number
  /**
   * `agentSessionRepo.upsert`, for the state a confirmed Stop leaves the task
   * in: a stopped turn skips the end-of-turn session save.
   */
  saveTaskState?(patch: { chatId: string; agentId: string; taskId: string; taskState: string }): void
}

function fail(message: string, raw?: string, code?: string): RunAgentTurnResult {
  return {
    text: '',
    parts: [],
    notices: [],
    error: code ? { message, raw: raw ?? message, code } : { message, raw: raw ?? message }
  }
}

const errorText = (err: unknown): string => (err instanceof Error ? err.message : String(err))

class ReadinessTimeout extends Error {}

/** Stop waiting without cancelling a credential refresh shared by other runs. */
function resolveForTurn<T>(signal: AbortSignal, resolveValue: () => Promise<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    signal.throwIfAborted()
    const abort = (): void => reject(signal.reason)
    signal.addEventListener('abort', abort, { once: true })
    Promise.resolve().then(() => {
      signal.throwIfAborted()
      return resolveValue()
    }).then(resolve, reject).finally(() => signal.removeEventListener('abort', abort))
  })
}

const canceled = (): RunAgentTurnResult => ({ text: '', parts: [], notices: [], taskState: 'canceled' })

/** `result.status.state` of a JSON-RPC answer, read defensively: older backends answer `{"result":{}}`. */
function answeredState(response: unknown): { answered: boolean; state?: string } {
  if (!response || typeof response !== 'object' || !('result' in response)) return { answered: false }
  const result = (response as { result?: { status?: { state?: unknown } } | null }).result
  const state = result?.status?.state
  return { answered: true, ...(typeof state === 'string' ? { state } : {}) }
}

const isStopConfirmed = (state: string | undefined): boolean => state === 'canceled' || state === 'completed'

/** Wait for `promise`, or `ms`, whichever comes first. Never rejects on its own. */
async function waitAtMost(promise: Promise<unknown>, ms: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    await Promise.race([promise, new Promise<void>((resolve) => { timer = setTimeout(resolve, ms) })])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

export function createA2aDriver(deps: A2aDriverDeps): AgentDriver {
  return {
    id: 'a2a',

    capabilities: (agent) => capabilitiesFor(agent),

    async run(userId, agent, input) {
      const { chatId, wireContent, fileIds, signal, onEvent } = input
      if (signal.aborted) return canceled()

      // **Not "no card, so not an agent".** A folder agent is inserted with
      // `cardUrl: null`, and a combined `!agent || !agent.cardUrl` guard in the
      // chat handler once matched every folder agent and made its branch
      // unreachable for a whole phase. That cannot recur here: only an A2A row
      // reaches this driver, and for it a missing card really is a
      // misconfiguration.
      if (!agent.cardUrl) {
        logger.error(AGENT_NOT_CONFIGURED, { agentId: agent.id, chatId, cardUrl: agent.cardUrl })
        return fail(AGENT_NOT_CONFIGURED)
      }
      const cardUrl = agent.cardUrl

      let endpointUrl: string | null
      try {
        endpointUrl = await resolveForTurn(signal, () => deps.resolveEndpoint(userId, agent))
      } catch (err) {
        if (signal.aborted) return canceled()
        const isReauth = deps.isReauthRequired(err)
        const message = isReauth
          ? CINNA_SESSION_EXPIRED_MESSAGE
          : err instanceof AgentError
            ? err.message
            : `Failed to resolve agent endpoint: ${errorText(err)}`
        logger.error(message, { agentId: agent.id, cardUrl, reauth: isReauth })
        return fail(message, String(err), isReauth ? CINNA_REAUTH_REQUIRED_CODE : undefined)
      }
      if (endpointUrl === null) {
        // An A2A agent with no endpoint is a misconfiguration, not a kind of
        // agent — say so rather than fail obscurely at the SDK call.
        logger.error(NO_ENDPOINT_CONFIGURED, { agentId: agent.id, source: agent.source })
        return fail(NO_ENDPOINT_CONFIGURED)
      }

      let accessToken: string | undefined
      try {
        accessToken = await resolveForTurn(signal, () => deps.resolveAccessToken(userId, agent))
      } catch (err) {
        if (signal.aborted) return canceled()
        const isReauth = deps.isReauthRequired(err)
        const message = isReauth
          ? CINNA_SESSION_EXPIRED_MESSAGE
          : `Failed to resolve agent access token: ${errorText(err)}`
        logger.error(message, { agentId: agent.id, reauth: isReauth })
        return fail(message, String(err), isReauth ? CINNA_REAUTH_REQUIRED_CODE : undefined)
      }

      // A stop that landed during the resolution above. The message has not
      // gone out yet, so there is nothing to cancel and nothing to send: this
      // is a stopped turn that streamed nothing.
      if (signal.aborted) return canceled()

      // When the turn is stopped, also tell the agent to cancel its task —
      // otherwise it keeps running server-side after we stop reading the
      // stream. The client and the live task id arrive through the turn's
      // callbacks; the listener runs at the moment of the abort, so it sends
      // exactly once, and only when there is a task to cancel.
      let client: A2AClient | undefined
      let taskId: string | undefined
      let cancelSent = false
      /** The state that confirmed the stop (`canceled` or `completed`), once one did. */
      let confirmedState: string | undefined
      let cancelAttempt: Promise<void> | undefined
      /** The `tasks/get` a cancel answered without a state asked for, once it is asked. */
      let cancelRead: Promise<void> | undefined
      const onAbort = (): void => {
        if (!signal.aborted || cancelSent || !client || !taskId) return
        cancelSent = true
        const id = taskId
        const cancelClient = client
        logger.info('Sending cancelTask to agent', { taskId: id })
        cancelAttempt = cancelClient
          .cancelTask({ id })
          .then((answer) => {
            const read = answeredState(answer)
            // A cancel that lands before the agent said anything is answered
            // `completed` by an older Cinna backend: the task is not running
            // either way, so both count as a confirmed stop.
            if (read.state !== undefined) {
              if (isStopConfirmed(read.state)) confirmedState = read.state
              return
            }
            if (!read.answered) return
            // An older Cinna backend answers the cancel with an empty result.
            // One `tasks/get` says whether the task stopped; no polling. Only
            // `canceled` counts there: the same backend's `tasks/get` still
            // reports the previous turn's `completed` for a turn stopped
            // before its first output.
            cancelRead = cancelClient.getTask({ id })
              .then((task) => {
                const state = answeredState(task).state
                logger.debug('cancelTask answered no state; read the task instead', { taskId: id, state })
                if (state === 'canceled') confirmedState = state
              })
              .catch((err) => logger.warn('reading a canceled task failed', { taskId: id, error: String(err) }))
          })
          .catch((err) => logger.warn('cancelTask failed', { taskId: id, error: String(err) }))
      }
      signal.addEventListener('abort', onAbort, { once: true })

      try {
        const result = await deps.runTurn({
          chatId,
          agentId: agent.id,
          agentName: agent.name,
          endpointUrl,
          cardUrl,
          accessToken,
          wireContent,
          fileIds,
          ...(input.messageId ? { messageId: input.messageId } : {}),
          // Synced agents authenticate with a Cinna-issued JWT — a stream-level
          // 401/403 means the server revoked the session and the user needs to
          // re-auth. A hand-added agent's token is one the user typed, so a
          // 401 there is just a wrong-token error, not a re-auth signal.
          isCinnaTokenAuth: capabilitiesFor(agent).auth === 'cinna',
          signal,
          onEvent,
          ...(input.registerSnapshot ? { registerSnapshot: input.registerSnapshot } : {}),
          // A turn collected after a drop can outlast its token; a refused
          // poll asks for a fresh one. A sign-in the user has to make reads
          // as the refusal it is.
          renewAccessToken: async () => {
            try {
              return await resolveForTurn(signal, () => deps.resolveAccessToken(userId, agent))
            } catch (err) {
              if (deps.isReauthRequired(err)) throw new A2aHttpError(401, 'Unauthorized', cardUrl)
              throw err
            }
          },
          onClient: (c) => {
            client = c
            onAbort()
          },
          onTaskId: (id) => {
            taskId = id
            onAbort()
          }
        })
        // The cancel answer gets `CANCEL_ANSWER_WAIT_MS`; one that came back
        // in time without a state, `CANCEL_READ_WAIT_MS` more for its read.
        if (signal.aborted && cancelAttempt) {
          await waitAtMost(cancelAttempt, CANCEL_ANSWER_WAIT_MS)
          if (cancelRead) await waitAtMost(cancelRead, CANCEL_READ_WAIT_MS)
        }
        if (signal.aborted && confirmedState && taskId && deps.saveTaskState) {
          try {
            deps.saveTaskState({ chatId, agentId: agent.id, taskId, taskState: confirmedState })
          } catch (err) {
            logger.warn('could not save the state of a stopped task', { chatId, taskId, error: errorText(err) })
          }
        }
        if (signal.aborted && !confirmedState) {
          result.notices = [...result.notices, { partKey: `a2a-stop-${chatId}`, text: 'Stopped waiting locally. The remote agent’s stop was not confirmed; check its task before starting more work.' }]
        }
        return result
      } finally {
        signal.removeEventListener('abort', onAbort)
      }
    },

    /**
     * Whether the agent answers at all: its card, fetched with its token.
     *
     * Asked while a list renders, so it is bounded, writes no resolved
     * endpoint and raises no re-auth UI. An expired Cinna session is a *state*
     * here (`not_logged_in`); the prompt to sign in again belongs to the
     * surface that shows it. A disabled row is probed like any other: whether
     * to ask is the caller's decision.
     *
     * **Not free of side effects for a synced agent.** Its token comes from
     * `getCinnaAccessToken`, which refreshes the stored session near expiry —
     * and clears it when the refresh is refused. That is what a turn does too,
     * and skipping the refresh would be worse: an access token that merely
     * expired would read as `not_logged_in` and the composer would refuse an
     * agent that works.
     */
    async readiness(userId, agent) {
      const synced = capabilitiesFor(agent).auth === 'cinna'
      const check = async (): Promise<AgentReadiness> => {
        if (!agent.cardUrl) {
          return {
            state: 'invalid',
            reason: 'This agent has no card URL. Add one in Settings → Agents.'
          }
        }

        let accessToken: string | undefined
        try {
          accessToken = await deps.resolveAccessToken(userId, agent)
        } catch (err) {
          if (deps.isReauthRequired(err)) {
            return {
              state: 'not_logged_in',
              reason: CINNA_SESSION_EXPIRED_MESSAGE,
              detail: errorText(err)
            }
          }
          return {
            state: 'invalid',
            reason: 'This agent’s access token could not be read.',
            detail: errorText(err)
          }
        }

        await deps.fetchCard(agent.cardUrl, accessToken)
        return { state: 'ok', reason: null }
      }
      try {
        // **One bound around the whole check, the token included.** A synced
        // agent's token resolve can refresh the Cinna session over the network,
        // and that request has no bound of its own: outside this one, a token
        // endpoint that accepted the connection and never answered held a
        // list-time slot for ever, and every check queued behind it — a folder
        // agent's refusal the user had just fixed, say — waited with it.
        return await withTimeout(check(), deps.readinessTimeoutMs ?? A2A_READINESS_TIMEOUT_MS)
      } catch (err) {
        return cardFailure(err, synced, deps)
      }
    },

    // A2A ends the turn to ask; the answer is the user's next message, which
    // goes through `run`. Nothing is ever parked on this driver.
    respond: () => ({ delivered: false })
  }
}

/**
 * What a failed card fetch says about the agent.
 *
 * `reason` is a short sentence in the user's words: it sits beside a disabled
 * Send, truncated to the width that is left, so the part that helps — what is
 * wrong, the status, where to fix it — comes first and no URL leads it.
 * `detail` keeps the underlying error, URL and network code included, for the
 * tooltip. (The raw strings were shown on screen at first: "fetch failed", or
 * a card URL cut off before the status that explained it.)
 *
 * **Null for a card that did not answer inside the check's bound.** The card
 * fetch a turn makes has no bound of its own, so a slow agent still answers a
 * turn; refusing one on a timeout would make readiness stricter than the thing
 * it predicts.
 */
function cardFailure(
  err: unknown,
  synced: boolean,
  deps: Pick<A2aDriverDeps, 'isReauthRequired'>
): AgentReadiness | null {
  if (err instanceof ReadinessTimeout) return null
  const detail = humanizeA2AError(err)
  if (deps.isReauthRequired(err)) {
    return { state: 'not_logged_in', reason: CINNA_SESSION_EXPIRED_MESSAGE, detail }
  }
  const rejected = authRejectionStatus(err)
  if (rejected !== undefined) {
    return synced
      ? { state: 'not_logged_in', reason: CINNA_SESSION_EXPIRED_MESSAGE, detail }
      : {
          state: 'credentials_needed',
          reason: `The agent refused its access token (${rejected}). Check it in Settings → Agents.`,
          detail
        }
  }
  // The server answered, and the card is not there (4xx): the URL is wrong.
  // A 5xx is the server failing, which is as good as not reaching it.
  if (err instanceof AgentCardFetchError) {
    return err.status >= 500
      ? { state: 'unreachable', reason: `The agent’s server returned an error (${err.status}).`, detail }
      : { state: 'invalid', reason: `There is no agent card at this address (${err.status}).`, detail }
  }
  // `fetch` rejects with a `TypeError` when the socket never opens.
  if (err instanceof TypeError) {
    return { state: 'unreachable', reason: 'Can’t reach this agent.', detail }
  }
  // A card that arrived but offers no protocol this build speaks.
  return { state: 'invalid', reason: 'This agent’s card can’t be used by this app.', detail }
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new ReadinessTimeout('timed out')), ms)
    timer.unref?.()
    promise.then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      (err) => {
        clearTimeout(timer)
        reject(err)
      }
    )
  })
}
