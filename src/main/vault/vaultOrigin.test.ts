import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createTestDatabase, type TestDatabase } from '../db/testSupport/nodeSqlite'
import type { HelperFlavor, VaultSummary } from '../../shared/vault/protocol'

/**
 * A vault another build of Cinna made reads as `tampered` to this build's
 * helper (each build keeps its keys in its own keychain group). Main reads the
 * vault's own `vault.json` to say which build made it, for tampered vaults only.
 */

const holder = vi.hoisted(() => ({ current: null as TestDatabase | null }))

vi.mock('../db/client', () => ({
  getDb: () => {
    if (!holder.current) throw new Error('test database not initialised')
    return holder.current.db
  },
  getRawSqlite: () => {
    if (!holder.current) throw new Error('test database not initialised')
    return holder.current.sqlite
  }
}))
vi.mock('../logger/logger', () => ({
  createLogger: () => ({ debug: () => {}, info: () => {}, warn: () => {}, error: () => {} }),
  setLogValueRedactor: () => {}
}))

const { agentRepo } = await import('../db/agents')
const { installRuntimeHost } = await import('../host/runtimeHost')
const { installEventPublisher } = await import('../host/events')
const { installVaultBackend, unavailableBackend, VaultBackendError } = await import('./backend')
const { vaultService } = await import('./vaultService')
const { resetVaultAgentsForTest } = await import('./isVaultAgent')
const { agentsHomeService } = await import('../services/localAgents/agentsHomeService')
const { otherBuildOf, readVaultOrigin } = await import('./vaultOrigin')
const { vaultOtherBuildText } = await import('../../shared/vault/types')

const USER = '__default__'
const AGENT = 'folder:cccccccc-0000-0000-0000-000000000009'
const VAULT = 'vault-origin'

let home = ''

function writeVaultJson(dir: string, body: Record<string, unknown>): void {
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'vault.json'), `{"sig":"${'0'.repeat(64)}","vault":${JSON.stringify(body)}}`)
}

describe('readVaultOrigin', () => {
  let dir = ''
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'cinna-vault-origin-'))
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('says release for a guest under SecureAgents/.images', () => {
    writeVaultJson(dir, { wrappedKey: 'abc', rootfsPath: '/Users/x/Agents/SecureAgents/.images/rootfs-0.12.0-1.img' })
    expect(readVaultOrigin(dir)).toBe('release')
  })

  it('says dev for a guest anywhere else (build/vault-guest, CINNA_VAULT_GUEST_DIR)', () => {
    writeVaultJson(dir, { wrappedKey: 'abc', rootfsPath: '/Users/x/dev/cinna-desktop/build/vault-guest/rootfs.img' })
    expect(readVaultOrigin(dir)).toBe('dev')
  })

  it('says test for the test flavor’s plain-text key, recorded or on disk', () => {
    writeVaultJson(dir, { wrappedKey: 'test-flavor-plaintext', rootfsPath: '/a/.images/rootfs.img' })
    expect(readVaultOrigin(dir)).toBe('test')
    writeVaultJson(dir, { wrappedKey: 'abc', rootfsPath: '/a/.images/rootfs.img' })
    writeFileSync(join(dir, 'test.key'), 'k')
    expect(readVaultOrigin(dir)).toBe('test')
  })

  it('does not know when the file is missing, not JSON, or names no guest', () => {
    expect(readVaultOrigin(dir)).toBeNull()
    writeFileSync(join(dir, 'vault.json'), 'not json')
    expect(readVaultOrigin(dir)).toBeNull()
    writeVaultJson(dir, { wrappedKey: 'abc' })
    expect(readVaultOrigin(dir)).toBeNull()
  })
})

describe('otherBuildOf', () => {
  it('names the origin only when it is known and differs from the running helper', () => {
    expect(otherBuildOf('dev', 'release')).toBe('dev')
    expect(otherBuildOf('release', 'dev')).toBe('release')
    expect(otherBuildOf('release', 'release')).toBeNull()
    expect(otherBuildOf(null, 'release')).toBeNull()
    expect(otherBuildOf('dev', null)).toBeNull()
    expect(otherBuildOf('dev', 'fake')).toBeNull()
  })
})

describe('vaultService and a vault another build made', () => {
  let state: VaultSummary['state'] = 'tampered'
  let flavor: HelperFlavor = 'release'

  function summary(): VaultSummary {
    return {
      vaultId: VAULT, agentId: AGENT, agentName: 'Ledger', state, sizeBytes: 0, egress: { hosts: [] },
      engine: 'claude', createdAt: 0, imageVersion: ''
    }
  }

  function stubBackend(): never {
    const refuse = async (): Promise<never> => { throw new VaultBackendError('tampered', 'signature does not match') }
    return {
      kind: 'apple-vz',
      capabilities: () => ({ separateKernel: true, hardwareKey: true, perActionPresence: true, lockTimeouts: [], idleTouch: false }),
      hello: async () => ({ flavor, helperVersion: '1', guest: { version: '1', rootHash: '' } }),
      availability: async () => ({ ok: true }),
      list: async () => [summary()],
      status: async () => summary(),
      unlock: refuse,
      approve: refuse,
      lock: async () => state,
      onEvent: () => () => {},
      shutdown: async () => {}
    } as never
  }

  beforeEach(() => {
    holder.current = createTestDatabase()
    home = mkdtempSync(join(tmpdir(), 'cinna-vault-origin-svc-'))
    installRuntimeHost({ isPackaged: false, getAppPath: () => home } as never)
    // An unpackaged build's guest, so an unlock reaches the helper.
    mkdirSync(join(home, 'build', 'vault-guest'), { recursive: true })
    writeFileSync(join(home, 'build', 'vault-guest', 'rootfs.img'), '')
    installEventPublisher(() => {})
    vi.spyOn(agentsHomeService, 'rootRows').mockReturnValue([{ id: 'root-1', path: home, isDefault: true, kind: 'workshop' } as never])
    agentRepo.replaceFolderIndex(USER, 'root-1', [{ id: AGENT, name: 'Ledger', description: null, localPath: join(home, 'Local', 'ledger'), remoteMetadata: {} as never, launcher: 'claude' }])
    agentRepo.markVault(USER, AGENT, { vaultId: VAULT, engine: 'claude' })
    state = 'tampered'
    flavor = 'release'
    vaultService.resetForTest()
    installVaultBackend(stubBackend())
    vaultService.init()
    const secure = vaultService.ensureSecureAgentsDir(USER)
    writeVaultJson(join(secure, VAULT), { wrappedKey: 'abc', rootfsPath: join(home, 'build', 'vault-guest', 'rootfs.img') })
  })

  afterEach(() => {
    vaultService.resetForTest()
    installVaultBackend(unavailableBackend('helper-missing'))
    resetVaultAgentsForTest()
    vi.restoreAllMocks()
    holder.current?.close()
    holder.current = null
    rmSync(home, { recursive: true, force: true })
  })

  it('says a dev vault met by the release helper is from another build, in its status and the list entry', async () => {
    expect((await vaultService.status(USER, AGENT)).otherBuild).toBe('dev')
    expect(vaultService.otherBuild(USER, VAULT)).toBe('dev')
  })

  it('answers an unlock, and any gated call, with the other-build sentence instead of the helper’s reason', async () => {
    expect(await vaultService.result(() => vaultService.unlock(USER, AGENT))).toEqual({
      ok: false, code: 'tampered', message: vaultOtherBuildText('dev')
    })
    expect(await vaultService.result(() => vaultService.setSize(USER, AGENT, 2 * 1024 ** 3))).toEqual({
      ok: false, code: 'tampered', message: vaultOtherBuildText('dev')
    })
  })

  it('keeps the helper’s reason for a vault this build made (really tampered)', async () => {
    flavor = 'dev'
    expect((await vaultService.status(USER, AGENT)).otherBuild).toBeNull()
    expect(await vaultService.result(() => vaultService.unlock(USER, AGENT))).toEqual({
      ok: false, code: 'tampered', message: 'signature does not match'
    })
  })

  it('says nothing for the fake backend', async () => {
    flavor = 'fake'
    expect((await vaultService.status(USER, AGENT)).otherBuild).toBeNull()
    expect((await vaultService.result(() => vaultService.unlock(USER, AGENT)) as { message: string }).message).toBe('signature does not match')
  })

  it('reads vault.json only once the vault is tampered (a healthy one pays nothing)', async () => {
    flavor = 'dev'
    state = 'stopped'
    await vaultService.availability()
    expect((await vaultService.status(USER, AGENT)).otherBuild).toBeNull()
    expect(vaultService.otherBuild(USER, VAULT)).toBeNull()
    // Read now, it would say dev and be cached as such; it says release, so it was not read before.
    writeVaultJson(join(home, 'SecureAgents', VAULT), { wrappedKey: 'abc', rootfsPath: join(home, 'SecureAgents', '.images', 'rootfs-1.img') })
    state = 'tampered'
    expect((await vaultService.status(USER, AGENT)).otherBuild).toBe('release')
  })
})
