import { ipcMain } from 'electron'
import { clearLogEntries, getLogEntries, logEntry, type LogLevel } from '../logger/logger'

export function registerLoggerHandlers(): void {
  ipcMain.handle('logger:get-all', () => getLogEntries())

  ipcMain.handle('logger:clear', () => {
    clearLogEntries()
    return { success: true }
  })

  ipcMain.handle(
    'logger:log',
    (_event, payload: { level: LogLevel; scope: string; message: string; data?: unknown }) => {
      logEntry(payload.level, payload.scope, 'renderer', payload.message, payload.data)
      return { success: true }
    }
  )
}
