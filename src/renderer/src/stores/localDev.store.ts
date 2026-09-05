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
  /**
   * Hosts this renderer has already answered the consent question for.
   *
   * Main records the answer and then reconciles, and until that reconcile has
   * moved off `consent` the broadcast state still says "waiting on the user" —
   * which is how a screen that just took the answer ends up asking it again for
   * half a second. The surfaces that ask check this before rendering the
   * question; nothing else may read it, because it is a fact about this window,
   * not about the machine.
   */
  answeredHosts: string[]
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
  answeredHosts: [],

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
    // Marked answered before the call, not after: the whole point is to cover
    // the window while main is still working the answer through a reconcile.
    set((s) => ({
      answeredHosts: s.answeredHosts.includes(host) ? s.answeredHosts : [...s.answeredHosts, host]
    }))
    try {
      // The answer comes back as the next state — main reconciles immediately
      // on an accept — so there is nothing to invalidate and no window in which
      // the UI shows a decision that has not been recorded.
      set({ state: await window.api.localDev.consent(host, accepted) })
    } catch (err) {
      // Rolled back, or the marker outlives the answer it was covering for:
      // the channel is gated on an activated profile, and a rejection there
      // would otherwise suppress the question in both surfaces that ask it for
      // the life of this window — and nothing would ever set local development
      // up until the app was restarted.
      set((s) => ({ answeredHosts: s.answeredHosts.filter((h) => h !== host) }))
      log.error('could not record the local dev consent answer', {
        host,
        message: (err as Error).message
      })
    }
  },

  resetConsent: async (host) => {
    // Settings asking for the question back is the one thing that clears the
    // marker; otherwise the prompt it just re-armed would never be shown.
    set((s) => ({ answeredHosts: s.answeredHosts.filter((h) => h !== host) }))
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
