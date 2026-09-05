import { create } from 'zustand'
import type { LocalDevState } from '../../../shared/localDevState'
import { createLogger } from './logger.store'

const log = createLogger('local-dev')

/**
 * Local development readiness, held once for the whole renderer.
 *
 * Three surfaces read it — the onboarding consent step, the sidebar's status
 * button, and Settings → Local Development — and they must agree: a spinner in
 * the footer while Settings says "ready" is the kind of contradiction that
 * makes a user distrust both. Main is the single source; nothing here derives
 * state locally.
 */
interface LocalDevStore {
  state: LocalDevState
  subscribed: boolean
  subscribe: () => Promise<void>
  set: (state: LocalDevState) => void
  consent: (host: string, accepted: boolean) => Promise<void>
  resetConsent: (host: string) => Promise<void>
  repair: () => Promise<void>
  openWorkspace: () => Promise<void>
}

export const useLocalDevStore = create<LocalDevStore>((set, get) => ({
  state: { phase: 'idle' },
  subscribed: false,

  set: (state) => set({ state }),

  subscribe: async () => {
    if (get().subscribed) return
    // Set before the await: this runs from a mount effect that StrictMode
    // double-invokes in development, and two runs would attach two listeners.
    set({ subscribed: true })
    try {
      window.api.localDev.onState((state) => set({ state }))
      set({ state: await window.api.localDev.getState() })
    } catch (err) {
      set({ subscribed: false })
      log.error('could not subscribe to local dev state', { message: (err as Error).message })
    }
  },

  consent: async (host, accepted) => {
    // The answer comes back as the next state — main reconciles immediately on
    // an accept — so there is nothing to invalidate and no window in which the
    // UI shows a decision that has not been recorded.
    set({ state: await window.api.localDev.consent(host, accepted) })
  },

  resetConsent: async (host) => {
    set({ state: await window.api.localDev.resetConsent(host) })
  },

  repair: async () => {
    set({ state: await window.api.localDev.repair() })
  },

  openWorkspace: async () => {
    const result = await window.api.localDev.openWorkspace()
    if (!result.ok) log.warn('could not open the workspace folder')
  }
}))
