import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { HelperEvent } from '../../shared/vault/protocol'
import { createFakeBackend } from './fakeBackend'
import { VaultdClient } from './vaultdClient'
import { STUB_VAULTD } from './testSupport/stubVaultd'
import type { VaultBackend } from './backend'

let dir = ''
let stub = ''
let backend: VaultBackend | null = null
const events: HelperEvent[] = []

function make(windowMs: number | null = 60_000): VaultBackend {
  backend = createFakeBackend({
    vaultdPath: stub,
    nodeRuntime: () => ({ command: process.execPath, args: [], env: {} }),
    ...(windowMs !== null ? { windowMs } : {})
  })
  backend.onEvent((event) => events.push(event))
  return backend
}

const spec = (vaultId = 'vault-1') => ({
  dir: join(dir, 'SecureAgents'), vaultId, agentId: 'folder:abc', agentName: 'Payroll', engine: 'claude' as const,
  sizeBytes: 10 * 1024 ** 3, egress: { hosts: ['api.anthropic.com'] }, rootfsPath: ''
})

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'cinna-fake-vault-'))
  stub = join(dir, 'stub-vaultd.cjs')
  writeFileSync(stub, STUB_VAULTD)
  events.length = 0
})

afterEach(async () => {
  await backend?.shutdown()
  backend = null
  rmSync(dir, { recursive: true, force: true })
})

describe('fake vault backend', () => {
  it('reports helper-missing while vaultd is not built', async () => {
    const missing = createFakeBackend({ vaultdPath: join(dir, 'nope.js'), nodeRuntime: () => ({ command: process.execPath, args: [], env: {} }) })
    expect(await missing.availability()).toMatchObject({ ok: false, reason: 'helper-missing' })
    expect(await make().availability()).toEqual({ ok: true })
    expect((await make().hello()).flavor).toBe('fake')
  })

  it('creates a vault whose vault.json a new backend lists after a restart, locked', async () => {
    await make().create(spec())
    const file = JSON.parse(readFileSync(join(dir, 'SecureAgents', 'vault-1', 'vault.json'), 'utf8'))
    expect(file).toMatchObject({ vaultId: 'vault-1', agentId: 'folder:abc', flavor: 'fake' })
    await backend!.shutdown()
    const listed = await make().list(join(dir, 'SecureAgents'))
    expect(listed).toEqual([expect.objectContaining({ vaultId: 'vault-1', agentName: 'Payroll', state: 'locked', engine: 'claude' })])
  })

  it('unlocks by starting vaultd, opens control and attached connections, and refuses open while locked', async () => {
    const b = make()
    await b.create(spec())
    await expect(b.open('vault-1')).rejects.toMatchObject({ code: 'locked' })
    expect(await b.unlock('vault-1', 'chat')).toBe('unlocked')
    expect(events.filter((e) => e.event === 'vault.state').map((e) => (e as { state: string }).state)).toEqual(['booting', 'unlocked'])

    const client = await VaultdClient.connect(await b.open('vault-1'), { openChannel: () => b.open('vault-1') })
    const hello = await client.request('hello', {}) as unknown as { vaultId: string; key: number }
    // vaultd is told its vault id and a 32-byte approval key (hex).
    expect(hello).toMatchObject({ vaultId: 'vault-1', key: 64 })
    await client.request('transcript.append', { chatId: 'c', ops: [{ op: 'chat', updatedAt: 1 }] })
    expect((await client.request('transcript.read', { chatId: 'c' })).ops).toHaveLength(1)
    await expect(client.request('kv.get', { key: 'x' })).rejects.toMatchObject({ code: 'invalid' })

    const stream = await client.attach('s1')
    const writer = stream.writable.getWriter()
    await writer.write(new TextEncoder().encode('ping'))
    const reader = stream.readable.getReader()
    let echoed = ''
    while (!echoed.includes('ping')) echoed += new TextDecoder().decode((await reader.read()).value)
    expect(echoed).toBe('attached:s1\nping')
    stream.close()
    client.close()
  })

  it('locks itself when the window closes, and a hold keeps it open', async () => {
    const b = make(150)
    await b.create(spec())
    await b.unlock('vault-1', 'chat')
    await b.hold('vault-1', 'turn-1')
    await new Promise((resolve) => setTimeout(resolve, 300))
    expect((await b.status('vault-1')).state).toBe('unlocked')
    expect((await b.status('vault-1')).until).toBeNull()
    await b.release('vault-1', 'turn-1')
    expect((await b.status('vault-1')).until).toEqual(expect.any(Number))
    await new Promise((resolve) => setTimeout(resolve, 300))
    expect((await b.status('vault-1')).state).toBe('locked')
    await expect(b.open('vault-1')).rejects.toMatchObject({ code: 'locked' })
    await expect(b.hold('vault-1', 'late')).rejects.toMatchObject({ code: 'locked' })
  })

  it('changes egress and size only with a token of the right action, and destroys the vault with one', async () => {
    const b = make()
    await b.create(spec())
    const resize = await b.approve('vault-1', 'resize', '20 GB')
    await expect(b.setEgress('vault-1', { hosts: ['evil.example'] }, resize)).rejects.toMatchObject({ code: 'bad_token' })
    await expect(b.setEgress('vault-1', { hosts: ['evil.example'] }, 'forged.token')).rejects.toMatchObject({ code: 'bad_token' })
    await b.resize('vault-1', 20 * 1024 ** 3, resize)
    await b.setEgress('vault-1', { hosts: ['pypi.org'] }, await b.approve('vault-1', 'egress', 'pypi.org'))
    expect(await b.status('vault-1')).toMatchObject({ sizeBytes: 20 * 1024 ** 3, egress: { hosts: ['pypi.org'] } })
    await b.destroy('vault-1', await b.approve('vault-1', 'destroy', 'Payroll'))
    expect(existsSync(join(dir, 'SecureAgents', 'vault-1'))).toBe(false)
    await expect(b.status('vault-1')).rejects.toMatchObject({ code: 'not_found' })
  })

  it('keeps each vault’s own lock timeout: 5 minutes by default, shorter freely, longer only with a lock-timeout token', async () => {
    const b = make(null)
    await b.create(spec())
    expect((await b.status('vault-1')).lockAfterMs).toBe(300_000)
    await b.unlock('vault-1', 'chat')
    const until = (await b.status('vault-1')).until!
    expect(until - Date.now()).toBeGreaterThan(290_000)

    await b.setLockTimeout('vault-1', 30_000)
    const shorter = await b.status('vault-1')
    expect(shorter.lockAfterMs).toBe(30_000)
    // Applied to the running vault at once.
    expect(shorter.until! - Date.now()).toBeLessThanOrEqual(30_000)

    await expect(b.setLockTimeout('vault-1', 300_000)).rejects.toMatchObject({ code: 'bad_token' })
    const egress = await b.approve('vault-1', 'egress', 'egress:')
    await expect(b.setLockTimeout('vault-1', 300_000, egress)).rejects.toMatchObject({ code: 'bad_token' })
    const forZero = await b.approve('vault-1', 'lock-timeout', 'lock-timeout:0')
    await expect(b.setLockTimeout('vault-1', 300_000, forZero)).rejects.toMatchObject({ code: 'bad_token' })
    await expect(b.setLockTimeout('vault-1', 60_000)).rejects.toMatchObject({ code: 'invalid' })

    // Until Cinna quits: no timer, until is null with no hold, and the state event says why.
    await b.setLockTimeout('vault-1', 0, forZero)
    expect(await b.status('vault-1')).toMatchObject({ state: 'unlocked', until: null, lockAfterMs: 0 })
    expect(events.at(-1)).toMatchObject({ event: 'vault.state', state: 'unlocked', until: null, lockAfterMs: 0 })
    expect(JSON.parse(readFileSync(join(dir, 'SecureAgents', 'vault-1', 'vault.json'), 'utf8')).lockAfterMs).toBe(0)
  })

  it('reads a vault.json written before the setting as 5 minutes', async () => {
    await make().create(spec())
    const path = join(dir, 'SecureAgents', 'vault-1', 'vault.json')
    const file = JSON.parse(readFileSync(path, 'utf8'))
    delete file.lockAfterMs
    writeFileSync(path, JSON.stringify(file))
    await backend!.shutdown()
    const [listed] = await make().list(join(dir, 'SecureAgents'))
    expect(listed.lockAfterMs).toBe(300_000)
  })

  it('a touch restarts an unlocked, unheld window and is a no-op otherwise', async () => {
    let now = 1_000_000
    backend = createFakeBackend({ vaultdPath: stub, nodeRuntime: () => ({ command: process.execPath, args: [], env: {} }), now: () => now })
    backend.onEvent((event) => events.push(event))
    const b = backend
    await b.create(spec())
    await b.touch('vault-1')
    expect((await b.status('vault-1')).state).toBe('locked')
    await b.unlock('vault-1', 'chat')
    expect((await b.status('vault-1')).until).toBe(1_000_000 + 300_000)
    now += 60_000
    const before = events.length
    await b.touch('vault-1')
    expect((await b.status('vault-1')).until).toBe(1_060_000 + 300_000)
    expect(events.length).toBe(before + 1)
    await b.hold('vault-1', 'turn')
    now += 1000
    await b.touch('vault-1')
    expect((await b.status('vault-1')).until).toBeNull()
  })
})
