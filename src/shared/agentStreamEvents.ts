/**
 * Wire contract for the agent-side streaming `MessagePort` channel. Every
 * `port.postMessage(...)` from the A2A pipeline (`a2aStreamingService`,
 * `StreamPartsAccumulator`, and `agent_a2a.ipc.ts` failure paths) must produce
 * an `AgentStreamEvent`, and the renderer's `useChatStream.handleAgent`
 * consumes the same union. Adding a new event variant — or a new optional
 * field on an existing variant — requires updating this file, which gives the
 * compiler a chance to flag drift between sender and receiver.
 *
 * Pure type-only module: imported from both Electron processes and the
 * renderer; no runtime dependencies.
 */
import type { ContentKind, ToolStream } from './messageParts'

/** Emitted exactly once before any other event so the renderer can track the request id (used by `cancelMessage`). */
export interface AgentRequestIdEvent {
  type: 'request-id'
  requestId: string
}

/**
 * A2A task lifecycle states as defined by the v0.3 schema. Mirrors the SDK's
 * `TaskState` union inline so this module stays free of main-process deps
 * (the SDK type lives in `@a2a-js/sdk/...`, which the renderer must not
 * pull in). Includes `'unknown'` for forward compatibility — when the SDK
 * adds a state, the desktop treats it as 'unknown' until this union is
 * extended.
 */
export type AgentTaskState =
  | 'submitted'
  | 'working'
  | 'input-required'
  | 'completed'
  | 'canceled'
  | 'failed'
  | 'rejected'
  | 'auth-required'
  | 'unknown'

/** A2A `status-update` events — task lifecycle / context bookkeeping. */
export interface AgentStatusEvent {
  type: 'status'
  state: AgentTaskState
  taskId?: string
  contextId?: string
}

/**
 * One streaming text fragment, already de-duped to a true delta by the
 * accumulator. The `kind` discriminator routes the fragment to the matching
 * renderer block. `cinna.command_invocation` (always set for `command_result`,
 * set on `tool` / `tool_result` only when the pair was synthesized to wrap a
 * `/run:*` execution) flows through `commandInvocation`.
 */
export interface AgentDeltaEvent {
  type: 'delta'
  kind: ContentKind
  text: string
  toolName?: string
  toolInput?: Record<string, unknown>
  toolId?: string
  toolStream?: ToolStream
  commandInvocation?: string
}

/** Stream terminated cleanly — renderer drains the cache and clears streaming blocks. */
export interface AgentDoneEvent {
  type: 'done'
}

/**
 * Stream aborted with an error. `error` is the user-facing short message;
 * full detail (if any) is logged main-side, not sent over the port.
 */
export interface AgentErrorEvent {
  type: 'error'
  error: string
}

export type AgentStreamEvent =
  | AgentRequestIdEvent
  | AgentStatusEvent
  | AgentDeltaEvent
  | AgentDoneEvent
  | AgentErrorEvent

/**
 * Defense-in-depth runtime guard used at the contextBridge boundary
 * (`src/preload/index.ts`). Filters out off-contract messages before the
 * renderer's `handleAgent` switch sees them, so a sender regression
 * (or a non-Cinna sender on the port) can't poison the receiver state.
 *
 * Intentionally lenient: only checks the discriminator, not every field.
 * If a sender ships a recognised `type` with a wrong-shaped payload, the
 * receiver's switch will branch into the right case and TypeScript-narrow
 * fields — wrong values will surface as visible errors there, not as
 * silently-dropped events.
 */
export function isAgentStreamEvent(x: unknown): x is AgentStreamEvent {
  if (!x || typeof x !== 'object') return false
  const t = (x as { type?: unknown }).type
  return (
    t === 'request-id' ||
    t === 'status' ||
    t === 'delta' ||
    t === 'done' ||
    t === 'error'
  )
}
