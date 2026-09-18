import { userActivation } from '../auth/activation'
import { appSettingsService } from '../services/appSettingsService'
import { syncTrayFromSettings } from '../services/traySync'
import { localAgentService } from '../services/localAgents/localAgentService'
import { defaultEngineService } from '../services/localAgents/defaultEngineService'
import { getSettingsScopeUserId } from '../auth/scope'
import { createLogger } from '../logger/logger'
import type { AppSettingsSchema } from '../../shared/appSettings'
import { ipcHandle } from './_wrap'
import { aiFunctions } from '../services/aiFunctionsService'
import type { AiFunctionsBackendStatus } from '../../shared/aiFunctions'

const logger = createLogger('settings-ipc')

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
    /**
     * **Wait for the Default runtime to be decided before answering.**
     *
     * On the first launch of an install that setting is `''` — "not decided
     * yet" — and deciding it means asking the machine what it has, which is a
     * login-shell probe of about a second. The renderer caches this answer, so
     * a read that beat the decision would leave the Runtime picker showing
     * *nothing selected* for the rest of the session, on exactly the install
     * this feature exists for.
     *
     * Memoized in the service and it returns before its first `await` once the
     * setting exists, so every launch after the first pays nothing.
     */
    await defaultEngineService.lockIfUnset()
    return appSettingsService.getAll()
  })

  /**
   * Where AI Functions will run, as `aiFunctions.resolveBackend` decides it —
   * the Settings → Features "Runs on" line renders this and nothing else, so it
   * cannot claim a credential that main is quietly falling back from. Every
   * fallback is returned as a reason, never thrown: a thrown code would not
   * survive IPC. DB-only: no provider request on a settings read; the renderer
   * names the model from the `useModels` list it already holds.
   */
  ipcHandle('settings:ai-functions-backend', async (): Promise<AiFunctionsBackendStatus> => {
    userActivation.requireActivated()
    return aiFunctions.describeBackend()
  })

  ipcHandle(
    'settings:set',
    async (_event, key: string, value: unknown): Promise<{ success: true }> => {
      userActivation.requireActivated()
      appSettingsService.set(key, value)
      // Settings that gate a main-process side effect run their sync here, so
      // the renderer toggle is enough to drive the change without restart.
      if (key === 'enableTrayIcon') syncTrayFromSettings()
      /**
       * **The Default Runtime is cached on every folder agent's row**, as
       * `driver_config.launcher`, and that cache is what `capabilitiesFor`
       * answers from — so a change here that did not re-index would leave every
       * agent that names no engine of its own described as running on the
       * engine it ran on a moment ago. The visible symptom is the composer: a
       * Claude agent has a question path and an OpenCode one does not.
       *
       * Re-indexing rather than a targeted write, because the launcher is
       * derived from the folder and the scanner is the one thing that reads
       * folders. It is a user action taken rarely, and a failure must not fail
       * the save the user actually asked for — the setting is stored either
       * way, and the next rescan picks the rows up.
       */
      if (key === 'localAgentsDefaultEngine') {
        try {
          localAgentService.rescan(getSettingsScopeUserId())
        } catch (err) {
          logger.warn('could not re-index agents after the default runtime changed', {
            error: err instanceof Error ? err.message : String(err)
          })
        }
      }
      return { success: true }
    }
  )
}
