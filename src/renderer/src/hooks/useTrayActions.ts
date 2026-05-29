import { useMemo } from 'react'

/**
 * Imperative tray-popup commands (fire-and-forget). Keeps the contextBridge
 * surface out of the view layer so components depend on this hook, not
 * `window.api.tray.*` directly.
 */
export function useTrayActions(): {
  startChat: (agentId: string) => void
  openStatusDetail: (agentId: string) => void
  closePopup: () => void
} {
  return useMemo(
    () => ({
      startChat: (agentId: string) => {
        void window.api.tray.startChat(agentId)
      },
      openStatusDetail: (agentId: string) => {
        void window.api.tray.openStatusDetail(agentId)
      },
      closePopup: () => {
        void window.api.tray.closePopup()
      }
    }),
    []
  )
}
