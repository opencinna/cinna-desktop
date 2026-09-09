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
  type AccumulatedNotice,
  type MessageLike,
  type ArtifactLike
} from '../agents/streamPartsAccumulator'
import { jobService } from './jobService'
import { createLogger } from '../logger/logger'
import type { AgentStreamEvent } from '../../shared/agentStreamEvents'
import type { MessagePart } from '../../shared/messageParts'
import type { AgentTurnRunner } from './agentTurn/runner'

const logger = createLogger('A2A')

/**
 * Typed stream port. Every event sent to the renderer over this channel must
 * conform to `AgentStreamEvent` — the discriminated union flows through the
 * accumulator's `DeltaPort` (narrower), the streaming service itself (full
 * union), and the renderer's `useChatStream.handleAgent` consumer.
 */
export interface StreamPort {
  postMessage(msg: AgentStreamEvent): void
  close(): void
}

interface ActiveRequest {
  controller: AbortController
  client?: A2AClient
  taskId?: string
}

const activeRequests = new Map<string, ActiveRequest>()

export interface StreamToAgentInput {
  /**
   * Which runner drives this turn — chosen by `resolveTurnRunner(agent)` in the
   * IPC handler, not decided here.
   *
   * `streamToAgent` is the *direct-chat wrapper*: register for cancellation,
   * run one turn, persist the assistant row and its notices, pump the port. All
   * of that is identical for an A2A agent and a folder agent, so the only thing
   * that varies is the turn itself. Passing the runner in rather than branching
   * on `source` here keeps this function ignorant of what kinds of agent exist,
   * which is what makes it a lift rather than a rewrite.
   */
  runner: AgentTurnRunner
  chatId: string
  agentId: string
  agentName: string
  endpointUrl?: string | null
  cardUrl?: string | null
  accessToken?: string
  wireContent: string
  /**
   * Cinna file IDs (UUIDs) to attach to this turn — forwarded as
   * `metadata.cinna_file_ids` on the A2A message. The cinna-backend reads
   * this and transfers the uploaded files into the agent environment under
   * `./uploads/` before the agent receives the message.
   */
  fileIds?: string[]
  port: StreamPort
  /**
   * True when the access token is a Cinna-issued JWT (remote agents synced
   * from the user's Cinna account). When set, an SDK-level 401/403 mid-stream
   * is treated as a reauth-required signal — the user gets a clickable
   * "Re-authenticate" chip rather than a generic auth error. Manually-added
   * local A2A agents pass `false` here so a 401 stays a plain "token rejected"
   * (no in-app reauth flow exists for them).
   */
  isCinnaTokenAuth?: boolean
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
   * A2A — and this type is the shared input to `AgentTurnRunner`, so both
   * shapes have to fit through it. `runAgentTurn` below still requires both
   * (see {@link A2ARunAgentTurnInput}); `A2ATurnRunner` is the single place
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
   * Live event sink — receives every `delta` / `status` event as it streams.
   * Direct mode forwards these to the chat port verbatim; orchestrated mode
   * wraps each as a `tool_subevent`. Omit for a fully buffered turn.
   */
  onEvent?: (event: AgentStreamEvent) => void
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
 * neither — fits through `AgentTurnRunner`. This re-narrows for the A2A pump,
 * so the compiler still refuses a turn with no card at the call site rather
 * than letting it surface as an SDK failure mid-stream. `A2ATurnRunner` in
 * `agentTurn/index.ts` is the single place that does the narrowing.
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
    onEvent,
    onClient,
    onTaskId
  } = input
  const metadata =
    fileIds && fileIds.length > 0 ? { cinna_file_ids: fileIds } : undefined

  // Forwards delta events from the accumulator to the caller's sink.
  const deltaPort = {
    postMessage: (msg: AgentStreamEvent): void => onEvent?.(msg)
  }

  try {
    const client = await createA2AClient(endpointUrl, cardUrl, accessToken)
    onClient?.(client)
    const card = await client.getAgentCard()
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

    if (supportsStreaming) {
      const params = buildSendParams(wireContent, sessionContextId, sessionTaskId, metadata)
      logger.debug('→ sendMessageStream', params)
      let eventIndex = 0

      for await (const event of client.sendMessageStream(params)) {
        logger.debug(`← stream event #${eventIndex++}`, event)
        if (signal.aborted) {
          logger.debug('Stream aborted by client', { eventsReceived: eventIndex })
          break
        }

        if ('kind' in event) {
          if (event.kind === 'status-update') {
            const su = event as TaskStatusUpdateEvent
            if (su.status?.message) {
              accumulator.ingestMessage(su.status.message, deltaPort)
            }
            latestContextId = su.contextId
            setTaskId(su.taskId)
            latestTaskState = su.status.state
            onEvent?.({
              type: 'status',
              state: su.status.state,
              taskId: su.taskId,
              contextId: su.contextId
            })
          } else if (event.kind === 'artifact-update') {
            const au = event as TaskArtifactUpdateEvent
            if (au.artifact) {
              accumulator.ingestArtifact(au.artifact, deltaPort)
            }
            if (au.contextId) latestContextId = au.contextId
          } else if (event.kind === 'message') {
            const m = event as Message
            accumulator.ingestMessage(m, deltaPort)
            if (m.contextId) latestContextId = m.contextId
            if (m.taskId) setTaskId(m.taskId)
          } else if (event.kind === 'task') {
            const t = event as Task
            latestContextId = t.contextId
            setTaskId(t.id)
            if (t.status?.state) latestTaskState = t.status.state
            if (t.status?.message) {
              accumulator.ingestMessage(t.status.message, deltaPort)
            }
            t.artifacts?.forEach((a) => accumulator.ingestArtifact(a, deltaPort))
          }
        }
      }

      logger.debug('Stream complete', { eventsReceived: eventIndex })
    } else {
      const params = buildSendParams(wireContent, sessionContextId, sessionTaskId, metadata)
      logger.debug('→ sendMessage', params)
      const result = await client.sendMessage(params)
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
    return {
      text: '',
      parts: [],
      notices: [],
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
    const {
      runner,
      chatId,
      agentId,
      agentName,
      endpointUrl,
      cardUrl,
      accessToken,
      wireContent,
      fileIds,
      port,
      isCinnaTokenAuth = false
    } = input

    const abortController = new AbortController()
    const requestId = nanoid()
    const activeRequest: ActiveRequest = { controller: abortController }
    activeRequests.set(requestId, activeRequest)
    port.postMessage({ type: 'request-id', requestId })

    try {
      const result = await runner.runTurn({
        chatId,
        agentId,
        agentName,
        endpointUrl,
        cardUrl,
        accessToken,
        wireContent,
        fileIds,
        isCinnaTokenAuth,
        signal: abortController.signal,
        onEvent: (event) => port.postMessage(event),
        onClient: (client) => {
          activeRequest.client = client
        },
        onTaskId: (taskId) => {
          activeRequest.taskId = taskId
        }
      })

      if (result.error) {
        // Suppress the error surface if the user aborted — a cancel is not a
        // failure.
        if (!abortController.signal.aborted) {
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
        } else {
          // **Suppressing the error surface is not the same as reporting
          // nothing.** A stop is not a failure and must not be saved or posted
          // as one — but it is still an ending, and a job run left unfinalized
          // stays `running` for the life of the app: nothing reaps a stale one,
          // and `countInProgressByJob` keeps the job's "currently running"
          // badge lit. Same rule, and the same call, as `chatStreamingService`'s
          // abort branch.
          jobService.reportRunCompletion(chatId, 'cancelled')
        }
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
      port.postMessage({ type: 'done' })
      // **The exit a stop most often takes, and the one the abort branch below
      // does not cover.** A runner that is cancelled cleanly returns what it
      // streamed with no error — that is the documented contract, and both
      // folder runners honour it — so the turn leaves through *this* line, not
      // through the `catch`. Reporting `succeeded` for it is the same lie the
      // OpenAI adapter used to tell by resolving on abort: the run reads as a
      // job that finished, and nothing distinguishes it from one that did.
      jobService.reportRunCompletion(chatId, abortController.signal.aborted ? 'cancelled' : 'succeeded')
    } catch (err) {
      // **A runner is not trusted to keep its own contract here.**
      // `AgentTurnRunner.runTurn` documents that it never throws, and the A2A
      // one does not — but this `try` had only a `finally`, so the day a runner
      // broke that promise the port closed having posted neither `done` nor
      // `error` and the renderer sat in the streaming state forever. That is
      // exactly what `turnLock.acquire`'s `LocalAgentError` did: it is thrown,
      // not returned, and it reaches here from `LocalAgentTurnRunner`.
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
        // same ending for the same reason.
        jobService.reportRunCompletion(chatId, 'cancelled')
      }
    } finally {
      port.close()
      activeRequests.delete(requestId)
    }
  },

  cancel(requestId: string): boolean {
    const request = activeRequests.get(requestId)
    if (!request) return false

    request.controller.abort()
    activeRequests.delete(requestId)

    if (request.client && request.taskId) {
      const taskId = request.taskId
      logger.info('Sending cancelTask to agent', { taskId })
      request.client.cancelTask({ id: taskId }).catch((err) =>
        logger.warn('cancelTask failed', { taskId, error: String(err) })
      )
    }
    return true
  }
}
