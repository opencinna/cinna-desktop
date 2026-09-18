import { nanoid } from 'nanoid'
import { messageRepo } from '../db/messages'
import { agentSessionRepo } from '../db/agents'
import { inflightTurnRepo, markLiveMarker } from '../db/inflightTurns'
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
  partToolInputOf,
  partToolNameOf,
  type AccumulatedNotice,
  type MessageLike,
  type ArtifactLike
} from '../agents/streamPartsAccumulator'
import { collectTask, replyLost, serverCopyWins, type CollectedTask, type TaskGetter } from '../agents/a2aTaskCollect'
import { outputSizeOf } from '../agents/outputSize'
import { isTransportDrop } from '../agents/a2aTransport'
import { createTurnCompletion, type TurnCompletion, type TurnOutcome } from './turnCompletion'
import { CUT_OFF_NOTICE, REPLY_CUT_OFF_CODE, STILL_RUNNING_NOTICE } from './turnRecoverers'
import { createLogger } from '../logger/logger'
import type { InputQuestion, InputRequest, RunEvent, RunState } from '../../shared/runEvents'
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

/** The tool a Cinna agent asks the user through (`cinna.tool_name`). */
const CINNA_ASK_TOOL = 'askuserquestion'

/**
 * The questions a Cinna agent's ask-user tool part carries in
 * `cinna.tool_input.questions` (`{ question, header, options: [{ label,
 * description }], multiSelect }`), from the last such part of `parts`.
 * Entries with no question text are dropped; empty when there is none.
 */
function askToolQuestionsOf(parts: MessageLike['parts']): InputQuestion[] {
  const part = parts.findLast((p) => partKindOf(p) === 'tool' && partToolNameOf(p)?.toLowerCase() === CINNA_ASK_TOOL)
  const raw = part ? partToolInputOf(part)?.questions : undefined
  if (!Array.isArray(raw)) return []
  return raw.flatMap((entry): InputQuestion[] => {
    if (!entry || typeof entry !== 'object') return []
    const q = entry as Record<string, unknown>
    if (typeof q.question !== 'string' || !q.question.trim()) return []
    const options = Array.isArray(q.options)
      ? q.options.flatMap((option): InputQuestion['options'] => {
          const o = option as Record<string, unknown> | null
          if (!o || typeof o.label !== 'string') return []
          return [{ label: o.label, ...(typeof o.description === 'string' ? { description: o.description } : {}) }]
        })
      : []
    return [{
      question: q.question,
      ...(typeof q.header === 'string' ? { header: q.header } : {}),
      multiSelect: q.multiSelect === true,
      options
    }]
  })
}

/**
 * What an A2A task parked in `input-required` / `auth-required` is asking for,
 * built from its status message. `undefined` for any other state.
 *
 * The message's `text`-kind parts are the question: a status message may also
 * carry thinking, a tool part or a notice, and none of those is. A2A gives
 * such a question no structure, so it becomes one open question. With no text,
 * a Cinna agent's ask-user tool part is read instead (its questions, headers
 * and options, as structured as a local agent's); with neither, a free-text
 * fallback.
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
  if (!text) {
    const asked = askToolQuestionsOf(message?.parts ?? [])
    if (asked.length) return { kind: 'question', questions: asked }
  }
  return {
    kind: 'question',
    questions: [{ question: text || 'What should the agent do next?', multiSelect: false, options: [] }]
  }
}

interface ActiveRequest {
  controller: AbortController
  /**
   * Persist what the turn has streamed and not yet saved, from its registered
   * snapshot. Synchronous, and a no-op for a turn that registered none. Never
   * throws. `touch: false` leaves the chat's place in the list alone.
   */
  flush: (options?: { touch?: boolean }) => void
}

const activeRequests = new Map<string, ActiveRequest>()

/** The sink and signal {@link a2aStreamingService.streamToAgent} hands a turn. */
export interface TurnIO {
  flush?(): void
  signal: AbortSignal
  onEvent: (event: RunEvent) => void
  /** See `RunInput.registerSnapshot`. A `/run:` command never registers. */
  registerSnapshot?: (snapshot: () => TurnSnapshot) => void
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
  onFinished?: TurnCompletion
  /**
   * Write a durable in-flight marker for this turn: inserted when it starts,
   * deleted on every ending, so one found at boot is a turn the app was killed
   * under. Omitted for a turn a task runner owns — its runtime checkpoint is
   * that record. A marker write that fails is logged and never fails the turn.
   */
  marker?: TurnMarker
  /**
   * `false` saves the turn's rows without moving the chat up the list: a turn
   * the app runs on its own (a relaunch recovery's resend) must not reorder
   * the sidebar under the pointer. Defaults to true.
   */
  touchChat?: boolean
}

/** Who a direct-chat turn belongs to, for its in-flight marker. */
export interface TurnMarker {
  profileId: string
  /** The user row this turn answers, when the send saved one. */
  userMessageId: string | null
  /** The agent's driver id (`a2a`, `managed`, `acp`, …). */
  driver: string
}

/** How often a running turn rewrites its draft row, when anything changed. */
export const DRAFT_INTERVAL_MS = 2000
/** A draft whose parts serialize larger than this is not written. */
export const DRAFT_MAX_BYTES = 4 * 1024 * 1024
/** A draft estimated larger than this is rewritten at most every {@link DRAFT_LARGE_INTERVAL_MS}. */
export const DRAFT_LARGE_BYTES = 256 * 1024
export const DRAFT_LARGE_INTERVAL_MS = 10_000
/**
 * A JSON-encoded string is at most six bytes per UTF-16 unit (`\u0000`), so
 * an estimate this many times under the cap needs no measuring.
 */
const DRAFT_WORST_BYTES_PER_CHAR = 6

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
  /**
   * The A2A `messageId` to send: the user row's id in a direct chat, so the
   * Cinna backend can deduplicate a resend and a stream that ends without a
   * final event can be collected from `tasks/get`. Absent → a fresh id, and
   * no collection.
   */
  messageId?: string
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
  /** See `RunInput.registerSnapshot`: what has streamed, for the quit flush. */
  registerSnapshot?: (snapshot: () => TurnSnapshot) => void
  /**
   * Resolve the agent's access token again, for a `tasks/get` the server
   * refused while the turn is collected after a drop (a Cinna token lasts 15
   * minutes; the wait can outlast it). Rejects with a 401 `A2aHttpError` when
   * the user has to sign in again. Absent: a refusal ends the collection.
   */
  renewAccessToken?: () => Promise<string | undefined>
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
  control?: import('./coordinatorToolProvider').CoordinatorControl
  /** A driver's explicit terminal reason; transport task states remain separate. */
  stopReason?: 'end_turn' | 'budget' | 'canceled'
  /** Constructed only by a host driver, never spread from remote metadata. */
  handback?: { note: string }
  text: string
  parts: MessagePart[]
  notices: AccumulatedNotice[]
  contextId?: string
  taskId?: string
  taskState?: string
  /** Set when the turn failed. Direct mode renders this as an error row. */
  error?: { message: string; raw: string; code?: string }
  /**
   * Messages the user sent into this turn while it ran (ACP steering), in
   * arrival order. Direct mode persists each as a user row between the parts
   * streamed before and after it.
   */
  steers?: TurnSteer[]
}

/** A user message taken into a running turn, after `afterPart` of its parts. */
export interface TurnSteer {
  afterPart: number
  text: string
}

/** What a turn has streamed so far — the persisted slice of its result. */
export type TurnSnapshot = Pick<RunAgentTurnResult, 'parts' | 'notices' | 'steers'>

/**
 * How much of one turn is already in the transcript: parts, steers and notices
 * saved so far. A turn can be persisted more than once — a flush at quit, then
 * the result the killed run still returns — and each pass saves only what lies
 * past this.
 */
interface PersistCursor {
  parts: number
  steers: number
  /**
   * Notices by `partKey`, not by count: `snapshotNotices` skips a notice whose
   * text is still empty, so positions shift when it fills in later.
   */
  notices: Set<string>
}

/**
 * The preview text of a slice of parts, the way a whole turn's `text` is
 * derived: the answer (`text` and `command_result`), else everything.
 */
function sliceText(parts: MessagePart[]): string {
  const answer = parts
    .filter((part) => part.kind === 'text' || part.kind === 'command_result')
    .map((part) => part.text)
    .join('')
  return answer || parts.map((part) => part.text).join('')
}

/**
 * The turn's assistant rows from `cursor` on, with each steered user message in
 * the place it landed. A turn nobody steered is exactly one row — with the
 * turn's own `text` when nothing of it was saved before. A steer that landed
 * before the cursor (a flush saved the parts after it, not the steer) is saved
 * first, still ahead of every part it preceded that is not yet saved.
 *
 * The cursor moves with each write, so a write that throws leaves it on what
 * actually reached the transcript and a later pass does not save it twice.
 * It counts whole parts: a part saved by a flush keeps the text it had then,
 * even if more is merged into it later — usually the last part, but a tool
 * part matched by `toolId` can be an earlier one. Only the quit flush is
 * followed by more output — whatever the killed process had already written —
 * so the cost is clipped text at quit, never a duplicate.
 */
function saveTurnRows(
  chatId: string,
  agentId: string,
  turn: TurnSnapshot & { text?: string },
  cursor: PersistCursor
): void {
  const steers = (turn.steers ?? []).slice(cursor.steers)
  if (!steers.length) {
    if (turn.parts.length > cursor.parts) {
      const slice = turn.parts.slice(cursor.parts)
      const content = cursor.parts === 0 && turn.text !== undefined ? turn.text : sliceText(slice)
      messageRepo.saveAssistant({ chatId, content, parts: slice, sourceAgentId: agentId })
      cursor.parts = turn.parts.length
    }
    return
  }
  const saveUpTo = (to: number): void => {
    const slice = turn.parts.slice(cursor.parts, to)
    if (slice.length) messageRepo.saveAssistant({ chatId, content: sliceText(slice), parts: slice, sourceAgentId: agentId })
    cursor.parts = Math.max(cursor.parts, to)
  }
  for (const steer of steers) {
    saveUpTo(Math.min(Math.max(steer.afterPart, cursor.parts), turn.parts.length))
    messageRepo.saveUser({ chatId, content: steer.text, addressedAgentId: agentId })
    cursor.steers++
  }
  saveUpTo(turn.parts.length)
}

/**
 * Everything of a turn past `cursor`, in transcript order: its notices first —
 * startup pings sit above the answer they preceded on the wire — then its
 * assistant rows with the steered user rows between them. Used by every path
 * that keeps a turn's output: the normal end, a failure, a throw, and the
 * flush at quit.
 */
function persistTurn(
  chatId: string,
  agentId: string,
  turn: TurnSnapshot & { text?: string },
  cursor: PersistCursor,
  options: { touch: boolean } = { touch: true }
): void {
  for (const notice of turn.notices) {
    if (cursor.notices.has(notice.partKey)) continue
    messageRepo.saveTransition({
      chatId,
      content: notice.text,
      sourceAgentId: agentId
    })
    cursor.notices.add(notice.partKey)
  }
  saveTurnRows(chatId, agentId, turn, cursor)
  if (options.touch) messageRepo.touchChat(chatId)
}

/**
 * Detect an auth-rejection from the SDK's HTTP layer. `buildLoggingFetch`
 * intercepts 401/403 responses and throws a typed {@link A2aHttpError} —
 * if the error matches, the SDK call hit the auth gate at the transport
 * layer (not an application-level error in the response body).
 */
function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

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
    messageId,
    isCinnaTokenAuth = false,
    signal,
    onEvent: sink,
    onClient,
    onTaskId,
    registerSnapshot,
    renewAccessToken
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
  // What the turn has streamed so far, for the quit flush: a remote task keeps
  // running after the app closes, but the text the user watched arrive would
  // otherwise leave with the process.
  registerSnapshot?.(() => ({
    parts: accumulator.snapshotParts({ streaming: true }),
    notices: accumulator.snapshotNotices()
  }))

  // Declared outside the `try` so the `catch` can still collect a turn whose
  // stream dropped (see `isTransportDrop`).
  let client: A2AClient | undefined
  let session: ReturnType<typeof agentSessionRepo.getByChatAndAgent>
  let latestContextId: string | undefined
  let latestTaskId: string | undefined
  let latestTaskState: string | undefined
  /** The task id an event of this turn's stream carried — never the remembered one. */
  let streamTaskId: string | undefined
  let streamEvents = 0
  /**
   * Whether the stream said it was done: a `final` status, or a bare message
   * as the whole reply. A stream that closes without it is "unknown".
   */
  let sawFinal = false
  let idsSaved = false

  /**
   * The ids, saved from the first stream event that carries a task id rather
   * than at the end: a turn the app quits under, or whose stream drops, keeps
   * its session (on Cinna the task id *is* the session). A failed write is
   * logged, not thrown — the end-of-turn save tries again.
   */
  const saveFirstIds = (taskId: string, contextId: string | undefined): void => {
    if (idsSaved) return
    idsSaved = true
    try {
      agentSessionRepo.upsert({
        chatId,
        agentId,
        contextId: contextId ?? latestContextId ?? null,
        taskId,
        taskState: null
      })
      logger.debug('Session ids saved from the stream', { contextId: contextId ?? latestContextId, taskId })
    } catch (err) {
      logger.warn('could not save the session ids early', { chatId, agentId, error: String(err) })
    }
  }

  /**
   * Finish from `tasks/get` instead of the stream, when the stream closed or
   * dropped without a final event. `null` when the backend cannot be trusted
   * for it — the caller then goes on as before. Rejects on abort, and with a
   * 401 {@link A2aHttpError} when a Cinna agent's poll needs a sign-in (the
   * renewed token cannot be had, or is refused too): the caller then ends the
   * turn with the re-auth prompt, as a stream the server refused does.
   *
   * For a Cinna agent the backend (or the proxy in front of it) may be the
   * thing that just went away: a first read with no answer, or a 408/429/5xx,
   * is ridden out for `dropsForMs` while the turn stays running, and only
   * then does the stream's own error stand. Any other agent gets one read and
   * keeps its ending — a third-party server that fails `tasks/get` must not
   * hold a turn open for minutes.
   */
  const collectFromServer = async (): Promise<Extract<CollectedTask, { supported: true }> | null> => {
    if (signal.aborted || !client || !streamTaskId || !messageId) return null
    const taskId = streamTaskId
    logger.info('Stream ended without a final event; collecting the turn', { taskId, final: sawFinal })
    // Polls go through the stream's client until a poll is refused; then
    // through one built with a freshly resolved token, as relaunch recovery's.
    let pollClient: TaskGetter | null = client
    const getter: TaskGetter = {
      async getTask(params) {
        if (!pollClient) {
          const token = renewAccessToken ? await renewAccessToken() : accessToken
          pollClient = await createA2AClient(endpointUrl, cardUrl, token, signal)
        }
        return pollClient.getTask(params)
      }
    }
    let noticed = false
    const collected = await collectTask({
      client: getter,
      taskId,
      clientMessageId: messageId,
      signal,
      transientStatusUnreachable: isCinnaTokenAuth,
      rideOutFirstRead: isCinnaTokenAuth,
      ...(renewAccessToken ? { renewClient: () => { pollClient = null } } : {}),
      onPoll: (state) => {
        logger.debug('Task still running on the agent', { taskId, state })
        // The line relaunch recovery shows while it polls; live only, never
        // saved, and gone with the streaming view when the turn ends.
        if (noticed) return
        noticed = true
        onEvent({ type: 'delta', kind: 'notice', text: STILL_RUNNING_NOTICE })
      }
    })
    signal.throwIfAborted()
    if (!collected.supported) {
      if (collected.reason === 'unauthorized' && isCinnaTokenAuth) {
        logger.info('Collecting the turn needs a sign-in', { taskId })
        throw new A2aHttpError(401, 'Unauthorized', cardUrl)
      }
      // Any other reason — unsupported, unreachable, or a refusal of a token
      // the user typed: the stream's own outcome stands.
      logger.debug('Backend cannot report the turn; keeping the stream outcome', { taskId, reason: collected.reason })
      return null
    }
    // The server has our message but no reply: the backend lost it (a crash
    // its orphan repair closed as `completed`). What streamed stays, and the
    // turn ends cut off, as it does for a reply the agent marks `aborted` —
    // also when nothing streamed, so the turn never ends silently.
    const lost = replyLost(collected)
    const state = lost ? 'aborted' : collected.state
    logger.info('Collected the turn from the agent', {
      taskId, state: collected.state, found: collected.found, hasReply: collected.hasReply, lost
    })
    latestTaskState = state
    onEvent({ type: 'status', state: toRunState(state), taskId, contextId: latestContextId })
    const request = a2aInputRequestOf(state, collected.lastAgentMessage)
    if (request) onEvent({ type: 'needs_input', requestId: taskId, request, resume: 'next_message' })
    return collected
  }

  /**
   * The turn's result, from the stream or — when the server has the agent's
   * reply — from `tasks/get`. A turn the server has no reply for keeps what
   * streamed: an empty history must not replace it. Nor does a cut-off reply
   * thinner than what streamed (`serverCopyWins`); the state is the server's
   * either way.
   */
  const finishTurn = (collected: Extract<CollectedTask, { supported: true }> | null): RunAgentTurnResult => {
    const fromServer = collected && serverCopyWins(collected, outputSizeOf(accumulator.snapshotParts())) ? collected : null
    const parts = fromServer ? fromServer.parts : accumulator.snapshotParts()
    const answerText = fromServer ? fromServer.text : accumulator.answerText()
    const notices = fromServer ? fromServer.notices : accumulator.snapshotNotices()
    logger.debug('Turn complete', {
      parts: parts.map((p) => ({ kind: p.kind, len: p.text.length })),
      answerLength: answerText.length,
      noticeCount: notices.length,
      collected: !!fromServer
    })

    agentSessionRepo.upsert({
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

    const failure = latestTaskState && !['completed', 'input-required', 'auth-required', 'canceled'].includes(latestTaskState)
      ? (answerText || `The agent ended the turn with task state "${latestTaskState}".`) : undefined
    // A reply the agent marks cut off (`collectTask` reports the turn
    // `aborted`) says so, in the words relaunch recovery uses.
    const error = latestTaskState === 'aborted'
      ? { message: CUT_OFF_NOTICE, raw: CUT_OFF_NOTICE, code: REPLY_CUT_OFF_CODE }
      : failure ? { message: failure, raw: `A2A task state: ${latestTaskState}`, code: 'agent_task_failed' } : undefined
    return {
      ...(error ? { error } : {}),
      text: answerText || parts.map((p) => p.text).join(''),
      parts,
      notices,
      contextId: latestContextId,
      taskId: latestTaskId,
      taskState: latestTaskState
    }
  }

  try {
    signal.throwIfAborted()
    client = await createA2AClient(endpointUrl, cardUrl, accessToken, signal)
    signal.throwIfAborted()
    onClient?.(client)
    const card = await client.getAgentCard()
    signal.throwIfAborted()
    const supportsStreaming = card.capabilities?.streaming === true

    logger.info(`Agent "${agentName}" | endpoint: ${endpointUrl}`, {
      streaming: supportsStreaming
    })

    session = agentSessionRepo.getByChatAndAgent(chatId, agentId)
    const sessionContextId = session?.contextId ?? undefined
    const sessionTaskId = session?.taskId ?? undefined

    logger.debug(
      session ? 'Resumed session' : 'New session',
      session ? { contextId: sessionContextId, taskId: sessionTaskId } : undefined
    )

    latestContextId = sessionContextId
    latestTaskId = sessionTaskId

    const setTaskId = (id: string | undefined): void => {
      if (!id) return
      latestTaskId = id
      onTaskId?.(id)
    }
    /** A task id carried by a stream event: tracked, surfaced, and saved the first time. */
    const setStreamTaskId = (id: string | undefined, contextId: string | undefined): void => {
      if (!id) return
      streamTaskId = id
      setTaskId(id)
      saveFirstIds(id, contextId)
    }
    if (sessionTaskId) onTaskId?.(sessionTaskId)

    if (supportsStreaming) {
      const params = buildSendParams(wireContent, sessionContextId, sessionTaskId, metadata, messageId)
      logger.debug('→ sendMessageStream', params)

      for await (const event of client.sendMessageStream(params)) {
        logger.debug(`← stream event #${streamEvents++}`, event)
        if (signal.aborted) {
          logger.debug('Stream aborted by client', { eventsReceived: streamEvents })
          signal.throwIfAborted()
        }

        if ('kind' in event) {
          if (event.kind === 'status-update') {
            const su = event as TaskStatusUpdateEvent
            setStreamTaskId(su.taskId, su.contextId)
            if (su.final === true) sawFinal = true
            if (su.status?.message) {
              // A final status may repeat, under a new message id, parts the
              // stream already carried (Cinna's `input-required` ends with the
              // question tool part it streamed while working): replay mode
              // skips those. `a2aInputRequestOf` below still reads it whole.
              accumulator.ingestMessage(su.status.message, deltaPort, { replay: su.final === true })
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
            if (au.taskId) {
              streamTaskId = au.taskId
              saveFirstIds(au.taskId, au.contextId)
            }
            if (au.artifact) {
              accumulator.ingestArtifact(au.artifact, deltaPort)
            }
            if (au.contextId) latestContextId = au.contextId
          } else if (event.kind === 'message') {
            const m = event as Message
            if (m.taskId) setStreamTaskId(m.taskId, m.contextId)
            // A bare message with no task is the whole reply: nothing follows it.
            else if (streamTaskId === undefined) sawFinal = true
            accumulator.ingestMessage(m, deltaPort)
            if (m.contextId) latestContextId = m.contextId
          } else if (event.kind === 'task') {
            const t = event as Task
            latestContextId = t.contextId
            setStreamTaskId(t.id, t.contextId)
            if (t.status?.state) latestTaskState = t.status.state
            if (t.status?.message) {
              // A task snapshot past `submitted`/`working` reports how the turn
              // ended, and its message may repeat what streamed: as above.
              const settled = !!t.status.state && t.status.state !== 'submitted' && t.status.state !== 'working'
              accumulator.ingestMessage(t.status.message, deltaPort, { replay: settled })
            }
            t.artifacts?.forEach((a) => accumulator.ingestArtifact(a, deltaPort))
            onEvent?.({ type: 'status', state: toRunState(t.status?.state), taskId: t.id, contextId: t.contextId })
            const request = a2aInputRequestOf(t.status?.state, t.status?.message)
            if (request) onEvent?.({ type: 'needs_input', requestId: t.id, request, resume: 'next_message' })
          }
        }
      }

      logger.debug('Stream complete', { eventsReceived: streamEvents, final: sawFinal })
      signal.throwIfAborted()
      // A stream that closed without a final event says nothing about how
      // the turn ended. Ask the server.
      if (!sawFinal) return finishTurn(await collectFromServer())
    } else {
      const params = buildSendParams(wireContent, sessionContextId, sessionTaskId, metadata, messageId)
      logger.debug('→ sendMessage', params)
      const result = await client.sendMessage(params)
      signal.throwIfAborted()
      logger.debug('← response', result)
      const responseJson = result as unknown as Record<string, unknown>

      if (responseJson.error && typeof responseJson.error === 'object') {
        const error = responseJson.error as { message?: unknown; code?: unknown }
        throw new Error(typeof error.message === 'string' ? error.message : 'The agent returned a JSON-RPC error.')
      }
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
    return finishTurn(null)
  } catch (err) {
    let failure: unknown = err
    // A stream that dropped mid-turn, on a backend that keeps the turn
    // running: collect it rather than report the drop.
    if (!signal.aborted && streamEvents > 0 && isTransportDrop(err)) {
      try {
        const collected = await collectFromServer()
        if (collected) return finishTurn(collected)
      } catch (collectErr) {
        // A sign-in the collection needs is the turn's failure now;
        // otherwise only a stop lands here, and the stream's own error
        // below reports it.
        if (isAuthRejection(collectErr)) failure = collectErr
        else logger.debug('collecting the dropped turn ended', { error: String(collectErr) })
      }
    }
    const rawError = String(failure)
    const isReauth = isCinnaTokenAuth && isAuthRejection(failure)
    const humanized = isReauth ? CINNA_SESSION_EXPIRED_MESSAGE : humanizeA2AError(failure)
    const code = isReauth ? CINNA_REAUTH_REQUIRED_CODE : undefined
    logger.error('agent turn failed', {
      agentId,
      chatId,
      error: rawError,
      humanized,
      reauth: isReauth,
      stack: failure instanceof Error ? failure.stack : undefined
    })
    // **A throw keeps what streamed before it**, stop or not. After a stop, a
    // throw from the stream — a server dropping the connection after
    // `tasks/cancel`, say — is how the stop ended, and `streamToAgent` saves
    // the parts as a stop's. Otherwise it is a failure, and the wrapper saves
    // the parts above the error row: a connection that dropped minutes into a
    // turn used to leave only the error, and the text the user watched arrive
    // vanished on the refetch. The end-of-turn session save is skipped; the
    // ids saved from the stream's first event stay.
    return {
      text: accumulator.answerText(),
      parts: accumulator.snapshotParts(),
      notices: accumulator.snapshotNotices(),
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
    const finish = createTurnCompletion(chatId, input.onFinished)

    const abortController = new AbortController()
    const requestId = nanoid()
    const cursor: PersistCursor = { parts: 0, steers: 0, notices: new Set() }
    let snapshot: (() => TurnSnapshot) | undefined

    // **The in-flight marker.** Written before the turn runs and deleted in the
    // `finally`, whatever the ending; what is left at boot is a turn the app
    // was killed under (`interruptedTurnService`).
    let markerId: string | null = null
    if (input.marker) {
      try {
        inflightTurnRepo.open({ id: requestId, chatId, agentId, ...input.marker })
        // Running here: no recovery or boot pass of this process may settle it.
        markLiveMarker(requestId)
        markerId = requestId
      } catch (err) {
        logger.error('could not record a turn as in flight', { chatId, agentId, error: errorText(err) })
      }
    }

    // **The draft row.** While the turn runs, one assistant row holds the
    // parts streamed past the cursor, rewritten when they change, so a kill
    // that skips every ending below still leaves them. Only parts: notices and
    // steered user rows are saved with the turn's real rows, and a user row
    // written mid-turn would render twice beside the live view. Every path
    // that saves rows drops the draft in the same transaction first, so the
    // cursor never counts it.
    //
    // Only a turn with a marker keeps one: a task runner's turn is recorded
    // by its own checkpoint, and nothing at boot would settle its draft.
    //
    // Cheap for a large turn: the change check and the size come from string
    // lengths (tool inputs included, since a tool part can change in place),
    // the parts are serialized to measure only when that estimate could pass
    // the cap, and a large draft is rewritten at most every
    // `DRAFT_LARGE_INTERVAL_MS`.
    let draftId: string | null = null
    let draftFingerprint = ''
    let draftTooLargeLogged = false
    let draftWrittenAt = 0
    const writeDraft = (force = false): void => {
      if (!snapshot) return
      try {
        const parts = snapshot().parts.slice(cursor.parts)
        if (!parts.length) return
        let textChars = 0
        let toolChars = 0
        let toolState = ''
        for (const part of parts) {
          textChars += part.text.length
          if (part.toolInput !== undefined || part.toolStream || part.toolName) {
            const inputChars = part.toolInput === undefined ? 0 : JSON.stringify(part.toolInput).length
            toolChars += inputChars
            toolState += `${part.toolName ?? ''}/${part.toolStream ?? ''}/${inputChars};`
          }
        }
        const fingerprint = `${cursor.parts}:${parts.length}:${textChars}:${toolState}`
        if (fingerprint === draftFingerprint) return
        const estimate = textChars + toolChars + parts.length * 64
        if (estimate > DRAFT_LARGE_BYTES && !force && Date.now() - draftWrittenAt < DRAFT_LARGE_INTERVAL_MS) return
        if (estimate * DRAFT_WORST_BYTES_PER_CHAR > DRAFT_MAX_BYTES &&
          Buffer.byteLength(JSON.stringify(parts)) > DRAFT_MAX_BYTES) {
          if (!draftTooLargeLogged) logger.warn('a running turn is too large to keep a draft of', { chatId, agentId })
          draftTooLargeLogged = true
          // Measured: the next measure waits the large interval too.
          draftWrittenAt = Date.now()
          return
        }
        draftId = inflightTurnRepo.writeDraft({ markerId, draftId, chatId, agentId, content: sliceText(parts), parts })
        draftFingerprint = fingerprint
        draftWrittenAt = Date.now()
      } catch (err) {
        logger.error('could not save the draft of a running turn', { chatId, agentId, error: errorText(err) })
      }
    }
    // A draft nothing at boot would settle is not kept: only with an opened marker.
    const draftTimer = markerId ? setInterval(writeDraft, DRAFT_INTERVAL_MS) : undefined
    /**
     * Save a turn's rows past the cursor, replacing the draft in the same
     * transaction. Throws what the write throws; the draft is then untouched.
     */
    const save = (turn: TurnSnapshot & { text?: string }, options: { touch?: boolean } = {}): void => {
      const touch = input.touchChat !== false && options.touch !== false
      inflightTurnRepo.replaceDraft(markerId, draftId, () => persistTurn(chatId, agentId, turn, cursor, { touch }))
      draftId = null
      draftFingerprint = ''
    }

    /** Persist the registered snapshot past the cursor; logs, never throws. */
    const flush = (options: { touch?: boolean } = {}): void => {
      if (!snapshot) return
      try {
        save(snapshot(), options)
      } catch (err) {
        logger.error('could not save what an unfinished turn streamed', {
          chatId,
          agentId,
          error: err instanceof Error ? err.message : String(err)
        })
      }
    }
    activeRequests.set(requestId, { controller: abortController, flush })
    port.postMessage({ type: 'request-id', requestId })

    try {
      const result = await run({
        signal: abortController.signal,
        onEvent: (event) => {
          port.postMessage(event)
          // A turn parked on the user may sit there until the app is closed.
          if (event.type === 'needs_input' && markerId) writeDraft(true)
        },
        registerSnapshot: (read) => { snapshot = read },
        flush: () => flush()
      })
      clearInterval(draftTimer)

      // **A stopped turn that also carries an error is a stop, not a failure.**
      // It must not be saved or posted as one — but it is still an ending, and
      // it falls through to the one below rather than returning in silence:
      // that keeps what the turn streamed, posts `done {canceled}` (the
      // renderer's Stop clears no state of its own, so a stop that posts no
      // terminal event leaves the chat streaming until the user switches
      // away), and finalizes the job run as `cancelled` — a run left
      // unfinalized stays `running` for the life of the app. Same ending as
      // `chatStreamingService`'s abort branch.
      const canceled = abortController.signal.aborted || result.taskState === 'canceled' || result.stopReason === 'canceled'
      const failedState = result.taskState && !['completed', 'input-required', 'auth-required', 'canceled'].includes(result.taskState)
      const state: TurnOutcome['state'] = canceled ? 'canceled'
        : result.error || failedState ? 'failed'
        : result.stopReason === 'budget' ? 'budget'
        : result.taskState === 'input-required' || result.taskState === 'auth-required' ? 'needs_input' : 'completed'
      const failure = result.error ?? (state === 'failed' ? { message: 'The agent reported that its task failed.', raw: result.taskState ?? '' } : undefined)
      if (failure && !canceled) {
        // An A2A task that ends `failed` uses its own answer as the error. Now
        // that the answer is kept as a row, the error says only that it failed,
        // or the transcript would show the agent's words twice.
        const message = failure.message === result.text && result.parts.length > 0
          ? 'The agent reported that its task failed.'
          : failure.message
        // **A failure keeps what it streamed**, and what the user said into
        // the turn is theirs whatever became of it: a turn that ran for
        // minutes and then failed would otherwise leave only the error row.
        // The error goes last, under the output it ended. Rows before the
        // event: a write that throws reaches the `catch`, which posts the one
        // error the renderer sees instead of a second one.
        save(result)
        messageRepo.saveError({
          chatId,
          short: message,
          // The cut-off notice is its own whole message: no Details under it.
          detail: failure.code === REPLY_CUT_OFF_CODE ? null : failure.raw,
          code: failure.code
        })
        port.postMessage(
          failure.code
            ? { type: 'error', error: message, code: failure.code }
            : { type: 'error', error: message }
        )
        // The job run keeps the agent's own reason; only the row was shortened.
        finish({ state: 'failed', text: result.text, error: { message: failure.message, code: failure.code } })
        return
      }

      // Notices, then the assistant rows — past whatever a flush already saved.
      save(result)
      port.postMessage({
        type: 'done',
        stopReason: canceled ? 'canceled' : state === 'budget' ? 'budget' : 'end_turn'
      })
      // **The exit a stop most often takes, and the one the abort branch below
      // does not cover.** A runner that is cancelled cleanly returns what it
      // streamed with no error — that is the documented contract, and both
      // folder runners honour it — so the turn leaves through *this* line, not
      // through the `catch`. Reporting `succeeded` for it is the same lie the
      // OpenAI adapter used to tell by resolving on abort: the run reads as a
      // job that finished, and nothing distinguishes it from one that did.
      finish({ state, text: result.text, ...(result.control && !canceled ? { control: result.control } : {}), ...(state === 'completed' && result.handback ? { handback: result.handback } : {}) })
      if (!canceled && state !== 'failed') {
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
      clearInterval(draftTimer)
      // What the runner offered before it threw is kept, ahead of the error.
      flush()
      if (!abortController.signal.aborted) {
        port.postMessage({ type: 'error', error: message })
        messageRepo.saveError({ chatId, short: message, detail: String(err) })
        finish({ state: 'failed', text: '', error: { message } })
      } else {
        // The other way a stopped turn leaves this function, and it needs the
        // same ending for the same reasons — the renderer included. What the
        // runner streamed survives only through its registered snapshot,
        // already kept above.
        port.postMessage({ type: 'done', stopReason: 'canceled' })
        finish({ state: 'canceled', text: '' })
      }
    } finally {
      // Covers a persistence exception inside the error handler as well.
      finish({ state: 'failed', text: '', error: { message: 'The agent turn ended without a persisted outcome.' } })
      clearInterval(draftTimer)
      activeRequests.delete(requestId)
      if (input.marker) {
        try {
          inflightTurnRepo.delete(requestId)
        } catch (err) {
          logger.error('could not clear a finished turn from the in-flight record', { chatId, agentId, error: errorText(err) })
        }
      }
      port.close()
    }
  },

  /**
   * Persist, synchronously, what every in-flight direct-chat turn has streamed
   * so far — for the quit path, where Electron does not wait for a turn to end
   * and the processes running them are about to be killed. Only the rows, which
   * replace each turn's draft: the turn's outcome is not recorded and its
   * in-flight marker stays, so the boot pass finalizes it if it never returns.
   * A turn that later returns anyway saves only what lies past this. Never
   * throws.
   */
  saveInFlight(): void {
    for (const [requestId, request] of activeRequests) {
      try {
        // The chat keeps its place: at the next launch the list reads as the
        // user left it, not with every running chat moved to the top.
        request.flush({ touch: false })
      } catch (err) {
        logger.error('could not save an in-flight turn at quit', {
          requestId,
          error: err instanceof Error ? err.message : String(err)
        })
      }
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

    // The entry stays until the turn returns (`finally`): a turn stopped just
    // before the app quits is still unwinding, and the flush at quit has to
    // find it to keep what it streamed.
    request.controller.abort()
    return true
  }
}
