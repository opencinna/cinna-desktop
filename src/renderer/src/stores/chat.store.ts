import { create } from 'zustand'
import type {
  ContentKind,
  MessagePart,
  MessagePartFile,
  ToolStream
} from '../../../shared/messageParts'
import type { AgentStreamEvent } from '../../../shared/agentStreamEvents'
import type { MessageAttachment } from '../../../shared/attachments'

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
    file?: MessagePartFile
  }
): MessagePart[] {
  const { kind, text, toolName, toolInput, toolId, toolStream, commandInvocation, file } = delta
  const out = parts.slice()
  const last = out[out.length - 1]
  const sameKind = last && last.kind === kind
  // `file` parts are discrete attachments — never merge them, even with an
  // adjacent file part (two attachments must stay two badges).
  const mergeable =
    sameKind &&
    kind !== 'file' &&
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
    if (file) next.file = file
    out.push(next)
  }
  return out
}

interface TextBlock {
  type: 'text'
  kind: ContentKind
  content: string
  toolName?: string
  /** Structured tool arguments from `cinna.tool_input` metadata (tool kind). */
  toolInput?: Record<string, unknown>
  /** Pairing key from `cinna.tool_id` (tool + tool_result kinds). */
  toolId?: string
  /** Stream classification from `cinna.tool_stream` (tool_result only). */
  toolStream?: ToolStream
  /** Slash invocation from `cinna.command_invocation` — see MessagePart. */
  commandInvocation?: string
  /** Set only when `kind === 'file'` — agent-attached file (A2A FilePart). */
  file?: MessagePartFile
}

export type StreamBlock = TextBlock | ToolCallBlock

/**
 * Optimistic user message — rendered the instant the user sends, before the
 * persisted row arrives via the `['chat', chatId]` refetch. Keyed by a
 * snapshot of how many user rows the chat already had at send time
 * (`baselineUserCount`) rather than by content, so `MessageStream` can drop the
 * optimistic copy the moment a *new* user row appears even when its text is
 * identical to a previous turn (content-keyed dedup hid the second of two
 * identical consecutive messages until its own row refetched).
 */
export interface PendingUserMessage {
  content: string
  baselineUserCount: number
  // Attachments already ingested at send time, so the optimistic bubble shows
  // its file badges immediately — without this the badges only appear once the
  // persisted row refetches, lagging the bubble itself.
  attachments?: MessageAttachment[]
}

interface ChatStore {
  activeChatId: string | null
  streamingBlocks: StreamBlock[]
  isStreaming: boolean
  activeRequestId: string | null
  pendingUserMessage: PendingUserMessage | null
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
  setPendingUserMessage: (message: PendingUserMessage | null) => void
  appendDelta: (
    text: string,
    kind?: ContentKind,
    toolName?: string,
    toolInput?: Record<string, unknown>,
    toolId?: string,
    toolStream?: ToolStream,
    commandInvocation?: string,
    file?: MessagePartFile
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

  setPendingUserMessage: (message) =>
    set({ pendingUserMessage: message }),

  startStreaming: (requestId) =>
    // Deliberately does NOT clear `pendingUserMessage`. The optimistic user
    // bubble must stay rendered until the persisted row arrives via the
    // `['chat', chatId]` refetch — `MessageStream` suppresses it once the user
    // row count grows past `baselineUserCount` (the same "no visual gap"
    // handoff that keeps `streamingBlocks` until `clearStreamingBlocks`).
    // Clearing it here left a window where neither the optimistic bubble nor
    // the (not-yet-refetched) persisted row was visible, so the user's message
    // vanished while the assistant reply streamed in.
    set({
      isStreaming: true,
      streamingBlocks: [],
      activeRequestId: requestId,
      streamedIncrementallyChatId: null,
      sendError: null
    }),

  appendDelta: (
    text,
    kind = 'text',
    toolName,
    toolInput,
    toolId,
    toolStream,
    commandInvocation,
    file
  ) =>
    set((state) => {
      const blocks = [...state.streamingBlocks]
      const last = blocks[blocks.length - 1]
      // Mirror main-process accumulator: tool_result blocks merge on
      // (toolId, toolStream); all other text-kinds merge on toolName. `file`
      // blocks are discrete attachments and never merge.
      const sameKind = last?.type === 'text' && last.kind === kind
      const isMergeable =
        sameKind &&
        kind !== 'file' &&
        (kind === 'tool_result'
          ? last.toolId === toolId && last.toolStream === toolStream
          : last.toolName === toolName)
      if (last?.type === 'text' && isMergeable) {
        blocks[blocks.length - 1] = {
          ...last,
          content: last.content + text,
          toolInput: last.toolInput ?? toolInput,
          toolId: last.toolId ?? toolId,
          commandInvocation: last.commandInvocation ?? commandInvocation
        }
      } else {
        const next: TextBlock = { type: 'text', kind, content: text }
        if (toolName) next.toolName = toolName
        if (toolInput) next.toolInput = toolInput
        if (toolId) next.toolId = toolId
        if (toolStream) next.toolStream = toolStream
        if (commandInvocation) next.commandInvocation = commandInvocation
        if (file) next.file = file
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
                  commandInvocation: event.commandInvocation,
                  file: event.file
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
    // Keep `pendingUserMessage` set past `done`: the `done` handler keeps
    // `streamingBlocks` visible until the refetch lands, then drops both
    // together (see `useChatStream`'s `done` `.finally`) — the user bubble
    // follows the same lifecycle so there's no gap when `done` beats the
    // refetch. The post-refetch clear (not this transition) is what finally
    // retires the optimistic copy, by which point its persisted row is in view.
    set({ isStreaming: false }),

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
