/**
 * Which vault backend this desktop runs (spec §5). Called by the entry point
 * before `initializeHubCore`; core never picks one itself.
 *
 * 1. `CINNA_VAULT_FAKE=1` in an unpackaged build: the fake (vaultd as a plain
 *    Node process). Checked first so an E2E run on a machine that also has a
 *    dev helper built never boots a real VM.
 * 2. Apple silicon with the helper present (always assumed when packaged): VZ.
 * 3. Otherwise nothing, with the reason the Security tab shows.
 */
import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { app, BrowserWindow, dialog } from 'electron'
import { installVaultHost } from '../../../vault/vaultHost'
import { installVaultBackend, unavailableBackend } from '../../../vault/backend'
import { createFakeBackend } from '../../../vault/fakeBackend'
import { runtimeHost } from '../../runtimeHost'
import { createAppleVzBackend } from './appleVzBackend'

const HELPER_IN_BUNDLE = ['VaultHelper.app', 'Contents', 'MacOS', 'VaultHelper']

/** `<Cinna.app>/Contents/Library/Helpers/…` packaged; `<repo>/resources/vault/…` in development. */
export function vaultHelperPath(): string {
  if (app.isPackaged) return join(dirname(process.execPath), '..', 'Library', 'Helpers', ...HELPER_IN_BUNDLE)
  return join(app.getAppPath(), 'resources', 'vault', ...HELPER_IN_BUNDLE)
}

/** `tmutil isexcluded <path>`: `[Excluded]` or `[Included]`; anything else is unknown. */
function timeMachineIncludes(path: string): Promise<boolean | null> {
  if (process.platform !== 'darwin') return Promise.resolve(null)
  return new Promise((resolve) => {
    execFile('/usr/bin/tmutil', ['isexcluded', path], { timeout: 5_000 }, (error, stdout) => {
      if (error) return resolve(null)
      if (stdout.includes('[Excluded]')) return resolve(false)
      if (stdout.includes('[Included]')) return resolve(true)
      resolve(null)
    })
  })
}

export function installDesktopVaultBackend(): void {
  installVaultHost({
    async saveDialog(defaultName) {
      const owner = BrowserWindow.getFocusedWindow()
      const options = { defaultPath: join(app.getPath('downloads'), defaultName) }
      const result = owner ? await dialog.showSaveDialog(owner, options) : await dialog.showSaveDialog(options)
      return result.canceled || !result.filePath ? null : result.filePath
    },
    timeMachineIncludes
  })
  if (process.env['CINNA_VAULT_FAKE'] === '1' && !app.isPackaged) {
    installVaultBackend(createFakeBackend({
      // Bundled beside this file's own bundle by electron-vite (`out/main/vaultd.js`).
      vaultdPath: join(__dirname, 'vaultd.js'),
      nodeRuntime: () => runtimeHost.nodeRuntime()
    }))
    return
  }
  if (process.platform !== 'darwin') {
    installVaultBackend(unavailableBackend('unsupported-os'))
    return
  }
  if (process.arch !== 'arm64') {
    installVaultBackend(unavailableBackend('unsupported-hardware'))
    return
  }
  const helperPath = vaultHelperPath()
  if (app.isPackaged || existsSync(helperPath)) {
    installVaultBackend(createAppleVzBackend({ helperPath, isPackaged: app.isPackaged }))
    return
  }
  installVaultBackend(unavailableBackend('helper-missing'))
}
