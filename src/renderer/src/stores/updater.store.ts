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
    if (get().subscribed) return
    const initial = await window.api.updater.getState()
    const unsub = window.api.updater.onState((state) => {
      set({ state })
    })
    set({ state: initial, subscribed: true, unsubscribe: unsub })
  },

  promptInstall: async () => {
    try {
      await window.api.updater.promptInstall()
    } catch (err) {
      log.error('promptInstall failed', { message: (err as Error).message })
    }
  }
}))
