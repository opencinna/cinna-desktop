import { userActivation } from '../auth/activation'
import { appSettingsService } from '../services/appSettingsService'
import { syncTrayFromSettings } from '../services/traySync'
import type { AppSettingsSchema } from '../../shared/appSettings'
import { ipcHandle } from './_wrap'

/**
 * IPC for the installation-global app settings KV store. The whole schema
 * is small and read together by the Settings page, so we expose it as a
 * single get-all / set-one pair rather than per-key channels — adding a
 * new toggle is then one row in {@link AppSettingsSchema} plus a renderer
 * UI line, with no IPC plumbing.
 *
 * Runtime validation of `(key, value)` lives in `appSettingsService` —
 * the IPC layer just unwraps the arguments. `ipcHandle` re-throws
 * `AppSettingsError` so the renderer sees stable codes ('invalid_key',
 * 'invalid_value').
 */
export function registerSettingsHandlers(): void {
  ipcHandle('settings:get-all', async (): Promise<AppSettingsSchema> => {
    userActivation.requireActivated()
    return appSettingsService.getAll()
  })

  ipcHandle(
    'settings:set',
    async (_event, key: string, value: unknown): Promise<{ success: true }> => {
      userActivation.requireActivated()
      appSettingsService.set(key, value)
      // Settings that gate a main-process side effect run their sync here, so
      // the renderer toggle is enough to drive the change without restart.
      if (key === 'enableTrayIcon') syncTrayFromSettings()
      return { success: true }
    }
  )
}
