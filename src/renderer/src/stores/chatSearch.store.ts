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
  /** Closes, and gives focus back to what had it before the search opened. */
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

/** What had focus when the search opened: it gets it back on close. */
let focusBefore: HTMLElement | null = null

/**
 * Back to what had focus before the search opened, while it is still in the
 * document; else the composer of the chat on screen (any composer without
 * one). Never left on the body, which is where removing the focused search
 * field would put it.
 */
function restoreFocus(chatId: string | null): void {
  const before = focusBefore
  focusBefore = null
  if (typeof document === 'undefined') return
  // Without scrolling: the transcript was just scrolled to a picked result.
  if (before && before.isConnected && before !== document.body) {
    before.focus({ preventScroll: true })
    if (document.activeElement === before) return
  }
  const composers = [...document.querySelectorAll<HTMLElement>('textarea[data-chat-composer]')]
  const composer = composers.find((el) => el.getAttribute('data-chat-composer') === chatId) ?? composers[0]
  composer?.focus({ preventScroll: true })
}

export const useChatSearchStore = create<ChatSearchState>((set, get) => ({
  scope: null,
  query: '',
  agents: [],
  focusNonce: 0,
  searchableChatId: null,
  jump: null,
  open: (scope) => {
    if (get().scope === null && typeof document !== 'undefined') {
      const active = document.activeElement
      focusBefore = active instanceof HTMLElement && !active.closest('[data-chat-search]') ? active : null
    }
    set((state) => ({
      scope: scope === 'chat' && !state.searchableChatId ? 'all' : scope,
      focusNonce: state.focusNonce + 1
    }))
  },
  close: () => {
    if (get().scope === null) return
    set({ scope: null })
    restoreFocus(get().searchableChatId)
  },
  setQuery: (query) => set({ query }),
  toggleAgent: (key) =>
    set((state) => ({
      agents: state.agents.includes(key) ? state.agents.filter((k) => k !== key) : [...state.agents, key]
    })),
  clearAgents: () => set({ agents: [] }),
  setSearchableChatId: (chatId) => {
    const state = get()
    if (state.searchableChatId === chatId) return
    set({
      searchableChatId: chatId,
      ...(state.scope === 'chat' ? { scope: null } : {}),
      // A jump waiting for another chat is stale: the user went elsewhere
      // before it fired, and it must not fire on a later visit there. Not on
      // null — the old transcript lets go before the picked chat's mounts.
      ...(chatId !== null && state.jump && state.jump.chatId !== chatId ? { jump: null } : {})
    })
  },
  requestJump: (jump) => set({ jump: { ...jump, nonce: ++nonce } }),
  clearJump: (done) => set((state) => (state.jump?.nonce === done ? { jump: null } : {}))
}))
