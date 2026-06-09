import { app, shell, BrowserWindow, Menu, dialog, powerMonitor } from 'electron'
import { join } from 'path'
import { appendFileSync, renameSync, statSync } from 'fs'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import { registerAllIpcHandlers } from './ipc'
import { initDatabase } from './db/client'
import { mcpManager } from './mcp/manager'
import { initSession } from './auth/session'
import { initAutoUpdater, checkForUpdatesManual } from './updater/updater'
import { appIconService } from './services/appIconService'
import { syncService } from './services/syncService'
import { trayService } from './services/trayService'
import { syncTrayFromSettings } from './services/traySync'
import { createLogger } from './logger/logger'

let mainWindow: BrowserWindow | null = null
let startupComplete = false
const bootLogger = createLogger('boot')

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
    mainWindow!.show()
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

  // Pause periodic sync around OS sleep so a token refresh can't be suspended
  // mid-flight and orphaned (→ rotation-replay self-logout on wake); re-arm +
  // catch up on resume. `powerMonitor` is only available after the app is ready.
  powerMonitor.on('suspend', () => syncService.setSystemSuspended(true))
  powerMonitor.on('resume', () => syncService.setSystemSuspended(false))

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
