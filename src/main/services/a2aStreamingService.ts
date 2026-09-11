import { nanoid } from 'nanoid'
import { messageRepo } from '../db/messages'
import { a2aSessionRepo } from '../db/agents'
import {
  createA2AClient,
  buildSendParams,
  humanizeA2AError,
  A2aHttpError,
  type TaskStatusUpdateEvent,
  type TaskArtifactUpdateEvent,
  type Message,
  type Task
} from '../agents/a2a-client'
import {
  CINNA_REAUTH_REQUIRED_CODE,
  CINNA_SESSION_EXPIRED_MESSAGE
} from '../../shared/cinnaErrors'
import type { A2AClient } from '@a2a-js/sdk/client'
import {
  StreamPartsAccumulator,
  partKindOf,
  type AccumulatedNotice,
  type MessageLike,
  type ArtifactLike
} from '../agents/streamPartsAccumulator'
import { jobService } from './jobService'
import { createLogger } from '../logger/logger'
import type { InputRequest, RunEvent, RunState } from '../../shared/runEvents'
import type { MessagePart } from '../../shared/messageParts'

const logger = createLogger('A2A')

/**
 * Typed stream port. Every event sent to the renderer over this channel must
 * conform to `RunEvent` — the discriminated union flows through the
 * accumulator's `DeltaPort` (narrower), the streaming service itself (full
 * union), and the renderer's `useChatStream` consumer.
 */
export interface StreamPort {
  postMessage(msg: RunEvent): void
  close(): void
}

/**
 * An A2A task state in the protocol-neutral {@link RunState} vocabulary.
 *
 * `input-required` and `auth-required` both become `needs_input`: the renderer
 * cares that the run is waiting on the user, and which of the two it is rides
 * on the `needs_input` event that follows. Anything A2A adds later — or a
 * server invents — is `unknown` rather than passed through as a string the
 * union does not have.
 */
export function toRunState(state: string | undefined): RunState {
  switch (state) {
    case 'submitted':
    case 'working':
    case 'completed':
    case 'failed':
    case 'canceled':
    case 'rejected':
      return state
    case 'input-required':
    case 'auth-required':
      return 'needs_input'
    default:
      return 'unknown'
  }
}

/** Shown when an `auth-required` status carries no text of its own. */
export const A2A_AUTH_REQUIRED_FALLBACK = 'The agent needs you to sign in before it can continue.'

/**
 * What an A2A task parked in `input-required` / `auth-required` is asking for,
 * built from the text of its status message. `undefined` for any other state.
 *
 * Only `text`-kind parts count: a status message may also carry thinking, a
 * tool part or a notice, and none of those is the question. A2A gives a
 * question no structure — no options, no header — so it becomes one open
 * question, with a free-text fallback when the agent sent no text at all.
 */
export function a2aInputRequestOf(
  state: string | undefined,
  message: MessageLike | undefined
): InputRequest | undefined {
  if (state !== 'input-required' && state !== 'auth-required') return undefined
  const text = (message?.parts ?? [])
    .filter((p) => partKindOf(p) === 'text' && typeof p.text === 'string')
    .map((p) => p.text)
    .join('\n\n')
    .trim()
  if (state === 'auth-required') {
    return { kind: 'auth', message: text || A2A_AUTH_REQUIRED_FALLBACK }
  }
  return {
    kind: 'question',
    questions: [{ question: text || 'What should the agent do next?', multiSelect: false, options: [] }]
  }
}

interface ActiveRequest {
  controller: AbortController
}

const activeRequests = new Map<string, ActiveRequest>()

/** The sink and signal {@link a2aStreamingService.streamToAgent} hands a turn. */
export interface TurnIO {
  signal: AbortSignal
  onEvent: (event: RunEvent) => void
}

/** One turn, already bound to its agent. Never throws by contract — and is not trusted to. */
export type TurnRun = (io: TurnIO) => Promise<RunAgentTurnResult>

export interface StreamToAgentInput {
  /**
   * The turn itself — the agent's driver, bound by the IPC handler (or a
   * `/run:` command in its place), not decided here.
   *
   * `streamToAgent` is the *direct-chat wrapper*: register for cancellation,
   * run one turn, persist the assistant row and its notices, pump the port. All
   * of that is identical for every kind of agent, so the only thing that varies
   * is the turn. Taking it as a function rather than branching on what the
   * agent is keeps this function ignorant of what kinds of agent exist — and
   * of their endpoints, tokens and files, which the driver resolves.
   */
  run: TurnRun
  chatId: string
  agentId: string
  port: StreamPort
  /**
   * Fired once, after the turn's rows are persisted, and **only** when the turn
   * actually finished — not when it errored, not when it was stopped.
   *
   * The agent's catch-up cursor rides on this: a turn that failed or was
   * cancelled must leave the cursor where it was, so the retry carries the same
   * gap. Anything it throws is logged and swallowed — a bookkeeping write is
   * not allowed to turn a finished turn into a failed one.
   */
  onCompleted?: () => void
}

/**
 * Port-free input for {@link runAgentTurn}. Carries the same connection
 * parameters as {@link StreamToAgentInput} but replaces the `port` with an
 * optional `onEvent` sink and a required `signal`, so the same A2A pump drives
 * both the direct-A2A chat (`streamToAgent` wrapper) and the orchestrated-mode
 * tool handler (`A2AAsMcpProvider`).
 */
export interface RunAgentTurnInput {
  chatId: string
  agentId: string
  agentName: string
  /**
   * Where the agent answers, for an agent that answers over HTTP.
   *
   * **Optional since the runner seam landed (Phase 6).** A folder agent has no
   * endpoint and no card — it is run by the local engine, not reached over
   * A2A — and this type is the shared input every driver's `run` is built on,
   * so both shapes have to fit through it. `runAgentTurn` below still requires
   * both (see {@link A2ARunAgentTurnInput}); the A2A driver is the single place
   * that narrows, so the compiler continues to refuse an A2A turn with no card
   * rather than discovering it at the SDK call.
   */
  endpointUrl?: string | null
  cardUrl?: string | null
  accessToken?: string
  wireContent: string
  fileIds?: string[]
  isCinnaTokenAuth?: boolean
  /** Aborts the in-flight turn (orchestrator abort, user cancel). */
  signal: AbortSignal
  /**
   * Live event sink — receives every `delta` / `status` / `needs_input` event
   * as it streams. Direct mode forwards these to the chat port verbatim;
   * orchestrated mode wraps each in a `child`. Omit for a fully buffered turn.
   */
  onEvent?: (event: RunEvent) => void
  /** Surfaces the SDK client once created (so callers can `cancelTask`). */
  onClient?: (client: A2AClient) => void
  /** Surfaces the live task id as it's discovered (for `cancelTask`). */
  onTaskId?: (taskId: string) => void
}

/**
 * Dual output of one agent turn (Phase 1 step 2 of the agents-as-MCP plan):
 *  - `text` is the **compact** result (final agent text) for the orchestrator
 *    LLM — never the rich parts.
 *  - `parts` is the **full-fidelity** `parts[]` for the UI sub-thread.
 *  - `notices` are agent-side system messages (persisted as `agent_transition`
 *    rows in direct mode; streamed live but not separately persisted in
 *    orchestrated mode).
 */
export interface RunAgentTurnResult {
  text: string
  parts: MessagePart[]
  notices: AccumulatedNotice[]
  contextId?: string
  taskId?: string
  taskState?: string
  /** Set when the turn failed. Direct mode renders this as an error row. */
  error?: { message: string; raw: string; code?: string }
}

/**
 * Detect an auth-rejection from the SDK's HTTP layer. `buildLoggingFetch`
 * intercepts 401/403 responses and throws a typed {@link A2aHttpError} —
 * if the error matches, the SDK call hit the auth gate at the transport
 * layer (not an application-level error in the response body).
 */
function isAuthRejection(err: unknown): err is A2aHttpError {
  return (
    err instanceof A2aHttpError && (err.status === 401 || err.status === 403)
  )
}

/**
 * {@link RunAgentTurnInput} with the two fields an A2A turn cannot do without.
 *
 * The shared input widened them to optional so a folder agent — which has
 * neither — fits through the shared driver input. This re-narrows for the A2A pump,
 * so the compiler still refuses a turn with no card at the call site rather
 * than letting it surface as an SDK failure mid-stream. The A2A driver
 * (`src/main/agents/drivers/a2aDriver.ts`) is the single place that does the
 * narrowing.
 */
export type A2ARunAgentTurnInput = RunAgentTurnInput & {
  endpointUrl: string
  cardUrl: string
}

/**
 * Port-free core of a single A2A turn: create the client, run the streaming
 * (or non-streaming) RPC, accumulate parts via {@link StreamPartsAccumulator},
 * upsert the session for continuity, and return the dual output. Persistence
 * of assistant/notice rows and port wiring are the caller's responsibility —
 * see {@link a2aStreamingService.streamToAgent} (direct mode) and
 * `A2AAsMcpProvider` (orchestrated mode).
 *
 * **Unchanged by the Phase 6 runner seam.** Its body is exactly what it was;
 * only its input type re-narrows the widened shared one.
 */
export async function runAgentTurn(input: A2ARunAgentTurnInput): Promise<RunAgentTurnResult> {
  const {
    chatId,
    agentId,
    agentName,
    endpointUrl,
    cardUrl,
    accessToken,
    wireContent,
    fileIds,
    isCinnaTokenAuth = false,
    signal,
    onEvent: sink,
    onClient,
    onTaskId
  } = input
  const metadata =
    fileIds && fileIds.length > 0 ? { cinna_file_ids: fileIds } : undefined
  const onEvent = (event: RunEvent): void => {
    signal.throwIfAborted()
    sink?.(event)
    signal.throwIfAborted()
  }

  // Forwards delta events from the accumulator to the caller's sink.
  const deltaPort = {
    postMessage: (msg: RunEvent): void => onEvent?.(msg)
  }

  // Built before the `try`, not inside it: a stop that ends in a throw still
  // returns what was streamed — see the `catch`.
  const accumulator = new StreamPartsAccumulator({
    onToolCall: ({ name, input: toolInput }) => {
      logger.info(`tool call → ${name}`, { input: toolInput })
    },
    onFile: (event) => {
      if (event.status === 'attached') {
        logger.info(`attachment → ${event.filename}`, { fileId: event.fileId })
      } else if (event.status === 'skipped') {
        logger.warn('attachment skipped', { reason: event.reason })
      } else {
        // Duplicate file id — expected on history replay / re-declared paths.
        logger.debug('attachment deduped', { fileId: event.fileId })
      }
    }
  })

  try {
    signal.throwIfAborted()
    const client = await createA2AClient(endpointUrl, cardUrl, accessToken, signal)
    signal.throwIfAborted()
    onClient?.(client)
    const card = await client.getAgentCard()
    signal.throwIfAborted()
    const supportsStreaming = card.capabilities?.streaming === true

    logger.info(`Agent "${agentName}" | endpoint: ${endpointUrl}`, {
      streaming: supportsStreaming
    })

    const session = a2aSessionRepo.getByChatAndAgent(chatId, agentId)
    const sessionContextId = session?.contextId ?? undefined
    const sessionTaskId = session?.taskId ?? undefined

    logger.debug(
      session ? 'Resumed session' : 'New session',
      session ? { contextId: sessionContextId, taskId: sessionTaskId } : undefined
    )

    let latestContextId = sessionContextId
    let latestTaskId = sessionTaskId
    let latestTaskState: string | undefined

    const setTaskId = (id: string | undefined): void => {
      if (!id) return
      latestTaskId = id
      onTaskId?.(id)
    }
    if (sessionTaskId) onTaskId?.(sessionTaskId)

    if (supportsStreaming) {
      const params = buildSendParams(wireContent, sessionContextId, sessionTaskId, metadata)
      logger.debug('→ sendMessageStream', params)
      let eventIndex = 0

      for await (const event of client.sendMessageStream(params)) {
        logger.debug(`← stream event #${eventIndex++}`, event)
        if (signal.aborted) {
          logger.debug('Stream aborted by client', { eventsReceived: eventIndex })
          signal.throwIfAborted()
        }

        if ('kind' in event) {
          if (event.kind === 'status-update') {
            const su = event as TaskStatusUpdateEvent
            setTaskId(su.taskId)
            if (su.status?.message) {
              accumulator.ingestMessage(su.status.message, deltaPort)
            }
            latestContextId = su.contextId
            latestTaskState = su.status.state
            onEvent?.({
              type: 'status',
              state: toRunState(su.status.state),
              taskId: su.taskId,
              contextId: su.contextId
            })
            // A2A ends the turn to ask, so the answer is the user's next
            // message: posted after the `status` (and after the delta that
            // already showed the question's text) so the renderer has both the
            // block and the state by the time it learns the run is waiting.
            const request = a2aInputRequestOf(su.status.state, su.status.message)
            if (request) {
              onEvent?.({
                type: 'needs_input',
                requestId: su.taskId,
                request,
                resume: 'next_message'
              })
            }
          } else if (event.kind === 'artifact-update') {
            const au = event as TaskArtifactUpdateEvent
            if (au.taskId !== latestTaskId) setTaskId(au.taskId)
            if (au.artifact) {
              accumulator.ingestArtifact(au.artifact, deltaPort)
            }
            if (au.contextId) latestContextId = au.contextId
          } else if (event.kind === 'message') {
            const m = event as Message
            if (m.taskId) setTaskId(m.taskId)
            accumulator.ingestMessage(m, deltaPort)
            if (m.contextId) latestContextId = m.contextId
          } else if (event.kind === 'task') {
            const t = event as Task
            latestContextId = t.contextId
            setTaskId(t.id)
            if (t.status?.state) latestTaskState = t.status.state
            if (t.status?.message) {
              accumulator.ingestMessage(t.status.message, deltaPort)
            }
            t.artifacts?.forEach((a) => accumulator.ingestArtifact(a, deltaPort))
            onEvent?.({ type: 'status', state: toRunState(t.status?.state), taskId: t.id, contextId: t.contextId })
            const request = a2aInputRequestOf(t.status?.state, t.status?.message)
            if (request) onEvent?.({ type: 'needs_input', requestId: t.id, request, resume: 'next_message' })
          }
        }
      }

      logger.debug('Stream complete', { eventsReceived: eventIndex })
    } else {
      const params = buildSendParams(wireContent, sessionContextId, sessionTaskId, metadata)
      logger.debug('→ sendMessage', params)
      const result = await client.sendMessage(params)
      signal.throwIfAborted()
      logger.debug('← response', result)
      const responseJson = result as unknown as Record<string, unknown>

      const rpcResult = (responseJson.result ?? responseJson) as Record<string, unknown>

      const ingestTaskShape = (task: {
        id?: string
        contextId?: string
        status?: { state?: string; message?: MessageLike }
        artifacts?: ArtifactLike[]
      }): void => {
        if (task.contextId) latestContextId = task.contextId
        if (task.id) setTaskId(task.id)
        if (task.status?.state) latestTaskState = task.status.state
        if (task.status?.message) accumulator.ingestMessage(task.status.message, deltaPort)
        task.artifacts?.forEach((a) => accumulator.ingestArtifact(a, deltaPort))
        onEvent?.({ type: 'status', state: toRunState(task.status?.state), taskId: task.id, contextId: task.contextId })
        const request = a2aInputRequestOf(task.status?.state, task.status?.message)
        if (request && task.id) onEvent?.({ type: 'needs_input', requestId: task.id, request, resume: 'next_message' })
      }

      if (rpcResult.task) {
        ingestTaskShape(rpcResult.task as Parameters<typeof ingestTaskShape>[0])
      } else if (rpcResult.message) {
        const msg = rpcResult.message as MessageLike & { contextId?: string; taskId?: string }
        if (msg.contextId) latestContextId = msg.contextId
        if (msg.taskId) setTaskId(msg.taskId)
        accumulator.ingestMessage(msg, deltaPort)
      } else if (rpcResult.kind === 'task') {
        ingestTaskShape(rpcResult as Parameters<typeof ingestTaskShape>[0])
      } else if (rpcResult.kind === 'message') {
        const msg = rpcResult as unknown as MessageLike & { contextId?: string; taskId?: string }
        if (msg.contextId) latestContextId = msg.contextId
        if (msg.taskId) setTaskId(msg.taskId)
        accumulator.ingestMessage(msg, deltaPort)
      }

      logger.debug('Non-streaming complete')
    }

    signal.throwIfAborted()
    const parts = accumulator.snapshotParts()
    const answerText = accumulator.answerText()
    const notices = accumulator.snapshotNotices()
    logger.debug('Turn complete', {
      parts: parts.map((p) => ({ kind: p.kind, len: p.text.length })),
      answerLength: answerText.length,
      noticeCount: notices.length
    })

    a2aSessionRepo.upsert({
      chatId,
      agentId,
      contextId: latestContextId ?? session?.contextId ?? null,
      taskId: latestTaskId ?? session?.taskId ?? null,
      taskState: latestTaskState ?? session?.taskState ?? null
    })
    logger.debug('Session saved', {
      contextId: latestContextId,
      taskId: latestTaskId,
      state: latestTaskState
    })

    return {
      text: answerText || parts.map((p) => p.text).join(''),
      parts,
      notices,
      contextId: latestContextId,
      taskId: latestTaskId,
      taskState: latestTaskState
    }
  } catch (err) {
    const rawError = String(err)
    const isReauth = isCinnaTokenAuth && isAuthRejection(err)
    const humanized = isReauth ? CINNA_SESSION_EXPIRED_MESSAGE : humanizeA2AError(err)
    const code = isReauth ? CINNA_REAUTH_REQUIRED_CODE : undefined
    logger.error('agent turn failed', {
      agentId,
      chatId,
      error: rawError,
      humanized,
      reauth: isReauth,
      stack: err instanceof Error ? err.stack : undefined
    })
    // **A stop keeps what it streamed.** When the user had already stopped the
    // turn, a throw from the stream — a server dropping the connection after
    // `tasks/cancel`, say — is how the stop ended, not a verdict on what came
    // before it. `streamToAgent` treats an aborted result as a stop and saves
    // its parts, so the text the user watched arrive does not vanish on the
    // refetch `done` triggers. Any other failure still returns nothing streamed.
    const kept = signal.aborted
    return {
      text: kept ? accumulator.answerText() : '',
      parts: kept ? accumulator.snapshotParts() : [],
      notices: kept ? accumulator.snapshotNotices() : [],
      error: { message: humanized, raw: rawError, code }
    }
  }
}

/**
 * Drive a single A2A turn end-to-end for a **direct** agent chat: register the
 * request for cancellation, run {@link runAgentTurn}, persist the assistant
 * message + notices, post events to the port. Continuity (`a2a_sessions`) is
 * handled inside `runAgentTurn`.
 *
 * The user message is NOT persisted here — that already happened in
 * `messageRoutingService.prepareAgentSend` before this call.
 */
export const a2aStreamingService = {
  async streamToAgent(input: StreamToAgentInput): Promise<void> {
    const { run, chatId, agentId, port } = input

    const abortController = new AbortController()
    const requestId = nanoid()
    activeRequests.set(requestId, { controller: abortController })
    port.postMessage({ type: 'request-id', requestId })

    try {
      const result = await run({
        signal: abortController.signal,
        onEvent: (event) => port.postMessage(event)
      })

      // **A stopped turn that also carries an error is a stop, not a failure.**
      // It must not be saved or posted as one — but it is still an ending, and
      // it falls through to the one below rather than returning in silence:
      // that keeps what the turn streamed, posts `done {canceled}` (the
      // renderer's Stop clears no state of its own, so a stop that posts no
      // terminal event leaves the chat streaming until the user switches
      // away), and finalizes the job run as `cancelled` — a run left
      // unfinalized stays `running` for the life of the app. Same ending as
      // `chatStreamingService`'s abort branch.
      if (result.error && !abortController.signal.aborted) {
        port.postMessage(
          result.error.code
            ? { type: 'error', error: result.error.message, code: result.error.code }
            : { type: 'error', error: result.error.message }
        )
        messageRepo.saveError({
          chatId,
          short: result.error.message,
          detail: result.error.raw,
          code: result.error.code
        })
        jobService.reportRunCompletion(chatId, 'failed', result.error.message)
        return
      }

      // Persist notices first so they precede the assistant message in
      // transcript order — startup pings should sit above the answer they
      // preceded on the wire.
      for (const notice of result.notices) {
        messageRepo.saveTransition({
          chatId,
          content: notice.text,
          sourceAgentId: agentId
        })
      }

      if (result.parts.length > 0) {
        messageRepo.saveAssistant({
          chatId,
          content: result.text,
          parts: result.parts,
          sourceAgentId: agentId
        })
      }

      messageRepo.touchChat(chatId)
      port.postMessage({
        type: 'done',
        stopReason: abortController.signal.aborted ? 'canceled' : 'end_turn'
      })
      // **The exit a stop most often takes, and the one the abort branch below
      // does not cover.** A runner that is cancelled cleanly returns what it
      // streamed with no error — that is the documented contract, and both
      // folder runners honour it — so the turn leaves through *this* line, not
      // through the `catch`. Reporting `succeeded` for it is the same lie the
      // OpenAI adapter used to tell by resolving on abort: the run reads as a
      // job that finished, and nothing distinguishes it from one that did.
      jobService.reportRunCompletion(chatId, abortController.signal.aborted ? 'cancelled' : 'succeeded')
      if (!abortController.signal.aborted) {
        try {
          input.onCompleted?.()
        } catch (err) {
          logger.warn('a completed turn could not record its bookkeeping', {
            chatId,
            agentId,
            error: err instanceof Error ? err.message : String(err)
          })
        }
      }
    } catch (err) {
      // **A runner is not trusted to keep its own contract here.**
      // `AgentDriver.run` documents that it never throws, and the A2A
      // one does not — but this `try` had only a `finally`, so the day a runner
      // broke that promise the port closed having posted neither `done` nor
      // `error` and the renderer sat in the streaming state forever. That is
      // exactly what `turnLock.acquire`'s `LocalAgentError` did: it is thrown,
      // not returned, and it reached here from the folder runners too.
      //
      // Fixed at both ends — the local runner catches it too — because this is
      // the wrapper every future runner will pass through, and a hung chat is
      // unrecoverable without a restart while a visible error is not.
      const message = err instanceof Error ? err.message : String(err)
      logger.error('a turn threw out of its runner', {
        agentId,
        chatId,
        error: message,
        stack: err instanceof Error ? err.stack : undefined
      })
      if (!abortController.signal.aborted) {
        port.postMessage({ type: 'error', error: message })
        messageRepo.saveError({ chatId, short: message, detail: String(err) })
        jobService.reportRunCompletion(chatId, 'failed', message)
      } else {
        // The other way a stopped turn leaves this function, and it needs the
        // same ending for the same reasons — the renderer included. Nothing the
        // runner streamed survives a throw, so there is nothing to keep.
        port.postMessage({ type: 'done', stopReason: 'canceled' })
        jobService.reportRunCompletion(chatId, 'cancelled')
      }
    } finally {
      port.close()
      activeRequests.delete(requestId)
    }
  },

  /**
   * Stop a direct-chat turn. Only aborts: the driver that runs the turn tells
   * the agent itself to stop (the A2A driver sends `tasks/cancel` from its own
   * abort listener), so the orchestrator's agent tool and this Stop cancel the
   * same way and the request goes out once.
   */
  cancel(requestId: string): boolean {
    const request = activeRequests.get(requestId)
    if (!request) return false

    request.controller.abort()
    activeRequests.delete(requestId)
    return true
  }
}
