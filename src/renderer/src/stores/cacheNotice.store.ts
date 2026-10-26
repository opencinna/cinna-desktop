import { create } from 'zustand'

/**
 * Which prompt-cache notices the user waved away, per chat: the chat's
 * `cache.lastRequestAt` at the time. The notice is keyed by that reading, so it
 * comes back only once the chat has been used and gone idle again.
 *
 * localStorage, not `app_settings`, for the reason `hints.store.ts` gives: a
 * cosmetic per-install flag has no business widening the settings schema.
 * One entry per chat (a newer dismissal replaces the older one), and at most
 * {@link MAX_ENTRIES} chats, the oldest readings dropped first.
 */

export const CACHE_NOTICE_DISMISSED_KEY = 'cinna-cache-notice-dismissed'
const MAX_ENTRIES = 200

type Dismissed = Record<string, number>

function load(): Dismissed {
  try {
    const raw = localStorage.getItem(CACHE_NOTICE_DISMISSED_KEY)
    if (!raw) return {}
    const parsed: unknown = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    return Object.fromEntries(
      Object.entries(parsed as Record<string, unknown>).filter((entry): entry is [string, number] => typeof entry[1] === 'number')
    )
  } catch {
    // Corrupt blob — show the notice again rather than break the composer.
    return {}
  }
}

function save(dismissed: Dismissed): void {
  try {
    localStorage.setItem(CACHE_NOTICE_DISMISSED_KEY, JSON.stringify(dismissed))
  } catch {
    /* quota / private mode — the notice just comes back next launch */
  }
}

interface CacheNoticeStore {
  /** chatId → the `lastRequestAt` the notice was dismissed for. */
  dismissed: Dismissed
  dismiss: (chatId: string, lastRequestAt: number) => void
}

export const useCacheNoticeStore = create<CacheNoticeStore>((set, get) => ({
  dismissed: load(),
  dismiss: (chatId, lastRequestAt) => {
    const entries = Object.entries({ ...get().dismissed, [chatId]: lastRequestAt })
    const next = Object.fromEntries(
      entries.length > MAX_ENTRIES ? entries.sort((a, b) => b[1] - a[1]).slice(0, MAX_ENTRIES) : entries
    )
    save(next)
    set({ dismissed: next })
  }
}))
