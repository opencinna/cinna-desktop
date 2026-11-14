import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { VaultGuestPin } from '../../shared/runtimePins'

vi.mock('../logger/logger', () => ({
  createLogger: () => ({ debug: () => {}, info: () => {}, warn: () => {}, error: () => {} }),
  setLogValueRedactor: () => {}
}))
vi.mock('../db/client', () => ({
  getDb: () => { throw new Error('no database in this test') },
  getRawSqlite: () => { throw new Error('no database in this test') }
}))

const { installRuntimeHost } = await import('../host/runtimeHost')
const { ensureGuestImage, guestHashMismatch, guestImagePath, guestRootfs, setGuestPinForTest } = await import('./guestImage')
const { installVaultBackend, unavailableBackend } = await import('./backend')
const { vaultService } = await import('./vaultService')

const IMAGE = Buffer.from('erofs+verity'.repeat(4096))
const ROOT_HASH = 'a'.repeat(64)

let home = ''
let secure = ''
let server: Server
let hits = 0
let body: Buffer = IMAGE

function pin(overrides: Partial<VaultGuestPin> = {}): VaultGuestPin {
  const port = (server.address() as AddressInfo).port
  return {
    published: true,
    version: '1.0.0-1',
    rootHash: ROOT_HASH,
    hashOffset: 4096,
    rootfs: { file: 'rootfs.img', url: `http://127.0.0.1:${port}/rootfs.img`, sha256: createHash('sha256').update(IMAGE).digest('hex'), size: IMAGE.length },
    ...overrides
  }
}

function host(isPackaged: boolean): void {
  installRuntimeHost({ isPackaged, getAppPath: () => home } as never)
}

beforeEach(async () => {
  home = mkdtempSync(join(tmpdir(), 'cinna-vault-image-'))
  secure = join(home, 'SecureAgents')
  mkdirSync(secure)
  hits = 0
  body = IMAGE
  server = createServer((_req, res) => {
    hits++
    res.writeHead(200, { 'content-length': String(body.length) })
    res.end(body)
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  delete process.env['CINNA_VAULT_GUEST_DIR']
})

afterEach(async () => {
  setGuestPinForTest(null)
  vaultService.resetForTest()
  installVaultBackend(unavailableBackend('helper-missing'))
  server.closeAllConnections()
  await new Promise((resolve) => server.close(resolve))
  rmSync(home, { recursive: true, force: true })
  delete process.env['CINNA_VAULT_GUEST_DIR']
})

describe('the guest image of a packaged build', () => {
  it('is unavailable while no image is published', async () => {
    host(true)
    setGuestPinForTest({ ...pin(), published: false })
    expect(guestRootfs()).toMatchObject({ ok: false })
    await expect(ensureGuestImage(secure)).rejects.toThrow(/No vault guest image has been published/)
    expect(hits).toBe(0)
  })

  it('downloads the pinned image once into SecureAgents/.images, verified, with progress', async () => {
    host(true)
    setGuestPinForTest(pin())
    const progress: number[] = []
    const path = await ensureGuestImage(secure, (p) => progress.push(p))
    expect(path).toBe(join(secure, '.images', 'rootfs-1.0.0-1.img'))
    expect(path).toBe(guestImagePath(secure))
    expect(readFileSync(path).equals(IMAGE)).toBe(true)
    expect(statSync(path).mode & 0o222).toBe(0)
    expect(progress.at(-1)).toBe(100)
    // Nothing left of the download but the image.
    expect(readdirSync(join(secure, '.images'))).toEqual(['rootfs-1.0.0-1.img'])
    // Already there: no second download.
    expect(await ensureGuestImage(secure)).toBe(path)
    expect(hits).toBe(1)
  })

  it('joins a download already running instead of starting another', async () => {
    host(true)
    setGuestPinForTest(pin())
    const first: number[] = []
    const second: number[] = []
    const [a, b] = await Promise.all([ensureGuestImage(secure, (p) => first.push(p)), ensureGuestImage(secure, (p) => second.push(p))])
    expect(a).toBe(b)
    expect(hits).toBe(1)
    // The move that joined hears the download's progress as the first does.
    expect(first.at(-1)).toBe(100)
    expect(second.at(-1)).toBe(100)
  })

  it('publishes nothing when the bytes are not the pinned ones', async () => {
    host(true)
    setGuestPinForTest(pin())
    body = Buffer.from('a captive portal page')
    await expect(ensureGuestImage(secure)).rejects.toMatchObject({ code: 'checksum_mismatch' })
    expect(existsSync(guestImagePath(secure))).toBe(false)
    expect(readdirSync(join(secure, '.images'))).toEqual([])
  })
})

describe('the helper root hash', () => {
  it('must equal the pinned root hash in a packaged build', () => {
    host(true)
    setGuestPinForTest(pin())
    expect(guestHashMismatch(ROOT_HASH)).toBeNull()
    expect(guestHashMismatch(ROOT_HASH.toUpperCase())).toBeNull()
    expect(guestHashMismatch('b'.repeat(64))).toMatch(/built for another guest image/)
    expect(guestHashMismatch('')).toMatch(/built for another guest image/)
  })

  it('is compared with the dev image\'s guest.lock.json when there is one', () => {
    host(false)
    process.env['CINNA_VAULT_GUEST_DIR'] = home
    expect(guestHashMismatch('anything')).toBeNull()
    writeFileSync(join(home, 'guest.lock.json'), JSON.stringify({ rootHash: ROOT_HASH }))
    expect(guestHashMismatch(ROOT_HASH)).toBeNull()
    expect(guestHashMismatch('b'.repeat(64))).toMatch(/another guest image/)
  })

  it('makes a helper built for another image unavailable (image-missing, with the reason)', async () => {
    host(true)
    setGuestPinForTest(pin())
    const helper = (rootHash: string) => ({
      ...unavailableBackend('helper-missing'),
      kind: 'apple-vz' as const,
      availability: async () => ({ ok: true as const }),
      hello: async () => ({ flavor: 'release' as const, helperVersion: '1', guest: { version: '1.0.0-1', rootHash } })
    })
    installVaultBackend(helper('b'.repeat(64)))
    const wrong = await vaultService.availability(true)
    expect(wrong.availability).toMatchObject({ ok: false, reason: 'image-missing' })
    expect((wrong.availability as { detail?: string }).detail).toMatch(/another guest image/)
    installVaultBackend(helper(ROOT_HASH))
    expect((await vaultService.availability(true)).availability).toEqual({ ok: true })
  })
})
