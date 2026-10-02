import {
  app,
  BrowserWindow,
  dialog,
  type MessageBoxOptions,
  type MessageBoxReturnValue
} from 'electron'
import electronUpdater from 'electron-updater'
import { is } from '@electron-toolkit/utils'
import { createLogger } from '../../logger/logger'
import { ensureMainWindow, focusMainWindow } from '../../window/focus'
import {
  UPDATER_BROADCAST_CHANNEL,
  type UpdaterState
} from '../../../shared/updaterState'

const { autoUpdater } = electronUpdater

const log = createLogger('updater')

const SIX_HOURS_MS = 6 * 60 * 60 * 1000

let updaterConfigured = false
let currentState: UpdaterState = { phase: 'idle' }

function setState(next: UpdaterState): void {
  currentState = next
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) {
      win.webContents.send(UPDATER_BROADCAST_CHANNEL, currentState)
    }
  }
}

export function getUpdaterState(): UpdaterState {
  return currentState
}

/**
 * Every updater dialog, attached to the main window as a sheet.
 *
 * Without a parent, Electron on macOS shows the box with `runModal`: an
 * app-modal panel that blocks every window and even Quit. Opened from a
 * background app — the download finishing right after the laptop wakes — it
 * orders *beneath* the active app's windows, and Cinna then ignores every click
 * with nothing on screen to say why. A sheet is drawn on the window itself and
 * cannot end up behind it. Electron falls back to `runModal` for a hidden
 * parent, so a hidden or minimized window is brought up first, and a closed
 * one (macOS keeps the app alive without it) is reopened.
 */
async function showUpdaterDialog(options: MessageBoxOptions): Promise<MessageBoxReturnValue> {
  const win = await ensureMainWindow()
  if (!win) return dialog.showMessageBox(options)
  if (!win.isVisible() || win.isMinimized()) focusMainWindow()
  return dialog.showMessageBox(win, options)
}

async function promptInstall(version: string): Promise<void> {
  const { response } = await showUpdaterDialog({
    type: 'info',
    buttons: ['Restart now', 'Later'],
    defaultId: 0,
    cancelId: 1,
    title: 'Update ready',
    message: `Cinna Desktop ${version} is ready to install.`,
    detail: 'The app will restart to apply the update.'
  })
  if (response === 0) {
    autoUpdater.quitAndInstall()
  }
}

export async function promptInstallCurrent(): Promise<void> {
  if (currentState.phase !== 'downloaded') {
    await showUpdaterDialog({
      type: 'info',
      title: 'Updates',
      message: 'No update is ready to install yet.',
      buttons: ['OK']
    })
    return
  }
  await promptInstall(currentState.version)
}

function configureUpdater(): void {
  if (updaterConfigured) return
  updaterConfigured = true

  autoUpdater.autoDownload = true
  autoUpdater.autoInstallOnAppQuit = true

  autoUpdater.logger = {
    info: (msg: string) => log.info(msg),
    warn: (msg: string) => log.warn(msg),
    error: (msg: string) => log.error(msg),
    debug: (msg: string) => log.debug(msg)
  } as never

  autoUpdater.on('checking-for-update', () => log.info('checking for update'))

  autoUpdater.on('update-available', (info) => {
    log.info(`update available: ${info.version}`)
    // Already-downloaded state wins — don't overwrite it with downloading(0)
    // when the periodic check re-discovers the same version.
    if (currentState.phase === 'downloaded' && currentState.version === info.version) {
      return
    }
    setState({ phase: 'downloading', version: info.version, percent: 0 })
  })

  autoUpdater.on('update-not-available', () => log.info('no update available'))

  autoUpdater.on('error', (err) => log.error(`updater error: ${err.message}`))

  autoUpdater.on('download-progress', (p) => {
    log.debug(`download ${p.percent.toFixed(1)}% (${p.transferred}/${p.total})`)
    if (currentState.phase === 'downloaded') return
    const version = currentState.phase === 'downloading' ? currentState.version : ''
    setState({ phase: 'downloading', version, percent: p.percent })
  })

  // No dialog here: the user did not ask for one, and a download usually
  // finishes while they are doing something else. The renderer shows the
  // ready badge, and `autoInstallOnAppQuit` installs on the next quit anyway.
  autoUpdater.on('update-downloaded', (info) => {
    log.info(`update downloaded: ${info.version}`)
    setState({ phase: 'downloaded', version: info.version })
  })
}

export function initAutoUpdater(): void {
  if (is.dev) {
    log.info('skipping auto-updater in dev mode')
    return
  }

  configureUpdater()

  autoUpdater.checkForUpdates().catch((err) => log.error(`initial check failed: ${err.message}`))

  setInterval(() => {
    autoUpdater.checkForUpdates().catch((err) =>
      log.error(`periodic check failed: ${err.message}`)
    )
  }, SIX_HOURS_MS)

  app.on('before-quit', () => {
    // electron-updater installs queued update via autoInstallOnAppQuit
  })
}

export async function checkForUpdatesManual(): Promise<void> {
  try {
    if (is.dev) {
      await showUpdaterDialog({
        type: 'info',
        title: 'Updates',
        message: 'Auto-update is disabled in development builds.',
        buttons: ['OK']
      })
      return
    }

    configureUpdater()
    log.info('manual check requested')
    const result = await autoUpdater.checkForUpdates()

    if (result?.downloadPromise) {
      await showUpdaterDialog({
        type: 'info',
        title: 'Update available',
        message: `Cinna Desktop ${result.updateInfo.version} is downloading.`,
        detail: 'When it is ready, the download icon shows a green dot. Click it to restart and install.',
        buttons: ['OK']
      })
    } else if (currentState.phase === 'downloaded') {
      await promptInstall(currentState.version)
    } else {
      await showUpdaterDialog({
        type: 'info',
        title: 'You’re up to date',
        message: `Cinna Desktop ${app.getVersion()} is the latest version.`,
        buttons: ['OK']
      })
    }
  } catch (err) {
    log.error(`manual check failed: ${(err as Error).message}`)
    await showUpdaterDialog({
      type: 'error',
      title: 'Updates',
      message: 'Could not check for updates.',
      detail: (err as Error).message,
      buttons: ['OK']
    })
  }
}
