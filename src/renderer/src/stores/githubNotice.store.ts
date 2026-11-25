import { create } from 'zustand'

/**
 * The composer's GitHub rows, per chat, in renderer memory only (never persisted): which needs a
 * chat has shown, so one that clears while the chat is open or away (a sign-in from Settings,
 * another chat, a coverage read) turns into "GitHub is connected" + Continue in that chat.
 */
interface GithubNoticeState {
  /** Need keys last shown in each chat. */
  seen: Record<string, string[]>
  /** Chats whose shown need has since cleared, waiting on Continue or ×. */
  resolved: Record<string, true>
  /** Record what a chat shows now; whether a key it showed before is gone. */
  see: (chatId: string, keys: string[]) => string[]
  /** Forget one key without resolving (the user dismissed that row). */
  forget: (chatId: string, key: string) => void
  resolve: (chatId: string) => void
  /** Continue sent, or × pressed. */
  clearResolved: (chatId: string) => void
}

const same = (a: readonly string[], b: readonly string[]): boolean => a.length === b.length && a.every((k, i) => k === b[i])

export const useGithubNoticeStore = create<GithubNoticeState>((set, get) => ({
  seen: {},
  resolved: {},
  see: (chatId, keys) => {
    const before = get().seen[chatId] ?? []
    const gone = before.filter((k) => !keys.includes(k))
    if (!same(before, keys)) set((s) => ({ seen: { ...s.seen, [chatId]: keys } }))
    return gone
  },
  forget: (chatId, key) => set((s) => ({ seen: { ...s.seen, [chatId]: (s.seen[chatId] ?? []).filter((k) => k !== key) } })),
  resolve: (chatId) => { if (!get().resolved[chatId]) set((s) => ({ resolved: { ...s.resolved, [chatId]: true } })) },
  clearResolved: (chatId) => {
    if (!get().resolved[chatId]) return
    set((s) => {
      const resolved = { ...s.resolved }
      delete resolved[chatId]
      return { resolved }
    })
  }
}))
