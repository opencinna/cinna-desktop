import { appSettingsRepo } from '../db/appSettings'
import { getMainWindow } from '../index'
import { createLogger } from '../logger/logger'
import { trayService } from './trayService'

const logger = createLogger('tray-sync')

/**
 * Bring the menu-bar tray in line with the `enableTrayIcon` app setting.
 *
 * Called at main-window creation (so the tray honors the persisted toggle
 * from the moment the app starts) and from the settings IPC write path
 * (so flipping the toggle takes effect live without restart).
 *
 * `trayService.create` and `trayService.destroy` are both idempotent, so
 * calling this repeatedly is safe.
 *
 * Re-push contract: the icon image is rendered in the renderer and only
 * pushed when its inputs (worst severity, tooltip, color scheme) change.
 * When the user enables the tray at runtime, those inputs are unchanged,
 * so a freshly-created `Tray` would sit on the placeholder image. We
 * send `tray:request-icon` to the main window so it re-runs the canvas
 * draw and pushes the activity glyph back.
 */
export function syncTrayFromSettings(): void {
  const enabled = appSettingsRepo.get('enableTrayIcon')
  logger.info('tray sync', { enabled })
  if (enabled) {
    trayService.create({ getMainWindow })
    const win = getMainWindow()
    if (win && !win.isDestroyed()) {
      win.webContents.send('tray:request-icon')
    }
  } else {
    trayService.destroy()
  }
}
