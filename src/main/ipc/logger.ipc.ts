import { clearLogEntries, getLogEntries, logEntry, type LogLevel } from '../logger/logger'
import { ipcHandle } from './_wrap'

export function registerLoggerHandlers(): void {
  ipcHandle('logger:get-all', () => getLogEntries())

  ipcHandle('logger:clear', () => {
    clearLogEntries()
    return { success: true }
  })

  ipcHandle(
    'logger:log',
    (_event, payload: { level: LogLevel; scope: string; message: string; data?: unknown }) => {
      logEntry(payload.level, payload.scope, 'renderer', payload.message, payload.data)
      return { success: true }
    }
  )
}
