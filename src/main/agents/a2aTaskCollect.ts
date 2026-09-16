/**
 * Collect a remote A2A turn from `tasks/get` instead of from its stream.
 *
 * The Cinna backend keeps a turn running when the stream closes early, and
 * `tasks/get` returns the task's real state plus its history. There, our user
 * message carries `metadata['cinna.client_message_id']` (the `messageId` we
 * sent), and the agent messages after it, up to the next user message, belong
 * to that turn. This module polls until that turn is over, then rebuilds its
 * parts from the history.
 *
 * **The task is not the turn.** One task holds every turn of the session, so
 * a later message can keep it `working` after ours ended. Our turn is over
 * when the task stops working, or when a later user message follows it and
 * our last agent message is no longer `streaming`. Its state is its own:
 * `canceled` or `aborted` from that message's `cinna.message_state`, else
 * `completed` for a turn a later one followed, else the task's.
 *
 * **Gated on the backend.** A backend from before that change, or an A2A
 * server that isn't Cinna, answers `working` for ever and has none of the
 * `cinna.*` history keys. So the first answer decides whether the rest can be
 * trusted: without either key in the history, the answer is
 * `{ supported: false }` and the caller keeps its current behaviour.
 *
 * **A first read that gets no answer.** By default it ends collection as
 * `unreachable`. With `rideOutFirstRead` (the live turn of a Cinna agent,
 * whose stream just dropped because the backend or its proxy went away) the
 * collector keeps asking for up to `dropsForMs` from that failure, and the
 * first answer that arrives is the one the Cinna-keys check reads.
 *
 * Kept independent of `runAgentTurn`: relaunch recovery reuses it.
 */
import { A2aHttpError } from './a2a-client'
import { isTransientHttpStatus, isTransportDrop } from './a2aTransport'
import { StreamPartsAccumulator, type MessageLike, type PartLike } from './streamPartsAccumulator'
import type { MessagePart } from '../../shared/messageParts'
import type { AccumulatedNotice } from './streamPartsAccumulator'
import { isAtLeastAsRich, outputSizeOf, type OutputSize } from './outputSize'

export const CINNA_CLIENT_MESSAGE_ID_KEY = 'cinna.client_message_id'
export const CINNA_MESSAGE_STATE_KEY = 'cinna.message_state'

/** How many history messages each `tasks/get` asks for. */
export const COLLECT_HISTORY_LENGTH = 50

/**
 * The poll schedule: every `fastMs` for the first `fastForMs`, then every
 * `slowMs`. Read at call time, so a test can shorten it.
 */
export const collectPollDelays = {
  fastMs: 2_000,
  slowMs: 5_000,
  fastForMs: 120_000,
  /** How long polling rides out transport drops in a row before it gives up as `unreachable`. */
  dropsForMs: 10 * 60_000
}

/** The one method this module needs from `A2AClient`. */
export interface TaskGetter {
  getTask(params: { id: string; historyLength?: number }): Promise<unknown>
}

export interface CollectTaskInput {
  client: TaskGetter
  taskId: string
  /** The `messageId` our send carried; the server echoes it on our user message. */
  clientMessageId: string
  /** Stops polling. The collector then rejects with `signal.reason`. */
  signal: AbortSignal
  /** Called with each non-final state seen, before the wait that follows it. */
  onPoll?: (state: string) => void
  /** The first answer, already read with {@link readTask}; skips the first call. */
  initial?: TaskRead
  /**
   * Called once when a poll is refused (401/403), before that poll is asked
   * again: the caller builds its next client with a freshly resolved token.
   * Without it, a refusal ends polling as `unauthorized`.
   */
  renewClient?: () => void
  /**
   * Read a 408, 429 or 5xx answer as `unreachable` rather than `unsupported`
   * (see `isTransientHttpStatus`): relaunch recovery waits those out. The
   * live turn sets it only for a Cinna agent; any other server keeps its
   * ending.
   */
  transientStatusUnreachable?: boolean
  /**
   * Ride out a first read that got no answer (`unreachable`) for up to
   * `dropsForMs`, polling on the usual schedule, instead of giving up at once.
   * Only without `initial`. A refusal or an unusable answer still ends it.
   * The live turn sets it for a Cinna agent only: a third-party server that
   * fails `tasks/get` must not hold a turn open for minutes.
   */
  rideOutFirstRead?: boolean
}

/** How {@link readTask} and the collector classify a failed `tasks/get`. */
export interface ReadTaskOptions {
  /** See {@link CollectTaskInput.transientStatusUnreachable}. */
  transientStatusUnreachable?: boolean
}

/**
 * Why `tasks/get` cannot report the turn:
 * - `unsupported` — the server answered, but not as a Cinna backend that
 *   reports turns does (an error frame, another shape, no `cinna.*` keys);
 * - `unreachable` — the request never got an answer (a transport drop, a
 *   timeout; with `transientStatusUnreachable`, also a 408, 429 or 5xx), or,
 *   once polling, those went on longer than `dropsForMs`;
 * - `unauthorized` — the server refused the credentials (401/403), again
 *   after `renewClient`.
 */
export type CollectFailure = 'unsupported' | 'unreachable' | 'unauthorized'

/** One `tasks/get`, read and classified. Opaque outside this module except for `failed`. */
export type TaskRead = TaskShape | { failed: CollectFailure }

export type CollectedTask =
  | { supported: false; reason: CollectFailure }
  | {
      supported: true
      /** The turn's state once it ended (see the module note); the task's when our message is not found. */
      state: string
      /** Whether our user message is in the history. */
      found: boolean
      /**
       * Whether the agent answered it: the agent messages after ours rebuild
       * into at least one part or notice (a reply that is only a notice is a
       * reply). A turn the backend ended without writing its reply (a crash
       * its orphan repair closed), or with a row whose only part is empty
       * text (a cut-off row with nothing flushed), has no reply, and nothing
       * to replace what streamed with (see {@link replyLost}).
       */
      hasReply: boolean
      /**
       * Set when ours has no agent message of its own but a later user
       * message follows it and the agent answered after that: the backend may
       * have answered both in one reply, so ours is not lost (see {@link replyLost}).
       */
      answeredWithNext?: true
      /**
       * Whether the history came back as long as asked: older messages may be
       * cut off, so "not found" does not prove our message never arrived.
       */
      historyFull: boolean
      /** The turn's parts, rebuilt from the history. Empty when not found. */
      parts: MessagePart[]
      notices: AccumulatedNotice[]
      /** The turn's answer text (`answerText()`), without any fallback. */
      text: string
      /** The last agent message of the turn: what an `input-required` state asks. */
      lastAgentMessage?: MessageLike
      /** That message's `cinna.message_state` (`complete`, `aborted`, `canceled`, …), when it has one. */
      lastAgentState?: string
    }

interface HistoryMessage extends MessageLike {
  role?: string
  metadata?: Record<string, unknown> | null
}

interface TaskShape {
  status?: { state?: string }
  history?: HistoryMessage[]
}

const RUNNING_STATES = new Set(['working', 'submitted'])

const noDeltas = { postMessage: (): void => {} }

/** The task from a `tasks/get` answer, or `undefined` for an error answer or any other shape. */
function taskOf(response: unknown): TaskShape | undefined {
  if (!response || typeof response !== 'object') return undefined
  if ('error' in response && (response as { error?: unknown }).error) return undefined
  const result = (response as { result?: unknown }).result
  if (!result || typeof result !== 'object') return undefined
  return result as TaskShape
}

function hasCinnaKeys(task: TaskShape): boolean {
  return (task.history ?? []).some((message) => {
    const meta = message.metadata
    return !!meta && (meta[CINNA_MESSAGE_STATE_KEY] !== undefined || meta[CINNA_CLIENT_MESSAGE_ID_KEY] !== undefined)
  })
}

/** A wait that ends early, with a rejection, when `signal` aborts. */
function wait(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason)
      return
    }
    const onAbort = (): void => {
      clearTimeout(timer)
      reject(signal.reason)
    }
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    signal.addEventListener('abort', onAbort, { once: true })
  })
}

/**
 * One `tasks/get`, classified: the task, or why there is none. An abort
 * rejects with its reason.
 */
async function fetchTask(client: TaskGetter, taskId: string, signal: AbortSignal, options: ReadTaskOptions = {}): Promise<TaskRead> {
  try {
    return taskOf(await client.getTask({ id: taskId, historyLength: COLLECT_HISTORY_LENGTH })) ?? { failed: 'unsupported' }
  } catch (err) {
    signal.throwIfAborted()
    if (err instanceof A2aHttpError && (err.status === 401 || err.status === 403)) return { failed: 'unauthorized' }
    if (isTransportDrop(err) || (err instanceof Error && err.name === 'TimeoutError')) return { failed: 'unreachable' }
    if (options.transientStatusUnreachable && isTransientHttpStatus(err)) return { failed: 'unreachable' }
    return { failed: 'unsupported' }
  }
}

/**
 * One `tasks/get` for a caller that must know, before anything else, whether
 * the server can be asked at all (relaunch recovery). Hand the result to
 * {@link collectTask} as `initial`.
 */
export function readTask(client: TaskGetter, taskId: string, options: ReadTaskOptions = {}): Promise<TaskRead> {
  return fetchTask(client, taskId, new AbortController().signal, options)
}

const failedOf = (read: TaskRead): CollectFailure | undefined => ('failed' in read ? read.failed : undefined)

type Supported = Extract<CollectedTask, { supported: true }>

/**
 * Our turn as `task` has it, and whether it is over (see the module note).
 * Only the messages after ours and before the next user message are read.
 */
function readTurn(task: TaskShape, taskState: string, clientMessageId: string): { turn: Supported; over: boolean } {
  const history = task.history ?? []
  const historyFull = history.length >= COLLECT_HISTORY_LENGTH
  const running = RUNNING_STATES.has(taskState)
  let ours = -1
  for (let i = history.length - 1; i >= 0; i--) {
    const message = history[i]
    if (message.role === 'user' && message.metadata?.[CINNA_CLIENT_MESSAGE_ID_KEY] === clientMessageId) {
      ours = i
      break
    }
  }
  if (ours < 0) {
    return { turn: { supported: true, state: taskState, found: false, hasReply: false, historyFull, parts: [], notices: [], text: '' }, over: !running }
  }

  const accumulator = new StreamPartsAccumulator()
  let lastAgentMessage: MessageLike | undefined
  let lastAgentState: string | undefined
  let followed = false
  let next = -1
  for (let i = ours + 1; i < history.length; i++) {
    const message = history[i]
    if (message.role === 'user') {
      followed = true
      next = i
      break
    }
    if (message.role !== 'agent') continue
    const parts: PartLike[] = Array.isArray(message.parts) ? message.parts : []
    accumulator.ingestMessage({ messageId: message.messageId, parts }, noDeltas)
    lastAgentMessage = { messageId: message.messageId, parts }
    const state = message.metadata?.[CINNA_MESSAGE_STATE_KEY]
    lastAgentState = typeof state === 'string' ? state : undefined
  }
  // A later message with no reply of ours before it: ours may have been
  // answered with it, so only the task's end says ours is over.
  const endedBeforeNext = followed && !!lastAgentMessage && lastAgentState !== 'streaming'
  const over = !running || endedBeforeNext
  const state = lastAgentState === 'canceled' || lastAgentState === 'aborted' ? lastAgentState
    : followed ? 'completed'
    : taskState
  const parts = accumulator.snapshotParts()
  const notices = accumulator.snapshotNotices()
  const answeredWithNext = followed && !lastAgentMessage && history.slice(next + 1).some((message) => message.role === 'agent')
  return {
    turn: {
      supported: true,
      state,
      found: true,
      hasReply: parts.length > 0 || notices.length > 0,
      historyFull,
      parts,
      notices,
      text: accumulator.answerText(),
      ...(answeredWithNext ? { answeredWithNext: true as const } : {}),
      ...(lastAgentMessage ? { lastAgentMessage } : {}),
      ...(lastAgentState ? { lastAgentState } : {})
    },
    over
  }
}

/** States a turn with no reply can end in without having lost one: a stop, an ask. */
const NO_REPLY_STATES = new Set(['canceled', 'input-required', 'auth-required'])

/**
 * Whether the server has our message but ended the turn without its reply,
 * in a state that says nothing was lost on purpose — `completed`, `failed`,
 * `aborted`, anything but a stop or an ask. The caller reads that as a reply
 * the server lost (a backend that crashed before it wrote it): whatever
 * streamed stays, and the turn ends as cut off, even when nothing streamed.
 * A turn a later message followed, with the agent's answer after that one,
 * is not: the backend may have answered both at once.
 */
export function replyLost(collected: Supported): boolean {
  return collected.found && !collected.hasReply && !collected.answeredWithNext
    && !RUNNING_STATES.has(collected.state) && !NO_REPLY_STATES.has(collected.state)
}

/** Turn states that say the reply ended normally: an answer, or an ask. */
const NORMAL_END_STATES = new Set(['completed', 'input-required', 'auth-required'])
/** A last agent message in one of these states did not finish writing. */
const UNFINISHED_MESSAGE_STATES = new Set(['streaming', 'aborted', 'canceled'])

/**
 * Whether the server's copy of the turn may hold less than was written: the
 * turn ended any way but an answer or an ask (a crash, a stop, `failed`,
 * `rejected`, …), or its last agent message never finished (`streaming`,
 * `aborted`, `canceled`).
 */
export function isCutOff(collected: Supported): boolean {
  return !NORMAL_END_STATES.has(collected.state)
    || (!!collected.lastAgentState && UNFINISHED_MESSAGE_STATES.has(collected.lastAgentState))
}

/**
 * Whether the server's reply replaces the local copy of the turn (what
 * streamed here, or the rows a kill left). A reply that ended normally
 * always does. A cut-off one ({@link isCutOff}) may hold only what the server
 * flushed before it ended, so it does only when its parts are at least as
 * rich as the local copy (see {@link isAtLeastAsRich}); otherwise the local
 * copy stays, and the turn still takes the server's state. No reply never does.
 */
export function serverCopyWins(collected: Supported, local: OutputSize): boolean {
  if (!collected.found || !collected.hasReply) return false
  return !isCutOff(collected) || isAtLeastAsRich(outputSizeOf(collected.parts), local)
}

/**
 * Poll `tasks/get` until our turn is over and return it. Rejects only with
 * the abort reason; every other failure is `{ supported: false, reason }`.
 * Once polling has started, transport drops (and, with
 * `transientStatusUnreachable`, 408/429/5xx answers) are ridden out for `dropsForMs`
 * (a backend that restarts reports the turn `failed` a few minutes later),
 * and a refusal is asked again once after `renewClient`; any other failure
 * ends it. The first read's failure ends it at once, except an `unreachable`
 * one under `rideOutFirstRead`, which is ridden out the same way (the clock
 * starts at that failure) until an answer arrives.
 */
export async function collectTask(input: CollectTaskInput): Promise<CollectedTask> {
  const { signal, client, taskId } = input
  signal.throwIfAborted()
  const startedAt = Date.now()
  const options: ReadTaskOptions = { transientStatusUnreachable: input.transientStatusUnreachable }

  const pollDelay = (): number => {
    const { fastMs, slowMs, fastForMs } = collectPollDelays
    return Date.now() - startedAt < fastForMs ? fastMs : slowMs
  }
  /** One poll, asked again once after `renewClient` when refused. */
  const poll = async (): Promise<TaskRead> => {
    let next = await fetchTask(client, taskId, signal, options)
    signal.throwIfAborted()
    if (failedOf(next) === 'unauthorized' && input.renewClient) {
      input.renewClient()
      next = await fetchTask(client, taskId, signal, options)
      signal.throwIfAborted()
    }
    return next
  }

  let first = input.initial ?? await fetchTask(client, taskId, signal, options)
  signal.throwIfAborted()
  if (!input.initial && input.rideOutFirstRead && failedOf(first) === 'unreachable') {
    const failingSince = Date.now()
    while (failedOf(first) === 'unreachable') {
      if (Date.now() - failingSince >= collectPollDelays.dropsForMs) return { supported: false, reason: 'unreachable' }
      await wait(pollDelay(), signal)
      first = await poll()
    }
  }
  const firstFailure = failedOf(first)
  if (firstFailure) return { supported: false, reason: firstFailure }
  if (!hasCinnaKeys(first as TaskShape)) return { supported: false, reason: 'unsupported' }

  let task = first as TaskShape
  let droppingSince: number | null = null
  for (;;) {
    const state = task.status?.state
    if (!state) return { supported: false, reason: 'unsupported' }
    const { turn, over } = readTurn(task, state, input.clientMessageId)
    if (over) return turn

    input.onPoll?.(state)
    await wait(pollDelay(), signal)

    const next = await poll()
    const failure = failedOf(next)
    if (failure === 'unreachable') {
      droppingSince ??= Date.now()
      if (Date.now() - droppingSince >= collectPollDelays.dropsForMs) return { supported: false, reason: 'unreachable' }
      continue
    }
    if (failure) return { supported: false, reason: failure }
    droppingSince = null
    task = next as TaskShape
  }
}
