import { ipcMain, type IpcMainInvokeEvent } from 'electron'
import { createLogger } from '../logger/logger'
import { DomainError } from '../errors'

const logger = createLogger('ipc')

type IpcHandler<T> = (event: IpcMainInvokeEvent, ...args: any[]) => T | Promise<T>

/**
 * Register a typed IPC handler with uniform error logging.
 *
 * On throw: logs the error with the channel name and re-throws so the
 * renderer's `ipcRenderer.invoke` promise rejects. DomainError's `code` and
 * `detail` are re-attached as enumerable own properties on the thrown Error
 * so they survive Electron's structured-clone serialization across the IPC
 * boundary.
 */
export function ipcHandle<T>(channel: string, fn: IpcHandler<T>): void {
  ipcMain.handle(channel, async (event, ...args) => {
    try {
      return await fn(event, ...args)
    } catch (err) {
      if (err instanceof DomainError) {
        logger.warn(`${channel} failed`, {
          code: err.code,
          message: err.message,
          detail: err.detail
        })
        const outbound = new Error(err.message) as Error & {
          code: string
          detail?: string
        }
        outbound.name = err.name
        outbound.code = err.code
        if (err.detail !== undefined) outbound.detail = err.detail
        throw outbound
      }
      logger.error(`${channel} failed`, err)
      throw err
    }
  })
}
