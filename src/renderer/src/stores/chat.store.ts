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
  toolName?: string
}

export type StreamBlock = TextBlock | ToolCallBlock

interface ChatStore {
  activeChatId: string | null
  streamingBlocks: StreamBlock[]
  isStreaming: boolean
  activeRequestId: string | null

  setActiveChatId: (id: string | null) => void
  startStreaming: (requestId: string) => void
  appendDelta: (text: string, kind?: ContentKind, toolName?: string) => void
  addToolCall: (tc: { id: string; name: string; input: Record<string, unknown>; provider?: string }) => void
  resolveToolCall: (id: string, result: unknown) => void
  failToolCall: (id: string, error: string) => void
  stopStreaming: () => void
  reset: () => void
}


export const useChatStore = create<ChatStore>((set) => ({
  activeChatId: null,
  streamingBlocks: [],
  isStreaming: false,
  activeRequestId: null,

  setActiveChatId: (id) =>
    set({ activeChatId: id, streamingBlocks: [], isStreaming: false }),

  startStreaming: (requestId) =>
    set({ isStreaming: true, streamingBlocks: [], activeRequestId: requestId }),

  appendDelta: (text, kind = 'text', toolName) =>
    set((state) => {
      const blocks = [...state.streamingBlocks]
      const last = blocks[blocks.length - 1]
      if (last?.type === 'text' && last.kind === kind && last.toolName === toolName) {
        blocks[blocks.length - 1] = { ...last, content: last.content + text }
      } else {
        blocks.push(
          toolName
            ? { type: 'text', kind, content: text, toolName }
            : { type: 'text', kind, content: text }
        )
      }
      return { streamingBlocks: blocks }
    }),

  addToolCall: (tc) =>
    set((state) => ({
      streamingBlocks: [
        ...state.streamingBlocks,
        { type: 'tool_call', ...tc, status: 'pending' as const }
      ]
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

  stopStreaming: () =>
    set({ isStreaming: false, streamingBlocks: [], activeRequestId: null }),

  reset: () =>
    set({
      activeChatId: null,
      streamingBlocks: [],
      isStreaming: false,
      activeRequestId: null
    })
}))
