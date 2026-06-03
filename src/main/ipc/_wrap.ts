import { ipcMain, type IpcMainInvokeEvent } from 'electron'
import { createLogger } from '../logger/logger'
import { DomainError } from '../errors'
import { CinnaReauthRequired } from '../auth/cinna-oauth'
import { broadcastReauthRequired } from '../auth/reauth-notify'
import { REAUTH_REQUIRED_CODE, CINNA_REAUTH_REQUIRED_CODE } from '../../shared/cinnaErrors'

const logger = createLogger('ipc')

function isReauthCode(code: unknown): boolean {
  return code === REAUTH_REQUIRED_CODE || code === CINNA_REAUTH_REQUIRED_CODE
}

/**
 * Detect the reauth-required signal in a handler's *return value*. Handlers
 * split on convention: some throw a `CinnaApiError('reauth_required')` (caught
 * below), others catch internally and resolve `{ success: false, code:
 * 'reauth_required' }` (e.g. `agent-status:list`). Inspecting the result here —
 * the one path every handler shares — makes the global modal fire for both.
 */
function isReauthResult(result: unknown): boolean {
  return (
    typeof result === 'object' &&
    result !== null &&
    (result as { success?: unknown }).success === false &&
    isReauthCode((result as { code?: unknown }).code)
  )
}

type IpcHandler<T> = (event: IpcMainInvokeEvent, ...args: any[]) => T | Promise<T>

/**
 * Register a typed IPC handler with uniform error logging.
 *
 * On throw: logs the error with the channel name and re-throws so the
 * renderer's `ipcRenderer.invoke` promise rejects. DomainError's `code` and
 * `detail` are re-attached as enumerable own properties on the thrown Error
 * so they survive Electron's structured-clone serialization across the IPC
 * boundary.
 *
 * Either way — thrown or returned — a reauth-required code broadcasts the
 * global "session expired" event so the modal pops app-wide, not just on the
 * screen observing the failing query.
 */
export function ipcHandle<T>(channel: string, fn: IpcHandler<T>): void {
  ipcMain.handle(channel, async (event, ...args) => {
    try {
      const result = await fn(event, ...args)
      if (isReauthResult(result)) broadcastReauthRequired(channel)
      return result
    } catch (err) {
      if (err instanceof DomainError) {
        logger.warn(`${channel} failed`, {
          code: err.code,
          message: err.message,
          detail: err.detail
        })
        if (isReauthCode(err.code)) broadcastReauthRequired(channel)
        const outbound = new Error(err.message) as Error & {
          code: string
          detail?: string
        }
        outbound.name = err.name
        outbound.code = err.code
        if (err.detail !== undefined) outbound.detail = err.detail
        throw outbound
      }
      // A raw `CinnaReauthRequired` (e.g. straight from `getCinnaAccessToken`,
      // not yet normalized into a `CinnaApiError` by the api layer) still means
      // the session is dead — fire the global modal so it's not swallowed as a
      // generic per-screen error.
      if (err instanceof CinnaReauthRequired) broadcastReauthRequired(channel)
      logger.error(`${channel} failed`, err)
      throw err
    }
  })
}
