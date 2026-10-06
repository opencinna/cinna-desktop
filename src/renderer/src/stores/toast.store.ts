import { create } from 'zustand'
import type { SettingsMenu } from './ui.store'

/** A link under the message that opens a Settings tab. */
export interface ToastLink {
  label: string
  settingsMenu: SettingsMenu
}

/** The link every toast carried before links became optional: agent visibility lives there. */
export const PROFILE_AGENTS_LINK: ToastLink = { label: 'Settings → Profile → Agents', settingsMenu: 'profile-agents' }

/** Omitted: the plain toast every caller had before kinds. */
export type ToastKind = 'info' | 'success' | 'warning' | 'error'

export interface ToastOptions {
  /** Omitted: the Profile → Agents link. `null`: no link. */
  link?: ToastLink | null
  kind?: ToastKind
}

interface ToastState {
  toast: { id: number; message: string; link: ToastLink | null; kind?: ToastKind } | null
  /** Returns the toast's id, so a caller can later dismiss only its own toast. */
  show: (message: string, options?: ToastOptions) => number
  dismiss: () => void
}
// Unique even for two toasts in one millisecond, so dismissing by id never
// takes another caller's toast.
let lastId = 0
export const useToastStore = create<ToastState>((set) => ({
  toast: null,
  show: (message, options) => {
    const id = Math.max(Date.now(), lastId + 1)
    lastId = id
    set({ toast: { id, message, link: options?.link === undefined ? PROFILE_AGENTS_LINK : options.link, kind: options?.kind } })
    return id
  },
  dismiss: () => set({ toast: null })
}))
