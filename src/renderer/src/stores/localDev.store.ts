import { create } from 'zustand'
import type { LocalDevState } from '../../../shared/localDevState'
import { createLogger } from './logger.store'
import { unwrapIpcError } from '../utils/ipcError'

const log = createLogger('local-dev')

/**
 * Local development readiness, held once for the whole renderer.
 *
 * Three surfaces read it — the consent modal behind the sidebar's status
 * button, the button itself, and Settings → Local Development — and they must agree: a spinner in
 * the footer while Settings says "ready" is the kind of contradiction that
 * makes a user distrust both. Main is the single source; nothing here derives
 * state locally.
 */
interface LocalDevStore {
  pageMode: 'chat' | 'settings'
  setPageMode: (mode: 'chat' | 'settings') => void
  /**
   * The consent modal, opened only by the sidebar button. Nothing opens it on
   * its own: a user who never clicks that button is never asked.
   */
  consentOpen: boolean
  setConsentOpen: (open: boolean) => void
  drafts: Record<string, string>
  setDraft: (profileId: string, text: string) => void
  state: LocalDevState
  subscribed: boolean
  subscribe: () => Promise<void>
  set: (state: LocalDevState) => void
  /** Resolves to the refusal's message when main rejects the answer, else `null`. */
  consent: (host: string, accepted: boolean) => Promise<string | null>
  resetConsent: (host: string) => Promise<void>
  repair: () => Promise<void>
  reconnectWorkspace: () => Promise<void>
  openWorkspace: () => Promise<void>
}

// A pushed state or a newer action supersedes older IPC replies. In
// particular, a ready reply from A must never replace B's idle/consent state.
let revision = 0

function receive(state: LocalDevState): void {
  revision += 1
  if (state.phase === 'idle') {
    // A profile switch also closes an open consent modal: the question it was
    // showing belonged to the profile that just left.
    useLocalDevStore.setState({ state, consentOpen: false })
  } else {
    useLocalDevStore.setState({ state })
  }
}

function receiveReply(state: LocalDevState, request: number): void {
  if (revision === request) receive(state)
}

export const useLocalDevStore = create<LocalDevStore>((set, get) => ({
  pageMode: 'chat',
  setPageMode: (pageMode) => set({ pageMode }),
  consentOpen: false,
  setConsentOpen: (consentOpen) => set({ consentOpen }),
  drafts: {},
  setDraft: (profileId, text) => set((s) => ({ drafts: { ...s.drafts, [profileId]: text } })),
  state: { phase: 'idle' },
  subscribed: false,

  set: receive,

  subscribe: async () => {
    if (get().subscribed) return
    // Set before the await: this runs from a mount effect that StrictMode
    // double-invokes in development, and two runs would attach two listeners.
    set({ subscribed: true })
    const request = ++revision
    try {
      window.api.localDev.onState(receive)
      receiveReply(await window.api.localDev.getState(), request)
    } catch (err) {
      set({ subscribed: false })
      log.error('could not subscribe to local dev state', { message: (err as Error).message })
    }
  },

  consent: async (host, accepted) => {
    const request = ++revision
    try {
      // The answer comes back as the next state — main reconciles immediately
      // on an accept — so there is nothing to invalidate and no window in which
      // the UI shows a decision that has not been recorded.
      receiveReply(await window.api.localDev.consent(host, accepted), request)
      return null
    } catch (err) {
      log.error('could not record the local dev consent answer', {
        host,
        message: (err as Error).message
      })
      return unwrapIpcError(err, 'Could not start local development setup.')
    }
  },

  resetConsent: async (host) => {
    const request = ++revision
    receiveReply(await window.api.localDev.resetConsent(host), request)
  },

  repair: async () => {
    const request = ++revision
    receiveReply(await window.api.localDev.repair(), request)
  },

  // Main moves the old folder aside and reconciles, so — like Repair — the
  // answer *is* the next state and there is nothing to invalidate here.
  reconnectWorkspace: async () => {
    const request = ++revision
    receiveReply(await window.api.localDev.reconnectWorkspace(), request)
  },

  openWorkspace: async () => {
    const result = await window.api.localDev.openWorkspace()
    if (!result.ok) log.warn('could not open the workspace folder')
  }
}))
