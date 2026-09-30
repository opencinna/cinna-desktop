import { create } from 'zustand'

/**
 * Which detected desktop apps (Claude Desktop, ChatGPT) the user has waved
 * away on the new-chat banner — by its X, or by connecting one.
 *
 * localStorage, not `app_settings`, for the reason `hints.store.ts` gives: a
 * cosmetic per-install flag has no business widening the settings schema. It
 * is per-install and does not sync, knowingly.
 */

export const DESKTOP_APPS_DISMISSED_KEY = 'cinna-desktop-apps-dismissed'

function load(): string[] {
  try {
    const raw = localStorage.getItem(DESKTOP_APPS_DISMISSED_KEY)
    if (!raw) return []
    const parsed: unknown = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === 'string') : []
  } catch {
    // Corrupt blob — offer again rather than break the new-chat screen.
    return []
  }
}

function save(ids: string[]): void {
  try {
    localStorage.setItem(DESKTOP_APPS_DISMISSED_KEY, JSON.stringify(ids))
  } catch {
    /* quota / private mode — the banner just comes back next launch */
  }
}

interface DesktopAppsStore {
  dismissed: string[]
  dismiss: (ids: readonly string[]) => void
}

export const useDesktopAppsStore = create<DesktopAppsStore>((set, get) => ({
  dismissed: load(),
  dismiss: (ids) => {
    const next = [...new Set([...get().dismissed, ...ids])]
    save(next)
    set({ dismissed: next })
  }
}))
