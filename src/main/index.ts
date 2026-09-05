import { app, shell, BrowserWindow, Menu, dialog, powerMonitor } from 'electron'
import { join } from 'path'
import { appendFileSync, renameSync, statSync } from 'fs'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import { registerAllIpcHandlers } from './ipc'
import { initDatabase } from './db/client'
import { mcpManager } from './mcp/manager'
import { getCurrentUserId, initSession } from './auth/session'
import { initAutoUpdater, checkForUpdatesManual } from './updater/updater'
import { appIconService } from './services/appIconService'
import { syncService } from './services/syncService'
import { trayService } from './services/trayService'
import { syncTrayFromSettings } from './services/traySync'
import { createLogger } from './logger/logger'
import { installLogBroadcast } from './logger/broadcast'
import { localDevService } from './localdev/localDevService'
import {
  connectIntentService,
  connectUrlFromArgv,
  registerConnectScheme
} from './services/connectIntentService'
import { BACKGROUND_WINDOW, focusMainWindow, installWindowResolver } from './window/focus'

// A disposable profile for the E2E suite (`e2e/`). Read once, before anything
// derives a path from `userData` — the startup log, the database, the session
// file and the engine folder all do. `sessionData` is set too: since Electron
// 21 it no longer follows `userData`, and a test run must not leave Chromium
// cache in the real profile.
const overrideUserData = process.env['CINNA_USER_DATA']
if (overrideUserData) {
  app.setPath('userData', overrideUserData)
  app.setPath('sessionData', join(overrideUserData, 'session-data'))
}

let mainWindow: BrowserWindow | null = null
let startupComplete = false
const bootLogger = createLogger('boot')

// The logger buffers and console-writes on its own; this is the only thing that
// puts entries in front of the renderer, and it lives here because the window
// lives here. `getMainWindow` is a hoisted function declaration and reads
// `mainWindow` lazily, so installing before there is a window is correct.
installLogBroadcast(getMainWindow)
installWindowResolver(getMainWindow)
connectIntentService.install(getMainWindow)

// ── The `cinna://` deep link ────────────────────────────────────────────────
//
// All of this is at module scope, before `whenReady`, and that is the whole
// trick. On macOS a cold launch from a link fires `open-url` *before* the app
// is ready — a handler installed inside `startup()` would miss the one delivery
// the feature exists for. `connectIntentService` buffers whatever arrives until
// there is a renderer to show it to, so being early costs nothing.
//
// The single-instance lock is what makes the running-app case work at all:
// without it a second click launches a second copy of Cinna, which registers
// nothing, shows its own window, and leaves the user's real profile behind the
// new one. With it, the second process exits and the first receives the URL
// through `second-instance`.
//
// Registration is skipped for the E2E suite's throwaway profile: claiming the
// machine's `cinna://` handler is a change to the developer's OS, and a test
// that leaves it pointing at a temporary sandbox has broken the machine it ran
// on. The suite drives the same funnel through `--cinna-connect-intent=`.
if (!overrideUserData) registerConnectScheme()

if (!app.requestSingleInstanceLock()) {
  // A second copy started (a link click, a double-launch). The primary instance
  // is being handed our argv through `second-instance` right now; there is
  // nothing left for this process to do and staying alive would only fight over
  // the database.
  app.exit(0)
} else {
  app.on('second-instance', (_event, argv) => {
    const url = connectUrlFromArgv(argv)
    if (url) connectIntentService.deliver(url, 'second-instance')
    // A second launch with no link is still the user asking for the app —
    // typically a Dock or launcher click while the window is behind something.
    else focusMainWindow()
  })

  app.on('open-url', (event, url) => {
    event.preventDefault()
    connectIntentService.deliver(url, 'open-url')
  })
}

const STARTUP_LOG_NAME = 'cinna-errors.log'
const STARTUP_LOG_MAX_BYTES = 1024 * 1024

function startupLogPath(): string {
  return join(app.getPath('userData'), STARTUP_LOG_NAME)
}

/** Rename `cinna-errors.log` to `.old` if it has grown past the cap. */
function rotateStartupLog(): void {
  try {
    const path = startupLogPath()
    if (statSync(path).size > STARTUP_LOG_MAX_BYTES) {
      renameSync(path, `${path}.old`)
    }
  } catch {
    // No file or rename failed — best-effort.
  }
}

/**
 * Surface failures that would otherwise leave the user staring at a ghost app
 * (menu visible, no window). During startup any throw is fatal — there's no
 * recovery path and the user can't see anything else, so we show a native
 * error dialog and exit. After startup we route through the scoped logger
 * (so the entry shows in the Cmd+` overlay) and also persist to disk;
 * killing the app on every late unhandled rejection would brick it for
 * transient issues (network blips from LLM/MCP/auto-updater).
 */
function handleFatal(err: unknown, phase: string): void {
  const message = err instanceof Error ? `${err.message}\n${err.stack ?? ''}` : String(err)
  let logPath = ''
  try {
    logPath = startupLogPath()
    appendFileSync(
      logPath,
      `[${new Date().toISOString()}] [${phase}]\n${message}\n\n`,
      'utf-8'
    )
  } catch {
    // userData may not exist if app isn't ready yet — best-effort only.
  }

  if (startupComplete) {
    // Logger broadcasts to the renderer overlay and writes to console.
    bootLogger.error(`fatal:${phase}`, err)
    return
  }

  // Pre-startup: logger has no window to broadcast to, so go straight to
  // console + native dialog so the user gets *something*.
  console.error(`[fatal:${phase}]`, err)
  try {
    dialog.showErrorBox(
      'Cinna Desktop failed to start',
      `${err instanceof Error ? err.message : String(err)}\n\n` +
        `Phase: ${phase}\n` +
        (logPath ? `Details written to:\n${logPath}` : '')
    )
  } catch {
    // Dialog requires app ready on some platforms — already logged to console.
  }
  app.exit(1)
}

/**
 * Surface renderer-side failures (crash, OOM, failed initial load) the same
 * way as main-process failures. Without this, the user sees a blank window
 * after the renderer dies — same ghost-app symptom, different root cause.
 */
function handleRendererFailure(reason: string, details: string): void {
  bootLogger.error('renderer-failure', { reason, details })
  try {
    dialog.showErrorBox(
      'Cinna Desktop renderer failed',
      `${reason}\n\n${details}\n\nPlease restart the app.`
    )
  } catch {
    // Best-effort
  }
  // Keep dev sessions alive — DevTools + hot reload are usually recoverable.
  if (!is.dev) app.exit(1)
}

process.on('uncaughtException', (err) => handleFatal(err, 'uncaughtException'))
process.on('unhandledRejection', (reason) => handleFatal(reason, 'unhandledRejection'))

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 800,
    minHeight: 600,
    show: false,
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 15, y: 10 },
    autoHideMenuBar: true,
    ...(process.platform === 'linux' ? { icon: appIconService.iconForCurrentTheme() } : {}),
    webPreferences: {
      preload: join(__dirname, '../preload/index.mjs'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false
    }
  })

  mainWindow.on('ready-to-show', () => {
    // `showInactive` under a background run: showing a window on macOS
    // activates the app, and an E2E suite that launches one app per test would
    // otherwise take the foreground away from whatever the developer is doing,
    // repeatedly. See `BACKGROUND_WINDOW`.
    if (BACKGROUND_WINDOW) mainWindow!.showInactive()
    else mainWindow!.show()
  })

  // Sync auto-discovery (P4): poll the pairing inbox only while the window is
  // focused, so a trusted, foregrounded device surfaces incoming pairing
  // requests without the user transferring a routing code. Stops on blur.
  mainWindow.on('focus', () => syncService.setWindowFocused(true))
  mainWindow.on('blur', () => syncService.setWindowFocused(false))

  // The menu-bar tray lives only while a main window exists AND the user has
  // it enabled in Settings → Features → Interface. Closing the window (macOS
  // keeps the app alive) tears it down; `activate` rebuilds both.
  syncTrayFromSettings()

  mainWindow.on('closed', () => {
    syncService.setWindowFocused(false)
    trayService.destroy()
    mainWindow = null
  })

  mainWindow.webContents.on('render-process-gone', (_event, details) => {
    if (details.reason === 'clean-exit') return
    handleRendererFailure(
      'render-process-gone',
      `reason: ${details.reason}, exitCode: ${details.exitCode}`
    )
  })

  mainWindow.webContents.on('did-fail-load', (_event, errorCode, errorDescription, validatedURL) => {
    // -3 is ERR_ABORTED, fired during normal navigation cancellation.
    if (errorCode === -3) return
    handleRendererFailure(
      'did-fail-load',
      `code: ${errorCode}, desc: ${errorDescription}, url: ${validatedURL}`
    )
  })

  mainWindow.webContents.setWindowOpenHandler((details) => {
    // Defense-in-depth: only forward http(s) URLs to the OS. Some link sources
    // (e.g. third-party MCP registry data) are untrusted, and shell.openExternal
    // will hand any registered scheme — file:, javascript:, custom protocol —
    // straight to the OS.
    try {
      const parsed = new URL(details.url)
      if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
        shell.openExternal(details.url)
      }
    } catch {
      // Invalid URL — ignore
    }
    return { action: 'deny' }
  })

  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

app.whenReady().then(() => {
  try {
    startup()
  } catch (err) {
    handleFatal(err, 'whenReady')
  }
})

function startup(): void {
  rotateStartupLog()

  // Before any window exists: an `accessory` app has no Dock tile and cannot
  // become the active application, which is what actually stops a test run from
  // stealing focus — `showInactive` alone still activates the app the first
  // time it is called.
  if (BACKGROUND_WINDOW && process.platform === 'darwin') app.setActivationPolicy('accessory')

  electronApp.setAppUserModelId('com.cinna.desktop')

  appIconService.apply(appIconService.getCurrentTheme())

  const toggleLogsOverlay = (): void => {
    const win = getMainWindow()
    if (win && !win.isDestroyed()) {
      win.webContents.send('logger:toggle-overlay')
    }
  }

  const menu = Menu.buildFromTemplate([
    {
      label: app.name,
      submenu: [
        { role: 'about' },
        {
          label: 'Check for Updates…',
          click: () => {
            void checkForUpdatesManual()
          }
        },
        { type: 'separator' },
        { role: 'services' },
        { type: 'separator' },
        { role: 'hide' },
        { role: 'hideOthers' },
        { role: 'unhide' },
        { type: 'separator' },
        { role: 'quit' }
      ]
    },
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'selectAll' }
      ]
    },
    {
      label: 'View',
      submenu: [
        {
          label: 'Toggle App Logs',
          accelerator: 'CommandOrControl+`',
          click: toggleLogsOverlay
        },
        {
          label: 'Toggle App Logs (alt)',
          accelerator: 'CommandOrControl+Shift+`',
          visible: false,
          acceleratorWorksWhenHidden: true,
          click: toggleLogsOverlay
        }
      ]
    },
    { role: 'windowMenu' }
  ])
  Menu.setApplicationMenu(menu)

  app.on('browser-window-created', (_, window) => {
    optimizer.watchWindowShortcuts(window)
  })

  initDatabase()
  initSession()
  registerAllIpcHandlers()
  // Providers are activated through auth flow (auth:get-startup / auth:login)

  createWindow()
  initAutoUpdater()

  // Linux (and, later, Windows) deliver the URL by re-launching the app with it
  // appended to argv rather than through `open-url`; the E2E suite uses the
  // `--cinna-connect-intent=` form of the same thing. Both land in the funnel
  // the OS hooks above use, so nothing downstream can tell them apart.
  const startupIntentUrl = connectUrlFromArgv(process.argv)
  if (startupIntentUrl) {
    connectIntentService.deliver(
      startupIntentUrl,
      startupIntentUrl.startsWith('cinna://') ? 'argv' : 'test-argv'
    )
  }

  // Pause periodic sync around OS sleep so a token refresh can't be suspended
  // mid-flight and orphaned (→ rotation-replay self-logout on wake); re-arm +
  // catch up on resume. `powerMonitor` is only available after the app is ready.
  powerMonitor.on('suspend', () => syncService.setSystemSuspended(true))
  powerMonitor.on('resume', () => {
    syncService.setSystemSuspended(false)
    // A laptop that was closed for a week wakes with an expired account token
    // and possibly a server that has bumped its pins. The reconciler is
    // idempotent and single-flight, so this is a cheap check that costs nothing
    // when everything is already right.
    // `reconcile` answers `idle` for a local profile, so no guard is needed
    // here beyond asking the session who is active.
    void localDevService.reconcile(getCurrentUserId())
  })

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })

  startupComplete = true
}

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})

app.on('will-quit', async () => {
  await mcpManager.disconnectAll()
})

export function getMainWindow(): BrowserWindow | null {
  return mainWindow
}
