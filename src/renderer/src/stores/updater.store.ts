import { create } from 'zustand'
import type { UpdaterState } from '../../../shared/updaterState'
import { createLogger } from './logger.store'

const log = createLogger('updater')

interface UpdaterStore {
  state: UpdaterState
  subscribed: boolean
  unsubscribe: (() => void) | null
  set: (state: UpdaterState) => void
  subscribe: () => Promise<void>
  promptInstall: () => Promise<void>
}

export const useUpdaterStore = create<UpdaterStore>((set, get) => ({
  state: { phase: 'idle' },
  subscribed: false,
  unsubscribe: null,

  set: (state) => set({ state }),

  subscribe: async () => {
    // Claimed before the await: the sidebar footer and the top bar both mount
    // a status button, and both would otherwise get past this check.
    if (get().subscribed) return
    set({ subscribed: true })
    const unsub = window.api.updater.onState((state) => {
      set({ state })
    })
    set({ unsubscribe: unsub })
    const initial = await window.api.updater.getState()
    // A broadcast that landed during the await is newer than the snapshot.
    if (get().state.phase === 'idle') set({ state: initial })
  },

  promptInstall: async () => {
    try {
      await window.api.updater.promptInstall()
    } catch (err) {
      log.error('promptInstall failed', { message: (err as Error).message })
    }
  }
}))
