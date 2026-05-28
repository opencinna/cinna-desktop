/**
 * Wire contract for the LLM-side streaming `MessagePort` channel (analogous
 * to `agentStreamEvents.ts` for the A2A pipeline). Every `port.postMessage`
 * from `chatStreamingService` and the LLM IPC handler must produce an
 * `LlmStreamEvent`, and the renderer's `useChatStream.handleLlm` consumes
 * the same union. Distinct from `AgentStreamEvent`: LLM deltas are
 * text-only (no `kind` discriminator), tool calls flow as `tool_use` /
 * `tool_result` / `tool_error` events keyed by the provider's tool-call id
 * (not the A2A `cinna.tool_id` pairing).
 *
 * Pure type-only module: imported from both Electron processes and the
 * renderer; no runtime dependencies.
 */
import type { AgentStreamEvent } from './agentStreamEvents'

/** Emitted exactly once before any other event so the renderer can track the request id (used by `cancel`). */
export interface LlmRequestIdEvent {
  type: 'request-id'
  requestId: string
}

/** One LLM text delta — appended to the streaming assistant bubble. */
export interface LlmDeltaEvent {
  type: 'delta'
  text: string
}

/**
 * The LLM decided to invoke a tool. Sent before `mcpManager.callTool`
 * resolves so the renderer can render a pending `ToolCallBlock`. `provider`
 * is the MCP provider's display name (empty string when unknown).
 */
export interface LlmToolUseEvent {
  type: 'tool_use'
  id: string
  name: string
  input: Record<string, unknown>
  provider?: string
  /**
   * Tool source. `'agent'` tools render as an expandable sub-thread (their
   * `AgentStreamEvent`s arrive as `tool_subevent`s keyed by `id`); `'mcp'`
   * tools render as the ordinary tool-call block.
   */
  providerType?: 'mcp' | 'agent'
  /** Agent id backing an agent tool — drives the sub-thread's hash color. */
  providerAgentId?: string
}

/** Tool call resolved successfully — pairs with the originating `tool_use` by `id`. */
export interface LlmToolResultEvent {
  type: 'tool_result'
  id: string
  result: unknown
}

/** Tool call failed — same pairing by `id`. */
export interface LlmToolErrorEvent {
  type: 'tool_error'
  id: string
  error: string
}

/**
 * A nested A2A stream event from an agent-backed tool call (orchestrated
 * mode). When the orchestrator LLM calls an agent tool, the agent's own
 * `AgentStreamEvent`s (thinking / tool / tool_result / status deltas) are
 * wrapped here keyed by the orchestrator's `toolCallId`, so the renderer can
 * stream them into an expandable sub-thread under that tool-call block. The
 * orchestrator's own tool result stays compact — this is UI-only fidelity.
 */
export interface LlmToolSubEvent {
  type: 'tool_subevent'
  toolCallId: string
  event: AgentStreamEvent
}

/** Stream terminated cleanly. */
export interface LlmDoneEvent {
  type: 'done'
}

/**
 * Stream aborted with an error. `error` is the user-facing short message;
 * `errorDetail` carries the parsed adapter detail when available (used by
 * the renderer to power the "Details" disclosure on a SystemMessage row).
 */
export interface LlmErrorEvent {
  type: 'error'
  error: string
  errorDetail?: string
}

export type LlmStreamEvent =
  | LlmRequestIdEvent
  | LlmDeltaEvent
  | LlmToolUseEvent
  | LlmToolResultEvent
  | LlmToolErrorEvent
  | LlmToolSubEvent
  | LlmDoneEvent
  | LlmErrorEvent

/**
 * Defense-in-depth runtime guard used at the contextBridge boundary
 * (`src/preload/index.ts`). See `isAgentStreamEvent` for the rationale —
 * same pattern, distinct discriminator set.
 */
export function isLlmStreamEvent(x: unknown): x is LlmStreamEvent {
  if (!x || typeof x !== 'object') return false
  const t = (x as { type?: unknown }).type
  return (
    t === 'request-id' ||
    t === 'delta' ||
    t === 'tool_use' ||
    t === 'tool_result' ||
    t === 'tool_error' ||
    t === 'tool_subevent' ||
    t === 'done' ||
    t === 'error'
  )
}
