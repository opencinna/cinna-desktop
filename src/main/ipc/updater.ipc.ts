import { getUpdaterState, promptInstallCurrent } from '../updater/updater'
import { ipcHandle } from './_wrap'

export function registerUpdaterHandlers(): void {
  ipcHandle('updater:get-state', () => getUpdaterState())
  ipcHandle('updater:prompt-install', async () => {
    await promptInstallCurrent()
    return { success: true }
  })
}
