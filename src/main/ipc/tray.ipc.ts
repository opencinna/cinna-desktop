import { trayService } from '../services/trayService'
import { userActivation } from '../auth/activation'
import { ipcHandle } from './_wrap'

export function registerTrayHandlers(): void {
  ipcHandle('tray:set-image', (_event, data: { dataUrl: string; tooltip: string }) => {
    trayService.setImage(data.dataUrl, data.tooltip)
    return { success: true as const }
  })

  // start-chat / open-status raise and redirect the main window — gate them on
  // an active session, consistent with the rest of the IPC surface.
  ipcHandle('tray:start-chat', (_event, data: { agentId: string }) => {
    userActivation.requireActivated()
    trayService.startChat(data.agentId)
    return { success: true as const }
  })

  ipcHandle('tray:open-status', (_event, data: { agentId: string }) => {
    userActivation.requireActivated()
    trayService.openStatus(data.agentId)
    return { success: true as const }
  })

  ipcHandle('tray:close-popup', () => {
    trayService.hidePopup()
    return { success: true as const }
  })
}
