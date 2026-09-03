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
 * renderer's `ipcRenderer.invoke` promise rejects. A `DomainError`'s `code` and
 * `detail` are re-attached as own properties on the thrown Error — but **they
 * do not reach the renderer.** Two boundaries discard them:
 *
 * 1. `ipcMain.handle` serialises a rejection to `message` + `stack` only, and
 *    rewrites the message as `Error invoking remote method '<channel>': …`.
 * 2. `contextBridge` then clones whatever preload throws into the renderer's
 *    world as a fresh `Error`, so re-attaching the code in preload does not
 *    help either — it lands on the wrong side of this one.
 *
 * What the renderer receives is a plain `Error` whose only own properties are
 * `stack` and `message`. The re-attached `code` is still worth setting: it is
 * read by callers *inside* the main process and it makes the logged error
 * self-describing. It is not a wire contract.
 *
 * **So a handler whose failure code must drive renderer behaviour has to
 * return the code as data rather than throw it.** Most of this app already
 * does, via the `{success: false, code}` result convention (see
 * `useAgents.ts`, which builds the Error and sets `.code` renderer-side).
 * `LocalAgentOutcome` in `src/shared/localAgents.ts` is the worked example for
 * a channel that otherwise wants to throw: main returns
 * `{ok: false, code, name, message}`, and the renderer — not preload — turns it
 * back into a throw, where the error stays put.
 *
 * This comment previously claimed the properties survived serialisation. They
 * never have; `isStaleWriteError` was written trusting it and silently answered
 * `false` for every refused write until it was probed in a running app.
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
