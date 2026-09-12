/**
 * The one stream vocabulary. Every `MessagePort` that carries a turn — a direct
 * agent chat (`agent:send-message`) and an LLM chat (`llm:send-message`) — posts
 * `RunEvent`s, the preload bridge filters them with {@link isRunEvent}, and the
 * renderer's selected-chat watcher replays them through `useRunEventHandler`.
 *
 * Replaces `AgentStreamEvent`, `LlmStreamEvent` and the `tool_subevent` nesting
 * (agent runtime plan, phase 1). They were three unions for one thing: an LLM
 * delta is an agent delta with `kind: 'text'`, and a nested agent's work is a
 * `child` event carrying the same vocabulary rather than a second one.
 *
 * Pure type-only module plus the guard: imported from both Electron processes
 * and the renderer; no runtime dependencies.
 */
import type { ContentKind, MessagePartFile, ToolStream } from './messageParts'
import type { RequestResolution } from './localAgentRequests'

/**
 * Where a run is, in protocol-neutral terms.
 *
 * A2A's `input-required` and `auth-required` both become `needs_input`; which
 * of the two it was is on the {@link RunNeedsInputEvent} that follows. An A2A
 * state this union does not know arrives as `unknown`.
 */
export type RunState =
  | 'submitted'
  | 'working'
  | 'needs_input'
  | 'completed'
  | 'failed'
  | 'canceled'
  | 'rejected'
  | 'unknown'

/** One question in a {@link InputRequest} of kind `question`. */
export interface InputQuestion {
  question: string
  /** Short tag shown next to the question. */
  header?: string
  /** true → pick any number of options; false → pick one. */
  multiSelect: boolean
  /** Empty for an open question answered in free text. */
  options: { label: string; description?: string }[]
}

/** What a run is waiting on a human for. */
export type InputRequest =
  | {
      kind: 'permission'
      allowRemember?: boolean
      /** The engine's coarse operation — `bash`, `edit`, `Bash`, `WebFetch`, … */
      action: string
      /** What it wants to touch: a command line, a path, a URL. */
      resources: string[]
      /** The tool call that raised it, when the engine named one. */
      callId?: string
    }
  | { kind: 'question'; questions: InputQuestion[] }
  | { kind: 'auth'; message: string; method?: string; url?: string }
  | { kind: 'elicitation'; message: string; schema: Record<string, unknown> }

/**
 * How the answer gets back.
 *
 * - `reply` — the run is parked and answerable **now**, by request id, through
 *   `agent:answer-request` (OpenCode, the Claude ask callback). The address dies
 *   with the turn.
 * - `next_message` — the protocol ended the turn, and the answer is the user's
 *   next message (A2A `input-required` / `auth-required`).
 */
export type InputResumeMode = 'reply' | 'next_message'

/** Why a run ended cleanly. */
export type RunStopReason = 'end_turn' | 'canceled' | 'budget' | 'error'

/** Emitted exactly once before any other event so the renderer can track the request id (used by cancel). */
export interface RunRequestIdEvent {
  type: 'request-id'
  requestId: string
}

/** Task lifecycle / context bookkeeping. Posted by protocols that have a task (A2A). */
export interface RunStatusEvent {
  type: 'status'
  state: RunState
  taskId?: string
  contextId?: string
}

/**
 * One streaming fragment, already de-duped to a true delta. `kind` routes it to
 * the matching renderer block; an LLM's text is `kind: 'text'` with no other
 * field set. `commandInvocation` is set on `command_result`, and on `tool` /
 * `tool_result` only when the pair wraps a `/run:*` execution.
 */
export interface RunDeltaEvent {
  type: 'delta'
  kind: ContentKind
  text: string
  toolName?: string
  toolInput?: Record<string, unknown>
  toolId?: string
  toolStream?: ToolStream
  commandInvocation?: string
  /**
   * Set only when `kind === 'file'` — an agent-attached file. `text` is empty;
   * each file delta is a complete attachment.
   */
  file?: MessagePartFile
}

/**
 * The local LLM decided to call a tool. Posted before the call resolves so the
 * renderer can show a pending block. `provider` is the provider's display name.
 */
export interface RunToolUseEvent {
  type: 'tool_use'
  id: string
  name: string
  input: Record<string, unknown>
  provider?: string
  /**
   * `'agent'` tools render as an expandable sub-thread (their work arrives as
   * `child` events keyed by `id`); `'mcp'` tools as the ordinary tool block.
   */
  providerType?: 'mcp' | 'agent' | 'coordinator'
  /** Agent id backing an agent tool — drives the sub-thread's hash color. */
  providerAgentId?: string
}

/** A tool call resolved — pairs with its `tool_use` by `id`. */
export interface RunToolResultEvent {
  type: 'tool_result'
  id: string
  result: unknown
}

/** A tool call failed — same pairing by `id`. */
export interface RunToolErrorEvent {
  type: 'tool_error'
  id: string
  error: string
}

/**
 * The run is waiting on a human.
 *
 * Posted **after** the transcript part that shows the ask (for a local agent,
 * the `tool` part named in `localAgentRequests.ts`), so the block exists before
 * it becomes answerable. Persisted transcripts carry no event; they still
 * recognise an ask by its reserved tool name and `per_` / `que_` id.
 */
export interface RunNeedsInputEvent {
  type: 'needs_input'
  /** The address an answer is posted to (`reply`), or the task that is waiting (`next_message`). */
  requestId: string
  request: InputRequest
  resume: InputResumeMode
}

/** A `reply`-mode ask was settled — answered, rejected, expired, or answered elsewhere. */
export interface RunInputResolvedEvent {
  type: 'input_resolved'
  requestId: string
  resolution: RequestResolution
}

/**
 * One event from a nested agent run — an agent the local LLM called as a tool.
 * Keyed by the orchestrator's `toolCallId`, so the renderer streams it into that
 * tool block's sub-thread. UI-only fidelity: the orchestrator's own tool result
 * stays compact.
 */
export interface RunChildEvent {
  type: 'child'
  toolCallId: string
  agentId: string
  event: RunEvent
}

/** The run ended cleanly. */
export interface RunDoneEvent {
  type: 'done'
  stopReason?: RunStopReason
}

/**
 * The run failed. `error` is the user-facing short message. `code` is a
 * machine-readable discriminator (e.g. `'cinna_reauth_required'`) so a surface
 * can branch on intent without matching copy; `errorDetail` is the parsed
 * adapter detail behind a SystemMessage's "Details" disclosure.
 */
export interface RunErrorEvent {
  type: 'error'
  error: string
  code?: string
  errorDetail?: string
}

export type RunEvent =
  | RunRequestIdEvent
  | RunStatusEvent
  | RunDeltaEvent
  | RunToolUseEvent
  | RunToolResultEvent
  | RunToolErrorEvent
  | RunNeedsInputEvent
  | RunInputResolvedEvent
  | RunChildEvent
  | RunDoneEvent
  | RunErrorEvent

/**
 * Every discriminator, as a record so adding a variant to {@link RunEvent}
 * fails the typecheck here until the guard knows it.
 */
const RUN_EVENT_TYPES: Record<RunEvent['type'], true> = {
  'request-id': true,
  status: true,
  delta: true,
  tool_use: true,
  tool_result: true,
  tool_error: true,
  needs_input: true,
  input_resolved: true,
  child: true,
  done: true,
  error: true
}

/**
 * Defense-in-depth runtime guard at the contextBridge boundary
 * (`src/preload/index.ts`). Drops off-contract messages before the renderer's
 * switch sees them, so a sender regression — or a non-Cinna sender on the port
 * — cannot poison receiver state.
 *
 * Checks the discriminator only. A recognised `type` with a wrong-shaped
 * payload branches into the right case, where the wrong values surface as
 * visible errors rather than silently dropped events.
 */
export function isRunEvent(x: unknown): x is RunEvent {
  if (!x || typeof x !== 'object') return false
  const t = (x as { type?: unknown }).type
  return typeof t === 'string' && Object.prototype.hasOwnProperty.call(RUN_EVENT_TYPES, t)
}
