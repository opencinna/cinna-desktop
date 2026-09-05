import { create } from 'zustand'
import type { ConnectIntent } from '../../../shared/connectIntent'
import { createLogger } from './logger.store'

const log = createLogger('connect-intent')

/**
 * The pending `cinna://connect` deep link, held once for the whole renderer.
 *
 * A store rather than a hook's own state because two very different surfaces
 * read the same intent — the onboarding screen on a fresh install, and a modal
 * over the app on an install that already has an account — and exactly one of
 * them must show. Two independent subscriptions would race to render two
 * confirmations of the same link.
 */
interface ConnectIntentStore {
  intent: ConnectIntent | null
  subscribed: boolean
  subscribe: () => Promise<void>
  /** Confirmed, declined or switched to — tell main to drop the buffer too. */
  consume: () => void
}

export const useConnectIntentStore = create<ConnectIntentStore>((set, get) => ({
  intent: null,
  subscribed: false,

  subscribe: async () => {
    if (get().subscribed) return
    // Marked subscribed before the await: `useConnectIntent` runs this from a
    // mount effect, which React StrictMode double-invokes in development, and
    // two overlapping runs would register two IPC listeners.
    set({ subscribed: true })
    try {
      window.api.connect.onIntent((intent) => set({ intent }))
      const pending = await window.api.connect.getPending()
      // A push that landed while `getPending` was in flight is newer than what
      // it returns, so it wins.
      if (pending && !get().intent) set({ intent: pending })
    } catch (err) {
      set({ subscribed: false })
      log.error('could not subscribe to connect intents', {
        message: (err as Error).message
      })
    }
  },

  consume: () => {
    set({ intent: null })
    void window.api.connect.consume().catch((err) => {
      log.warn('could not clear the pending connect intent', {
        message: (err as Error).message
      })
    })
  }
}))
