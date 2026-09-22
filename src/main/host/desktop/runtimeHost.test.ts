import { afterEach, describe, expect, it, vi } from 'vitest'
const platform = vi.hoisted(() => ({ packaged: false, backend: 'basic_text', encryption: true }))
vi.mock('electron', () => ({ safeStorage: { isEncryptionAvailable: () => platform.encryption, getSelectedStorageBackend: () => platform.backend, encryptString: (s: string) => Buffer.from('encrypted:' + s), decryptString: (b: Buffer) => b.toString().slice('encrypted:'.length) }, app: { get isPackaged() { return platform.packaged } }, BrowserWindow: { getAllWindows: () => windows } }))
import type { BrowserWindow } from 'electron'
import { createDesktopHost, desktopEventPublisher } from './runtimeHost'
const windows: BrowserWindow[] = []
function window(destroyed = false) {
  return { isDestroyed: () => destroyed, webContents: { send: vi.fn() } } as unknown as BrowserWindow
}
describe('desktop event adapter', () => {
  it('preserves main-only versus all-window delivery and ignores dead windows', () => {
    let main: BrowserWindow | null = null
    const publish = desktopEventPublisher(() => main)
    const first = window(), tray = window(), destroyed = window(true)
    windows.splice(0, windows.length, first, tray, destroyed)
    publish('changed', { id: 1 }, 'main')
    expect(first.webContents.send).not.toHaveBeenCalled()
    main = first
    publish('changed', { id: 2 }, 'main')
    expect(first.webContents.send).toHaveBeenCalledWith('changed', { id: 2 })
    expect(tray.webContents.send).not.toHaveBeenCalled()
    publish('changed', { id: 3 }, 'all')
    expect(tray.webContents.send).toHaveBeenCalledWith('changed', { id: 3 })
    expect(destroyed.webContents.send).not.toHaveBeenCalled()
    main = destroyed
    publish('changed', {}, 'main')
    expect(destroyed.webContents.send).not.toHaveBeenCalled()
  })
})

afterEach(() => { vi.unstubAllGlobals(); platform.packaged = false })
it('resolves real-disk packaged adapters and selects Electron as a Node child only in the desktop host', () => {
  const executable = process.execPath
  vi.stubGlobal('process', { ...process, resourcesPath: '/application/Resources' })
  const host = createDesktopHost()
  const entry = '@agentclientprotocol/claude-agent-acp/dist/index.js'
  expect(host.resolvePackageFile(entry)).toContain('/node_modules/@agentclientprotocol/claude-agent-acp/dist/index.js')
  platform.packaged = true
  expect(host.resolvePackageFile(entry)).toBe('/application/Resources/app.asar.unpacked/node_modules/' + entry)
  expect(host.nodeRuntime()).toEqual({ command: executable, args: [], env: { ELECTRON_RUN_AS_NODE: '1' } })
})

it('retains provider and OAuth encryption on Linux basic_text while refusing service credentials', async () => {
  vi.stubGlobal('process', { ...process, platform: 'linux' })
  const { installRuntimeHost } = await import('../runtimeHost')
  const { encryptApiKey, decryptApiKey } = await import('../../security/keystore')
  const host = createDesktopHost(); installRuntimeHost(host)
  expect(host.keystore.isEncryptionAvailable()).toBe(true)
  expect(host.keystore.isSecureStorageAvailable()).toBe(false)
  expect(decryptApiKey(Buffer.from('encrypted:previous-oauth-token'))).toBe('previous-oauth-token')
  expect(encryptApiKey('new-provider-key').toString()).toBe('encrypted:new-provider-key')
  platform.backend = 'gnome_libsecret'
  expect(host.keystore.isSecureStorageAvailable()).toBe(true)
})
