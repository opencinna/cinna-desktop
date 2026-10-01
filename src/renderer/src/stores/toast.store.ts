import { create } from 'zustand'
import type { SettingsMenu } from './ui.store'

/** A link under the message that opens a Settings tab. */
export interface ToastLink {
  label: string
  settingsMenu: SettingsMenu
}

/** The link every toast carried before links became optional: agent visibility lives there. */
export const PROFILE_AGENTS_LINK: ToastLink = { label: 'Settings → Profile → Agents', settingsMenu: 'profile-agents' }

export interface ToastOptions {
  /** Omitted: the Profile → Agents link. `null`: no link. */
  link?: ToastLink | null
}

interface ToastState {
  toast: { id: number; message: string; link: ToastLink | null } | null
  show: (message: string, options?: ToastOptions) => void
  dismiss: () => void
}
export const useToastStore = create<ToastState>((set) => ({
  toast: null,
  show: (message, options) =>
    set({ toast: { id: Date.now(), message, link: options?.link === undefined ? PROFILE_AGENTS_LINK : options.link } }),
  dismiss: () => set({ toast: null })
}))
