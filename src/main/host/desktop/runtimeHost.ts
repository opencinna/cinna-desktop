import { createRequire } from 'node:module'
import { join } from 'node:path'
import { app, net, safeStorage, session, shell, BrowserWindow } from 'electron'
import type { RuntimeHost } from '../runtimeHost'
import type { EventPublisher } from '../events'

/** Electron objects never cross this interface into the runtime. Paths stay lazy:
 * CINNA_USER_DATA and app readiness are established after module evaluation.
 */
export function createDesktopHost(): RuntimeHost {
  return {
    getPath: (name) => app.getPath(name),
    getVersion: () => app.getVersion(),
    getAppPath: () => app.getAppPath(),
    get isPackaged() { return app.isPackaged },
    get resourcesPath() { return process.resourcesPath },
    http: { fetch: (input, init) => net.fetch(input, init) },
    keystore: {
      isEncryptionAvailable: () => safeStorage.isEncryptionAvailable(),
      encryptString: (value) => safeStorage.encryptString(value),
      decryptString: (value) => safeStorage.decryptString(value)
    },
    resolveProxy: (url) => session.defaultSession.resolveProxy(url),
    resolvePackageFile: (specifier) => app.isPackaged
      ? join(process.resourcesPath, 'app.asar.unpacked', 'node_modules', specifier)
      : createRequire(import.meta.url).resolve(specifier),
    nodeRuntime: () => ({ command: process.execPath, args: [], env: { ELECTRON_RUN_AS_NODE: '1' } }),
    onShutdown: (listener) => { app.on('will-quit', listener) },
    shell: {
      openExternal: (url) => shell.openExternal(url),
      openPath: (path) => shell.openPath(path),
      showItemInFolder: (path) => shell.showItemInFolder(path),
      trashItem: (path) => shell.trashItem(path)
    }
  }
}

export function desktopEventPublisher(getMainWindow: () => BrowserWindow | null): EventPublisher {
  return (channel, payload, audience) => {
    const windows = audience === 'all' ? BrowserWindow.getAllWindows() : [getMainWindow()]
    for (const win of windows) {
      if (win && !win.isDestroyed()) win.webContents.send(channel, payload)
    }
  }
}
