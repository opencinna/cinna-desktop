import { create } from 'zustand'
import type { ContentKind, MessagePart, ToolStream } from '../../../shared/messageParts'
import type { AgentStreamEvent } from '../../../shared/agentStreamEvents'

export type { ContentKind, ToolStream }

export interface ToolCallBlock {
  type: 'tool_call'
  id: string
  name: string
  input: Record<string, unknown>
  result?: unknown
  error?: string
  provider?: string
  status: 'pending' | 'done' | 'error'
  /** Tool source — `'agent'` tools accumulate a `subParts` sub-thread. */
  providerType?: 'mcp' | 'agent'
  /** Agent id backing an agent tool — drives the sub-thread hash color. */
  agentId?: string
  /**
   * Live agent sub-thread (orchestrated mode): the agent's `parts[]` built up
   * from `tool_subevent` deltas keyed by this block's `id`. Rendered as a
   * nested `<AgentContribution>` inside the tool-call block.
   */
  subParts?: MessagePart[]
}

/**
 * Apply one A2A delta to a `MessagePart[]`, mirroring the main-process
 * `StreamPartsAccumulator.appendToList` merge rules so the live sub-thread
 * matches what gets persisted on the tool_call row.
 */
function appendAgentDeltaPart(
  parts: MessagePart[],
  delta: {
    kind: ContentKind
    text: string
    toolName?: string
    toolInput?: Record<string, unknown>
    toolId?: string
    toolStream?: ToolStream
    commandInvocation?: string
  }
): MessagePart[] {
  const { kind, text, toolName, toolInput, toolId, toolStream, commandInvocation } = delta
  const out = parts.slice()
  const last = out[out.length - 1]
  const sameKind = last && last.kind === kind
  const mergeable =
    sameKind &&
    (kind === 'tool_result'
      ? last.toolId === toolId && last.toolStream === toolStream
      : last.toolName === toolName)
  if (last && mergeable) {
    out[out.length - 1] = {
      ...last,
      text: last.text + text,
      toolInput: last.toolInput ?? toolInput,
      toolId: last.toolId ?? toolId,
      commandInvocation: last.commandInvocation ?? commandInvocation
    }
  } else {
    const next: MessagePart = { kind, text }
    if (toolName) next.toolName = toolName
    if (toolInput) next.toolInput = toolInput
    if (toolId) next.toolId = toolId
    if (toolStream) next.toolStream = toolStream
    if (commandInvocation) next.commandInvocation = commandInvocation
    out.push(next)
  }
  return out
}

interface TextBlock {
  type: 'text'
  kind: ContentKind
  content: string
  // One entry per received delta — rendered as separate animated spans so each
  // arriving chunk fades in with the same reveal animation used for a full
  // assistant message, instead of silently growing the content string.
  segments: string[]
  toolName?: string
  /** Structured tool arguments from `cinna.tool_input` metadata (tool kind). */
  toolInput?: Record<string, unknown>
  /** Pairing key from `cinna.tool_id` (tool + tool_result kinds). */
  toolId?: string
  /** Stream classification from `cinna.tool_stream` (tool_result only). */
  toolStream?: ToolStream
  /** Slash invocation from `cinna.command_invocation` — see MessagePart. */
  commandInvocation?: string
}

export type StreamBlock = TextBlock | ToolCallBlock

interface ChatStore {
  activeChatId: string | null
  streamingBlocks: StreamBlock[]
  isStreaming: boolean
  activeRequestId: string | null
  pendingUserMessage: string | null
  // Chat ID of the most recent stream that produced gradual deltas. Scoped
  // per-chat so MessageStream only suppresses the DB-arrival fade-in for the
  // exact chat whose stream just finished — out-of-band message arrivals on
  // other chats still animate normally.
  streamedIncrementallyChatId: string | null
  // User-facing send error surfaced above the chat input (e.g. "no provider
  // configured"). Set by the new-chat pre-flight check and by stream `error`
  // events; cleared on next user action.
  sendError: string | null

  setActiveChatId: (id: string | null) => void
  startStreaming: (requestId: string) => void
  setPendingUserMessage: (content: string | null) => void
  appendDelta: (
    text: string,
    kind?: ContentKind,
    toolName?: string,
    toolInput?: Record<string, unknown>,
    toolId?: string,
    toolStream?: ToolStream,
    commandInvocation?: string
  ) => void
  addToolCall: (tc: {
    id: string
    name: string
    input: Record<string, unknown>
    provider?: string
    providerType?: 'mcp' | 'agent'
    agentId?: string
  }) => void
  resolveToolCall: (id: string, result: unknown) => void
  failToolCall: (id: string, error: string) => void
  /** Accumulate one nested A2A stream event into an agent tool's sub-thread. */
  appendToolSubEvent: (toolCallId: string, event: AgentStreamEvent) => void
  finishStreaming: () => void
  clearStreamingBlocks: () => void
  stopStreaming: () => void
  setSendError: (error: string | null) => void
  reset: () => void
}


export const useChatStore = create<ChatStore>((set) => ({
  activeChatId: null,
  streamingBlocks: [],
  isStreaming: false,
  activeRequestId: null,
  pendingUserMessage: null,
  streamedIncrementallyChatId: null,
  sendError: null,

  setActiveChatId: (id) =>
    set({
      activeChatId: id,
      streamingBlocks: [],
      isStreaming: false,
      pendingUserMessage: null,
      streamedIncrementallyChatId: null,
      sendError: null
    }),

  setPendingUserMessage: (content) =>
    set({ pendingUserMessage: content }),

  startStreaming: (requestId) =>
    set({
      isStreaming: true,
      streamingBlocks: [],
      activeRequestId: requestId,
      pendingUserMessage: null,
      streamedIncrementallyChatId: null,
      sendError: null
    }),

  appendDelta: (text, kind = 'text', toolName, toolInput, toolId, toolStream, commandInvocation) =>
    set((state) => {
      const blocks = [...state.streamingBlocks]
      const last = blocks[blocks.length - 1]
      // Mirror main-process accumulator: tool_result blocks merge on
      // (toolId, toolStream); all other text-kinds merge on toolName.
      const sameKind = last?.type === 'text' && last.kind === kind
      const isMergeable =
        sameKind &&
        (kind === 'tool_result'
          ? last.toolId === toolId && last.toolStream === toolStream
          : last.toolName === toolName)
      if (last?.type === 'text' && isMergeable) {
        blocks[blocks.length - 1] = {
          ...last,
          content: last.content + text,
          segments: [...last.segments, text],
          toolInput: last.toolInput ?? toolInput,
          toolId: last.toolId ?? toolId,
          commandInvocation: last.commandInvocation ?? commandInvocation
        }
      } else {
        const next: TextBlock = { type: 'text', kind, content: text, segments: [text] }
        if (toolName) next.toolName = toolName
        if (toolInput) next.toolInput = toolInput
        if (toolId) next.toolId = toolId
        if (toolStream) next.toolStream = toolStream
        if (commandInvocation) next.commandInvocation = commandInvocation
        blocks.push(next)
      }
      return {
        streamingBlocks: blocks,
        streamedIncrementallyChatId: state.activeChatId
      }
    }),

  addToolCall: (tc) =>
    set((state) => ({
      streamingBlocks: [
        ...state.streamingBlocks,
        { type: 'tool_call', ...tc, status: 'pending' as const }
      ],
      streamedIncrementallyChatId: state.activeChatId
    })),

  appendToolSubEvent: (toolCallId, event) =>
    set((state) => {
      // Only `delta` events carry parts. Notices are agent-side system pings,
      // excluded from the persisted `parts[]` — skip them here too so the live
      // sub-thread matches the reloaded one.
      if (event.type !== 'delta' || event.kind === 'notice') return state
      return {
        streamingBlocks: state.streamingBlocks.map((b) =>
          b.type === 'tool_call' && b.id === toolCallId
            ? {
                ...b,
                subParts: appendAgentDeltaPart(b.subParts ?? [], {
                  kind: event.kind,
                  text: event.text,
                  toolName: event.toolName,
                  toolInput: event.toolInput,
                  toolId: event.toolId,
                  toolStream: event.toolStream,
                  commandInvocation: event.commandInvocation
                })
              }
            : b
        ),
        streamedIncrementallyChatId: state.activeChatId
      }
    }),

  resolveToolCall: (id, result) =>
    set((state) => ({
      streamingBlocks: state.streamingBlocks.map((b) =>
        b.type === 'tool_call' && b.id === id ? { ...b, result, status: 'done' as const } : b
      )
    })),

  failToolCall: (id, error) =>
    set((state) => ({
      streamingBlocks: state.streamingBlocks.map((b) =>
        b.type === 'tool_call' && b.id === id ? { ...b, error, status: 'error' as const } : b
      )
    })),

  finishStreaming: () =>
    set({ isStreaming: false, pendingUserMessage: null }),

  clearStreamingBlocks: () =>
    set({ streamingBlocks: [], activeRequestId: null }),

  stopStreaming: () =>
    set({
      isStreaming: false,
      streamingBlocks: [],
      activeRequestId: null,
      pendingUserMessage: null,
      streamedIncrementallyChatId: null
    }),

  setSendError: (error) => set({ sendError: error }),

  reset: () =>
    set({
      activeChatId: null,
      streamingBlocks: [],
      isStreaming: false,
      activeRequestId: null,
      pendingUserMessage: null,
      streamedIncrementallyChatId: null,
      sendError: null
    })
}))
