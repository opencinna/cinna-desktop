import { afterEach, describe, expect, it, vi } from 'vitest'
const platform = vi.hoisted(() => ({ packaged: false, backend: 'basic_text', encryption: true, reEncrypt: false }))
const safe = vi.hoisted(() => ({
  isAsyncEncryptionAvailable: vi.fn(async () => platform.encryption),
  getSelectedStorageBackend: vi.fn(() => platform.backend),
  encryptStringAsync: vi.fn(async (s: string) => Buffer.from('encrypted:' + s)),
  decryptStringAsync: vi.fn(async (b: Buffer) => ({ result: b.toString().slice('encrypted:'.length), shouldReEncrypt: platform.reEncrypt })),
  // The deprecated synchronous API: any call is a regression.
  isEncryptionAvailable: vi.fn(() => { throw new Error('sync safeStorage.isEncryptionAvailable called') }),
  encryptString: vi.fn(() => { throw new Error('sync safeStorage.encryptString called') }),
  decryptString: vi.fn(() => { throw new Error('sync safeStorage.decryptString called') })
}))
vi.mock('electron', () => ({ safeStorage: safe, app: { get isPackaged() { return platform.packaged }, getAppPath: () => '/repo' }, BrowserWindow: { getAllWindows: () => windows } }))
import type { BrowserWindow } from 'electron'
import { join } from 'node:path'
import { createDesktopHost, desktopEventPublisher } from './runtimeHost'
import { getLogEntries } from '../../logger/logger'
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

afterEach(() => { vi.unstubAllGlobals(); platform.packaged = false; platform.backend = 'basic_text'; platform.encryption = true; platform.reEncrypt = false })
it('resolves real-disk packaged adapters and selects Electron as a Node child only in the desktop host', () => {
  const executable = process.execPath
  vi.stubGlobal('process', { ...process, resourcesPath: '/application/Resources', env: { ...process.env, NODE_EXTRA_CA_CERTS: undefined } })
  const host = createDesktopHost()
  const entry = '@agentclientprotocol/claude-agent-acp/dist/index.js'
  expect(host.resolvePackageFile(entry)).toContain('/node_modules/@agentclientprotocol/claude-agent-acp/dist/index.js')
  platform.packaged = true
  expect(host.resolvePackageFile(entry)).toBe('/application/Resources/app.asar.unpacked/node_modules/' + entry)
  // No extra CA file: the child starts exactly as before, with no preload to miss.
  expect(host.nodeRuntime()).toEqual({ command: executable, args: [], env: { ELECTRON_RUN_AS_NODE: '1' } })
  // With one, the preload is required and the file travels as CINNA_EXTRA_CA_CERTS, read per call.
  vi.stubGlobal('process', { ...process, resourcesPath: '/application/Resources', env: { ...process.env, NODE_EXTRA_CA_CERTS: '/corp/ca.pem' } })
  expect(host.nodeRuntime()).toEqual({
    command: executable,
    args: ['--require', '/application/Resources/app.asar.unpacked/resources/node-extra-ca/preload.cjs'],
    env: { CINNA_EXTRA_CA_CERTS: '/corp/ca.pem', ELECTRON_RUN_AS_NODE: '1' }
  })
  platform.packaged = false
  expect(host.nodeRuntime().args).toEqual(['--require', join('/repo', 'resources', 'node-extra-ca', 'preload.cjs')])
})

it('retains provider and OAuth encryption on Linux basic_text while refusing service credentials', async () => {
  vi.stubGlobal('process', { ...process, platform: 'linux' })
  const { installRuntimeHost } = await import('../runtimeHost')
  const { encryptApiKey, decryptApiKey } = await import('../../security/keystore')
  const host = createDesktopHost(); installRuntimeHost(host)
  await host.keystore.prepare()
  expect(host.keystore.isEncryptionAvailable()).toBe(true)
  expect(host.keystore.isSecureStorageAvailable()).toBe(false)
  expect(await decryptApiKey(Buffer.from('encrypted:previous-oauth-token'))).toBe('previous-oauth-token')
  expect((await encryptApiKey('new-provider-key')).toString()).toBe('encrypted:new-provider-key')
  platform.backend = 'gnome_libsecret'
  await host.keystore.prepare()
  expect(host.keystore.isSecureStorageAvailable()).toBe(true)
})

describe('desktop keystore', () => {
  it('refuses availability reads before prepare() has resolved', async () => {
    const host = createDesktopHost()
    expect(() => host.keystore.isEncryptionAvailable()).toThrow(/prepare/)
    expect(() => host.keystore.isSecureStorageAvailable()).toThrow(/prepare/)
    const preparing = host.keystore.prepare()
    // Still pending: the async encryptor has not answered yet.
    expect(() => host.keystore.isEncryptionAvailable()).toThrow(/prepare/)
    await preparing
    expect(host.keystore.isEncryptionAvailable()).toBe(true)
  })

  it('asks the async API once and caches both answers', async () => {
    safe.isAsyncEncryptionAvailable.mockClear(); safe.getSelectedStorageBackend.mockClear()
    vi.stubGlobal('process', { ...process, platform: 'linux' })
    platform.backend = 'kwallet6'
    const host = createDesktopHost()
    await host.keystore.prepare()
    platform.encryption = false; platform.backend = 'basic_text'
    for (let i = 0; i < 3; i++) {
      expect(host.keystore.isEncryptionAvailable()).toBe(true)
      expect(host.keystore.isSecureStorageAvailable()).toBe(true)
    }
    expect(safe.isAsyncEncryptionAvailable).toHaveBeenCalledTimes(1)
    expect(safe.getSelectedStorageBackend).toHaveBeenCalledTimes(1)
  })

  it('reports nothing available when the async encryptor is not', async () => {
    platform.encryption = false
    const host = createDesktopHost()
    await host.keystore.prepare()
    expect(host.keystore.isEncryptionAvailable()).toBe(false)
    expect(host.keystore.isSecureStorageAvailable()).toBe(false)
  })

  it('encrypts and decrypts through the async API only', async () => {
    safe.encryptStringAsync.mockClear(); safe.decryptStringAsync.mockClear()
    const host = createDesktopHost()
    await host.keystore.prepare()
    const sealed = await host.keystore.encryptString('sk-secret')
    expect(sealed.toString()).toBe('encrypted:sk-secret')
    expect(await host.keystore.decryptString(sealed)).toBe('sk-secret')
    expect(safe.encryptStringAsync).toHaveBeenCalledWith('sk-secret')
    expect(safe.decryptStringAsync).toHaveBeenCalledWith(sealed)
    expect(safe.isEncryptionAvailable).not.toHaveBeenCalled()
    expect(safe.encryptString).not.toHaveBeenCalled()
    expect(safe.decryptString).not.toHaveBeenCalled()
  })

  it('surfaces a decrypt rejection', async () => {
    const host = createDesktopHost()
    await host.keystore.prepare()
    safe.decryptStringAsync.mockRejectedValueOnce(new Error('Error while decrypting the ciphertext provided'))
    await expect(host.keystore.decryptString(Buffer.from('garbage'))).rejects.toThrow(/decrypting/)
  })

  it('warns once when Electron asks for re-encryption, and still returns the plaintext', async () => {
    platform.reEncrypt = true
    const host = createDesktopHost()
    await host.keystore.prepare()
    const warnings = (): number => getLogEntries().filter((entry) => entry.scope === 'keystore' && entry.level === 'warn').length
    const before = warnings()
    expect(await host.keystore.decryptString(Buffer.from('encrypted:one'))).toBe('one')
    expect(await host.keystore.decryptString(Buffer.from('encrypted:two'))).toBe('two')
    expect(warnings() - before).toBe(1)
  })
})
