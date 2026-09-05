/**
 * Bringing the main window back to the front.
 *
 * Two flows hand the user to their browser and expect them back: the deep-link
 * confirm step, which runs OAuth, and every re-auth. On macOS the app that
 * *loses* focus does not get it back when the browser finishes — the browser
 * keeps it — so without this the user completes the sign-in, sees a "you can
 * close this tab" page, and has to find Cinna in the Dock themselves.
 *
 * `app.focus({ steal: true })` is what actually raises the application; the
 * window calls alone only reorder Cinna's own windows within a background app.
 * Stealing focus is normally rude, and it is right here for exactly one reason:
 * the user just finished an interaction they started in this app and is
 * waiting for it to react.
 *
 * The window getter is installed by `index.ts` rather than imported from it.
 * `index.ts` is the app entry — importing it from a service pulls the entire
 * startup graph into anything that touches focus, including unit tests.
 */

import { app, type BrowserWindow } from 'electron'

let getWindow: (() => BrowserWindow | null) | null = null

/** Called once from `index.ts`, which owns the window. */
export function installWindowResolver(resolver: () => BrowserWindow | null): void {
  getWindow = resolver
}

/**
 * Restore, show and raise the main window, and bring the app forward.
 *
 * Safe to call at any time: before the window exists, after it was closed, and
 * from the main process's error paths. It never throws — a failure to focus is
 * a cosmetic problem and must not take down the flow that asked for it.
 */
export function focusMainWindow(): void {
  try {
    const win = getWindow?.() ?? null
    if (win && !win.isDestroyed()) {
      if (win.isMinimized()) win.restore()
      win.show()
      win.focus()
    }
    if (process.platform === 'darwin') app.focus({ steal: true })
    else app.focus()
  } catch {
    // Focus is best-effort by definition — the OS may simply refuse.
  }
}
