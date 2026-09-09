import { create } from 'zustand'
import type { AgentsHomeAccess } from '../../../shared/localAgents'

type Unresolved = Exclude<AgentsHomeAccess, 'ready'>

/**
 * Whether the agents-folder question is currently on screen.
 *
 * A store rather than local state in the modal, because the two halves are in
 * different places: what *raises* the question is a surface that wanted the
 * agents folder (the Agents tab, Settings), and what *asks* it is a modal
 * mounted once at the top of the app so it survives the user navigating away
 * from whatever asked.
 *
 * Demand-driven on purpose. Main can answer "the folder does not exist yet"
 * from the moment the app starts, and a modal that acted on that would explain
 * the agents folder to someone who is still signing in — the same
 * out-of-nowhere interruption the macOS prompt was, only ours. Nothing opens
 * this until the user has done something that needs the folder.
 */
interface AgentsHomeStore {
  /** `null` while nothing is asking. Otherwise why we are asking. */
  ask: Unresolved | null
  /**
   * Questions the user has put away in this window.
   *
   * The surfaces that raise the question do it from an effect that runs on
   * every render where the list has data — and the agents list re-renders and
   * refetches often: a watcher push invalidates it, and a second consumer
   * mounting (Settings beside the sidebar) fires the effect again with the same
   * stale answer. Without this, "Not now" would last until the next one of
   * those and the modal would reappear on its own, over whatever the user had
   * moved on to. A *different* question — the folder was refused, having only
   * been unexplained before — is still worth raising.
   */
  dismissed: Unresolved[]
  /**
   * Raise the question, unless it is one already put away. `ready` clears
   * everything: it is the signal that the folder now exists, which is the only
   * thing that makes the earlier answers stale.
   */
  request: (access: AgentsHomeAccess) => void
  /** Ask again from a button the user pressed, dismissal notwithstanding. */
  reopen: (access: Unresolved) => void
  /** Put it away without answering. Every surface that raises it keeps a way back. */
  dismiss: () => void
}

export const useAgentsHomeStore = create<AgentsHomeStore>((set) => ({
  ask: null,
  dismissed: [],

  request: (access) =>
    set((s) => {
      if (access === 'ready') return { ask: null, dismissed: [] }
      if (s.ask === access || s.dismissed.includes(access)) return s
      return { ask: access }
    }),

  reopen: (access) => set((s) => ({ ask: access, dismissed: s.dismissed.filter((d) => d !== access) })),

  dismiss: () =>
    set((s) => ({
      ask: null,
      dismissed: s.ask && !s.dismissed.includes(s.ask) ? [...s.dismissed, s.ask] : s.dismissed
    }))
}))
