import { create } from 'zustand'
import type { AgentShareResult } from '../../../shared/agentSharing'
import type { AutoAttachedCredential } from '../../../shared/serviceCredentials'

/**
 * The key an attached-without-asking slot is remembered under: an agent slot by its name, a
 * skill slot as `skill:<service uri>`, so a skill slot never reads as an agent slot of that name.
 */
export function autoAttachedKey(item: Pick<AutoAttachedCredential, 'slot' | 'skill'>): string {
  return item.skill ? `skill:${item.slot}` : item.slot
}

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
  /** Slots main attached without asking ({@link autoAttachedKey}), per agent, for this app session. */
  autoAttached: Record<string, string[]>
  /** Agents whose page should show Finish setup until it is closed. */
  pending: string[]
  /** Record a Get / Update / Use the team's version result for `agentId`. */
  record: (agentId: string, result: Pick<AgentShareResult, 'done' | 'autoAttached' | 'setupNeeded'>) => void
  /** Remember slots main attached without asking for `agentId` (skill slots when Finish setup opens). */
  remember: (agentId: string, items: readonly AutoAttachedCredential[]) => void
  /** The dialog for `agentId` was closed. */
  clear: (agentId: string) => void
}

function merged(current: Record<string, string[]>, agentId: string, items: readonly AutoAttachedCredential[]): Record<string, string[]> {
  const keys = items.map(autoAttachedKey)
  return keys.length ? { ...current, [agentId]: [...new Set([...(current[agentId] ?? []), ...keys])] } : current
}

export const useFinishSetupStore = create<FinishSetupStore>((set) => ({
  autoAttached: {},
  pending: [],
  record: (agentId, result) => {
    if (!result.done) return
    set((state) => ({
      autoAttached: merged(state.autoAttached, agentId, result.autoAttached ?? []),
      pending: result.setupNeeded && !state.pending.includes(agentId) ? [...state.pending, agentId] : state.pending
    }))
  },
  remember: (agentId, items) => set((state) => ({ autoAttached: merged(state.autoAttached, agentId, items) })),
  clear: (agentId) => set((state) => ({ pending: state.pending.filter((id) => id !== agentId) }))
}))
