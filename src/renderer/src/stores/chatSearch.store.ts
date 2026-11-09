import { create } from 'zustand'

/**
 * Chat search, one per window. `scope` is what is open: one chat's search (its
 * bar sits over that transcript) or the all-chats overlay. The query and the
 * agent filter outlive a close, so ⌘F reopens where the user left off — until
 * the window reloads.
 */
export type ChatSearchScope = 'chat' | 'all'

/** A result picked in the all-chats overlay, for the transcript to scroll to once it shows. */
export interface ChatSearchJump {
  chatId: string
  /** Null: no one message ("N older in this chat") — the chat opens with its own search on the query. */
  messageId: string | null
  query: string
  /** A pick of the same message twice is two jumps. */
  nonce: number
}

interface ChatSearchState {
  scope: ChatSearchScope | null
  query: string
  /** Who-keys (`agent:<id>`, `mode:<id>`, `none`) the all-chats results are limited to; empty = every one. */
  agents: string[]
  /** Bumped on every open, so an open search re-focuses and selects its query. */
  focusNonce: number
  /** The chat whose transcript is on screen in the chat view; null when none. */
  searchableChatId: string | null
  jump: ChatSearchJump | null
  /** Chat scope needs a transcript on screen; without one it opens all chats. */
  open: (scope: ChatSearchScope) => void
  close: () => void
  setQuery: (query: string) => void
  toggleAgent: (key: string) => void
  clearAgents: () => void
  /** The chat view's transcript says which chat it shows. Another chat closes a chat search. */
  setSearchableChatId: (chatId: string | null) => void
  requestJump: (jump: Omit<ChatSearchJump, 'nonce'>) => void
  clearJump: (nonce: number) => void
}

let nonce = 0

export const useChatSearchStore = create<ChatSearchState>((set, get) => ({
  scope: null,
  query: '',
  agents: [],
  focusNonce: 0,
  searchableChatId: null,
  jump: null,
  open: (scope) =>
    set((state) => ({
      scope: scope === 'chat' && !state.searchableChatId ? 'all' : scope,
      focusNonce: state.focusNonce + 1
    })),
  close: () => set({ scope: null }),
  setQuery: (query) => set({ query }),
  toggleAgent: (key) =>
    set((state) => ({
      agents: state.agents.includes(key) ? state.agents.filter((k) => k !== key) : [...state.agents, key]
    })),
  clearAgents: () => set({ agents: [] }),
  setSearchableChatId: (chatId) => {
    const state = get()
    if (state.searchableChatId === chatId) return
    set({ searchableChatId: chatId, ...(state.scope === 'chat' ? { scope: null } : {}) })
  },
  requestJump: (jump) => set({ jump: { ...jump, nonce: ++nonce } }),
  clearJump: (done) => set((state) => (state.jump?.nonce === done ? { jump: null } : {}))
}))
