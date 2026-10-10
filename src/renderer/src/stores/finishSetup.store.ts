import { create } from 'zustand'
import type { AgentShareResult } from '../../../shared/agentSharing'

/**
 * Hands "open Finish setup" from wherever a team library action ran to the
 * agent page that owns the dialog.
 *
 * Get runs from the catalog, Update from the catalog, the Inbox or the page
 * itself; only the page renders the dialog, and after a Get it is not even
 * mounted yet. So the sharing mutations record the request here (hook-level,
 * so it survives the caller unmounting), and it stays recorded until the
 * dialog for that agent is closed — a page that mounts twice (StrictMode) or
 * is left and come back to still shows it.
 */
interface FinishSetupStore {
  /** Slot names main attached without asking, per agent, for this app session. */
  autoAttached: Record<string, string[]>
  /** Agents whose page should show Finish setup until it is closed. */
  pending: string[]
  /** Record a Get / Update / Use the team's version result for `agentId`. */
  record: (agentId: string, result: Pick<AgentShareResult, 'done' | 'autoAttached' | 'setupNeeded'>) => void
  /** The dialog for `agentId` was closed. */
  clear: (agentId: string) => void
}

export const useFinishSetupStore = create<FinishSetupStore>((set) => ({
  autoAttached: {},
  pending: [],
  record: (agentId, result) => {
    if (!result.done) return
    const slots = (result.autoAttached ?? []).map((item) => item.slot)
    set((state) => ({
      autoAttached: slots.length
        ? { ...state.autoAttached, [agentId]: [...new Set([...(state.autoAttached[agentId] ?? []), ...slots])] }
        : state.autoAttached,
      pending: result.setupNeeded && !state.pending.includes(agentId) ? [...state.pending, agentId] : state.pending
    }))
  },
  clear: (agentId) => set((state) => ({ pending: state.pending.filter((id) => id !== agentId) }))
}))
