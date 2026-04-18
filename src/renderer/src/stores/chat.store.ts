import { create } from 'zustand'
import type { ContentKind } from '../../../shared/messageParts'

export type { ContentKind }

export interface ToolCallBlock {
  type: 'tool_call'
  id: string
  name: string
  input: Record<string, unknown>
  result?: unknown
  error?: string
  provider?: string
  status: 'pending' | 'done' | 'error'
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

  setActiveChatId: (id: string | null) => void
  startStreaming: (requestId: string) => void
  setPendingUserMessage: (content: string | null) => void
  appendDelta: (text: string, kind?: ContentKind, toolName?: string) => void
  addToolCall: (tc: { id: string; name: string; input: Record<string, unknown>; provider?: string }) => void
  resolveToolCall: (id: string, result: unknown) => void
  failToolCall: (id: string, error: string) => void
  finishStreaming: () => void
  clearStreamingBlocks: () => void
  stopStreaming: () => void
  reset: () => void
}


export const useChatStore = create<ChatStore>((set) => ({
  activeChatId: null,
  streamingBlocks: [],
  isStreaming: false,
  activeRequestId: null,
  pendingUserMessage: null,
  streamedIncrementallyChatId: null,

  setActiveChatId: (id) =>
    set({
      activeChatId: id,
      streamingBlocks: [],
      isStreaming: false,
      pendingUserMessage: null,
      streamedIncrementallyChatId: null
    }),

  setPendingUserMessage: (content) =>
    set({ pendingUserMessage: content }),

  startStreaming: (requestId) =>
    set({
      isStreaming: true,
      streamingBlocks: [],
      activeRequestId: requestId,
      pendingUserMessage: null,
      streamedIncrementallyChatId: null
    }),

  appendDelta: (text, kind = 'text', toolName) =>
    set((state) => {
      const blocks = [...state.streamingBlocks]
      const last = blocks[blocks.length - 1]
      if (last?.type === 'text' && last.kind === kind && last.toolName === toolName) {
        blocks[blocks.length - 1] = {
          ...last,
          content: last.content + text,
          segments: [...last.segments, text]
        }
      } else {
        blocks.push(
          toolName
            ? { type: 'text', kind, content: text, segments: [text], toolName }
            : { type: 'text', kind, content: text, segments: [text] }
        )
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

  reset: () =>
    set({
      activeChatId: null,
      streamingBlocks: [],
      isStreaming: false,
      activeRequestId: null,
      pendingUserMessage: null,
      streamedIncrementallyChatId: null
    })
}))
