import { createRequire } from 'node:module'
import { join } from 'node:path'
import { app, net, safeStorage, session, shell, BrowserWindow } from 'electron'
import type { RuntimeHost } from '../runtimeHost'
import { nativeImageThumbnail } from './imageThumbnails'
import type { EventPublisher } from '../events'
import { createLogger } from '../../logger/logger'

const keystoreLogger = createLogger('keystore')

/**
 * Electron's async `safeStorage` (the sync calls are deprecated in 45, removed
 * in 46). Availability is fixed once the async encryptor has initialised after
 * `ready`, so `prepare()` resolves it once and the getters stay synchronous for
 * the status readers. Reading it before `prepare()` throws: silently answering
 * "unavailable" would send a secret down the plaintext fallback.
 */
export function createDesktopKeystore(): RuntimeHost['keystore'] {
  let availability: { encryption: boolean; secure: boolean } | undefined
  let reEncryptWarned = false
  const prepared = (): { encryption: boolean; secure: boolean } => {
    if (!availability) throw new Error('Keystore read before keystore.prepare() resolved')
    return availability
  }
  return {
    async prepare() {
      const encryption = await safeStorage.isAsyncEncryptionAvailable()
      const secure = encryption &&
        (process.platform !== 'linux' || !['basic_text', 'unknown'].includes(safeStorage.getSelectedStorageBackend()))
      availability = { encryption, secure }
    },
    isEncryptionAvailable: () => prepared().encryption,
    isSecureStorageAvailable: () => prepared().secure,
    encryptString: (value) => safeStorage.encryptStringAsync(value),
    async decryptString(value) {
      const { result, shouldReEncrypt } = await safeStorage.decryptStringAsync(value)
      if (shouldReEncrypt && !reEncryptWarned) {
        reEncryptWarned = true
        keystoreLogger.warn('safeStorage asks for stored secrets to be re-encrypted; they are kept as they are')
      }
      return result
    }
  }
}

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
    keystore: createDesktopKeystore(),
    resolveProxy: (url) => session.defaultSession.resolveProxy(url),
    resolvePackageFile: (specifier) => app.isPackaged
      ? join(process.resourcesPath, 'app.asar.unpacked', 'node_modules', specifier)
      : createRequire(import.meta.url).resolve(specifier),
    nodeRuntime: () => ({ command: process.execPath, args: [], env: { ELECTRON_RUN_AS_NODE: '1' } }),
    onShutdown: (listener) => { app.on('will-quit', listener) },
    images: { thumbnail: (bytes, maxSide) => nativeImageThumbnail(bytes, maxSide) },
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
