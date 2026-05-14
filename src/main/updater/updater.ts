import { app, dialog } from 'electron'
import electronUpdater from 'electron-updater'
import { is } from '@electron-toolkit/utils'
import { createLogger } from '../logger/logger'

const { autoUpdater } = electronUpdater

const log = createLogger('updater')

const SIX_HOURS_MS = 6 * 60 * 60 * 1000

export function initAutoUpdater(): void {
  if (is.dev) {
    log.info('skipping auto-updater in dev mode')
    return
  }

  autoUpdater.autoDownload = true
  autoUpdater.autoInstallOnAppQuit = true

  autoUpdater.logger = {
    info: (msg: string) => log.info(msg),
    warn: (msg: string) => log.warn(msg),
    error: (msg: string) => log.error(msg),
    debug: (msg: string) => log.debug(msg)
  } as never

  autoUpdater.on('checking-for-update', () => log.info('checking for update'))
  autoUpdater.on('update-available', (info) =>
    log.info(`update available: ${info.version}`)
  )
  autoUpdater.on('update-not-available', () => log.info('no update available'))
  autoUpdater.on('error', (err) => log.error(`updater error: ${err.message}`))
  autoUpdater.on('download-progress', (p) =>
    log.debug(`download ${p.percent.toFixed(1)}% (${p.transferred}/${p.total})`)
  )

  autoUpdater.on('update-downloaded', async (info) => {
    log.info(`update downloaded: ${info.version} — prompting user`)
    const { response } = await dialog.showMessageBox({
      type: 'info',
      buttons: ['Restart now', 'Later'],
      defaultId: 0,
      cancelId: 1,
      title: 'Update ready',
      message: `Cinna Desktop ${info.version} is ready to install.`,
      detail: 'The app will restart to apply the update.'
    })
    if (response === 0) {
      autoUpdater.quitAndInstall()
    }
  })

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
