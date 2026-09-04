import type { BrowserWindow } from 'electron'
import { setLogSink, type LogEntry } from './logger'

/**
 * The Electron half of logging, kept out of `logger.ts` so that logging costs a
 * module nothing but this package's own types.
 *
 * The window getter arrives as an argument rather than as an
 * `import { getMainWindow } from '../index'`, which would only move the cycle
 * here from `logger.ts`. `index.ts` owns the window, so `index.ts` supplies it;
 * the only import in this file is type-only and erased at compile time, so no
 * runtime edge to electron or to the entry point is created by either module.
 */

const BROADCAST_CHANNEL = 'logger:entry'

/**
 * Send every subsequent log entry to the renderer while a live window exists.
 *
 * Call once, as early in startup as possible. Entries logged before this point
 * are already in the ring buffer and reach the renderer through
 * `logger:get-all`.
 */
export function installLogBroadcast(getWindow: () => BrowserWindow | null): void {
  setLogSink((entry: LogEntry) => {
    const win = getWindow()
    if (win && !win.isDestroyed()) {
      win.webContents.send(BROADCAST_CHANNEL, entry)
    }
  })
}
