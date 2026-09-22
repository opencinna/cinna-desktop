import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, statSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import type { ServiceCredentialRow } from '../../db/serviceCredentials'
const world = vi.hoisted(() => ({ user: '__default__', home: '', secure: true, agents: [] as any[], rows: new Map<string, any>(), metadata: [] as any[], token: 'fixture-cloud-token-123', allowed: true, fetch: vi.fn(), list: vi.fn() }))
vi.mock('../../host/runtimeHost', () => ({ runtimeHost: { getPath: () => world.home, keystore: {
  isEncryptionAvailable: () => true,
  isSecureStorageAvailable: () => world.secure,
  encryptString: (s: string) => Buffer.from([...Buffer.from(s)].map(b => b ^ 0x93)),
  decryptString: (b: Buffer) => Buffer.from([...b].map(v => v ^ 0x93)).toString()
} } }))
vi.mock('../../host/events', () => ({ publishEvent: vi.fn() }))
vi.mock('../../auth/scope', () => ({ getProfileScopeUserId: () => world.user }))
vi.mock('../../auth/cinna-tokens', () => ({ getStoredCinnaSubject: (id: string) => id.replace('new-', '') }))
vi.mock('../../db/users', () => ({ userRepo: { get: (id: string) => ({ type: id === '__default__' ? 'local_user' : 'cinna_user', cinnaServerUrl: 'http://localhost:8000' }) } }))
vi.mock('../../db/serviceCredentials', () => ({ credentialDto: (r: ServiceCredentialRow) => ({ ...JSON.parse(r.metadata), id: r.id, origin: r.origin, cloudId: r.cloud_id, hasValues: !!r.payload_enc, expiresAt: r.expires_at }), serviceCredentialRepo: {
  list: (id: string) => [...world.rows.values()].filter(r => r.user_id === id), get: (id: string) => world.rows.get(id), put: (r: any) => world.rows.set(r.id, r), remove: (id: string) => world.rows.delete(id), clearProfile: (id: string) => { for (const [key, row] of world.rows) if (row.user_id === id && row.origin === 'cloud') world.rows.delete(key) }
} }))
vi.mock('../localAgents/localAgentService', () => ({ localAgentService: { list: () => ({ agents: world.agents }), get: (_: string, id: string) => { const a = world.agents.find(a => a.id === id); if (!a) throw new Error('Agent missing'); return a } } }))
vi.mock('../localAgents/scannerService', () => ({ markAllRootsDirty() {} }))
vi.mock('../../shell/env', () => ({ getShellEnv: async () => process.env }))
vi.mock('./cloud', () => ({ serviceCredentialCloud: { list: (...args: unknown[]) => world.list(...args), materialize: (...args: unknown[]) => world.fetch(...args) } }))
import { serviceCredentialService as service } from './service'
import { turnLock } from '../localAgents/turnLock'
import { clearCredentialRedaction, redactCredentialText } from '../../security/serviceCredentialRedaction'
const sleep = () => new Promise(resolve => setTimeout(resolve, 30))
beforeEach(async () => {
  world.home = mkdtempSync(join(tmpdir(), 'cinna-credentials-')); world.user = '__default__'; world.rows.clear(); world.secure = true; world.agents = []; world.metadata = []; world.allowed = true
  world.list.mockImplementation(async () => ({ items: world.metadata }))
  world.fetch.mockImplementation(async (_user, ids: string[]) => ({ items: world.allowed ? ids.map(id => ({ id, revision: 'r1', entry: { id, name: 'Cloud', type: 'api_token', notes: null, service_uri: 'api', is_placeholder: false, credential_data: { http_header_name: 'Authorization', http_header_value: `Bearer ${world.token}` } }, service_account_file: null, ssh_key: null })) : [], refused: world.allowed ? [] : ids.map(id => ({ id, reason: 'no_access' })), current_user: null, owner_identity: null }))
  await service.activate('__default__')
})
afterEach(async () => { service.retire(); world.agents = []; turnLock.releaseAll(); await sleep(); rmSync(world.home, { recursive: true, force: true }); clearCredentialRedaction() })
function addAgent(kind: 'kit' | 'bare') {
  const path = join(world.home, kind); mkdirSync(path)
  const a = { id: `folder:${kind}`, kind, path }; world.agents.push(a); return a
}
function metadata() { return { id: 'cloud-fixture', name: 'Cloud', type: 'api_token', notes: null, service_uri: 'api', status: 'complete', is_placeholder: false, relation: 'shared', owner_email: 'owner@example.test', local_use_allowed: true, revision: 'r1' } }
async function login(user: string) { world.user = user; await service.activate(user); await service.sync(); await sleep() }
async function prepare(id: string) { return turnLock.withQueuedLock(id, 'test-turn', new AbortController().signal, () => service.prepare(world.user, id)) }
describe('credential delivery integration', () => {
  it('encrypts local values, writes cloud arrays, supports script reads, and preserves authored docs', async () => {
    const a = addAgent('kit'); mkdirSync(join(a.path, 'credentials')); writeFileSync(join(a.path, 'credentials', 'README.md'), 'authored docs')
    const c = service.save({ name: 'Token', type: 'api_token', serviceUri: 'api', values: { api_token: 'local-fixture-secret-123' } }); await sleep()
    expect(JSON.stringify(c)).not.toContain('local-fixture-secret')
    expect([...world.rows.values()][0].payload_enc.toString()).not.toContain('local-fixture-secret')
    await service.setAttachments(a.id, 'local', [c.id])
    const prep = await prepare(a.id), path = prep.path!
    expect(statSync(path).mode & 0o777).toBe(0o600)
    expect(statSync(join(a.path, 'credentials')).mode & 0o777).toBe(0o700)
    const modified = statSync(path).mtimeMs; await prepare(a.id); expect(statSync(path).mtimeMs).toBe(modified)
    const helper = join(process.cwd(), 'resources/cinna-kit-contract/templates/agent/scripts')
    const result = execFileSync('python3', ['-c', "from cinna_credentials import require_slot; assert require_slot('api')['http_header_value'] == 'Bearer local-fixture-secret-123'; print('script-ok')"], { env: { ...process.env, PYTHONPATH: helper, CINNA_CREDENTIALS_PATH: path }, encoding: 'utf8' })
    expect(result.trim()).toBe('script-ok')
    expect(redactCredentialText('local-fixture-secret-123')).toBe('***REDACTED***')
    await service.setAttachments(a.id, 'local', [])
    expect(existsSync(path)).toBe(false); expect(readFileSync(join(a.path, 'credentials/README.md'), 'utf8')).toBe('authored docs')
  })
  it('stores bare values outside the folder and refuses unavailable keystores', async () => {
    const a = addAgent('bare'); world.secure = false
    expect(() => service.save({ name: 'x', type: 'api_token', values: { api_token: 'secret-123456' } })).toThrow('Secure storage')
    world.secure = true
    const c = service.save({ name: 'x', type: 'api_token', values: { api_token: 'secret-123456' } }); await sleep()
    await service.setAttachments(a.id, 'local', [c.id]); const p = await prepare(a.id)
    expect(p.path).toContain('/agent-credentials/'); expect(existsSync(join(a.path, 'credentials'))).toBe(false)
  })
  it('lazily delivers shared credentials and removes files on owner opt-out', async () => {
    const a = addAgent('kit'); world.metadata = [metadata()]; await login('account-a')
    expect(world.fetch).not.toHaveBeenCalled()
    await service.setAttachments(a.id, 'cloud', ['cloud-fixture']); const p = await prepare(a.id)
    expect(readFileSync(p.path!, 'utf8')).toContain(world.token)
    world.metadata[0].local_use_allowed = false; await service.sync(); await sleep()
    expect(existsSync(p.path!)).toBe(false)
    expect(service.attachments(a.id)[0].state).toBe('local_use_not_allowed')
    expect([...world.rows.values()].every(r => !r.payload_enc)).toBe(true)
  })
  it('isolates account caches and restores stable attachment intent after profile recreation', async () => {
    const a = addAgent('kit'); world.metadata = [metadata()]; await login('account-a')
    await service.setAttachments(a.id, 'cloud', ['cloud-fixture']); const p = await prepare(a.id)
    await login('account-b'); expect(existsSync(p.path!)).toBe(false); expect(service.attachments(a.id)).toEqual([])
    expect([...world.rows.values()].filter(r => r.cloud_id === 'cloud-fixture')).toHaveLength(2)
    service.clearProfile('account-a'); await login('new-account-a')
    expect(service.attachments(a.id)[0].ref).toBe('cloud-fixture'); expect((await prepare(a.id)).generation).toBe(p.generation)
  })
  it('defers background revocation during a turn and cleans on release', async () => {
    const a = addAgent('bare'); world.metadata = [metadata()]; await login('account-a')
    await service.setAttachments(a.id, 'cloud', ['cloud-fixture']); const p = await prepare(a.id)
    const lock = turnLock.acquire(a.id, 'turn'); world.metadata = []; await service.sync()
    expect(existsSync(p.path!)).toBe(true)
    lock.release(); await sleep(); expect(existsSync(p.path!)).toBe(false)
    expect(service.attachments(a.id)[0].state).toBe('missing')
  })
  it('never prunes on malformed lists; retires awaited responses on account switch', async () => {
    world.metadata = [metadata()]; await login('account-a')
    world.list.mockResolvedValueOnce({ invalid: [] }); await service.sync(); expect(service.list()).toHaveLength(1)
    let finish!: (v: unknown) => void
    world.list.mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
    const pending = service.sync(); await sleep(); world.user = 'account-b'; await service.activate('account-b')
    finish({ items: [] }); await pending; await service.sync()
    expect([...world.rows.values()].filter(r => r.user_id === 'account-a')).toHaveLength(1)
  })
  it('refuses authored files and tracked credential destinations', async () => {
    const a = addAgent('kit'); mkdirSync(join(a.path, 'credentials')); writeFileSync(join(a.path, 'credentials/credentials.json'), '[]')
    execFileSync('git', ['init', '-q', a.path]); execFileSync('git', ['-C', a.path, 'add', 'credentials/credentials.json'])
    const c = service.save({ name: 'x', type: 'api_token', values: { api_token: 'fixture-secret' } }); await sleep()
    await expect(service.setAttachments(a.id, 'local', [c.id])).rejects.toThrow('untracked')
    expect(readFileSync(join(a.path, 'credentials/credentials.json'), 'utf8')).toBe('[]')
  })
})

it('bounds offline shared cache lifetime and ignores suspended HTTP responses', async () => {
  const a = addAgent('bare'); world.metadata = [metadata()]; await login('account-a')
  await service.setAttachments(a.id, 'cloud', ['cloud-fixture']); const p = await prepare(a.id)
  world.fetch.mockRejectedValue(new Error('offline'))
  const row = [...world.rows.values()][0]
  row.payload_fetched_at = Date.now() - 6 * 86400_000
  expect((await prepare(a.id)).path).toBe(p.path)
  row.payload_fetched_at = Date.now() - 8 * 86400_000
  expect((await prepare(a.id)).path).toBeUndefined()
  expect(existsSync(p.path!)).toBe(false)
  let finish!: (v: unknown) => void
  world.list.mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
  const pending = service.sync(); await sleep(); service.setSuspended(true)
  finish({ items: [] }); await pending
  expect(service.list()).toHaveLength(1)
  service.setSuspended(false); await sleep()
})

it('isolates old-account cleanup failures to the affected agent', async () => {
  const a = addAgent('bare'); world.metadata = [metadata()]; await login('account-a')
  await service.setAttachments(a.id, 'cloud', ['cloud-fixture']); const p = await prepare(a.id)
  const { unlinkSync, symlinkSync } = await import('node:fs')
  unlinkSync(p.path!); symlinkSync(join(world.home, 'authored.json'), p.path!)
  writeFileSync(join(world.home, 'authored.json'), 'authored')
  world.user = 'account-b'
  const healthy = addAgent('kit')
  await expect(service.activate('account-b')).resolves.toBeUndefined()
  await expect(prepare(healthy.id)).resolves.toMatchObject({ generation: 'empty' })
  await expect(prepare(a.id)).rejects.toThrow('link')
  expect(readFileSync(join(world.home, 'authored.json'), 'utf8')).toBe('authored')
})

it('collects orphan bare secrets after scanning a moved folder and retains unknown files', async () => {
  const a = addAgent('bare')
  const c = service.save({ name: 'x', type: 'api_token', values: { api_token: 'fixture-secret' } }); await sleep()
  await service.setAttachments(a.id, 'local', [c.id]); const p = await prepare(a.id)
  const { renameSync } = await import('node:fs')
  const { dirname } = await import('node:path')
  const authored = join(dirname(p.path!), 'user-note.txt'); writeFileSync(authored, 'keep')
  renameSync(a.path, a.path + '-moved'); a.path += '-moved'
  await service.activate('__default__')
  expect(existsSync(p.path!)).toBe(false)
  expect(readFileSync(authored, 'utf8')).toBe('keep')
  expect(service.attachments(a.id)).toEqual([])
})


it('keeps an empty runtime stable across suspend, resume, re-auth and account changes', async () => {
  const a = addAgent('kit'); await login('account-a')
  const initial = await prepare(a.id)
  service.setSuspended(true); service.setSuspended(false)
  expect((await prepare(a.id)).generation).toBe(initial.generation)
  await login('account-a')
  expect((await prepare(a.id)).generation).toBe(initial.generation)
  await login('account-b')
  expect((await prepare(a.id)).generation).toBe(initial.generation)
})

it('queues detachment until the running turn releases its credentials', async () => {
  const a = addAgent('bare')
  const c = service.save({ name: 'Token', type: 'api_token', values: { api_token: 'fixture-detach-secret' } }); await sleep()
  await service.setAttachments(a.id, 'local', [c.id]); const p = await prepare(a.id)
  const lock = turnLock.acquire(a.id, 'running-turn')
  let finished = false
  const detach = service.setAttachments(a.id, 'local', []).then(() => { finished = true })
  await sleep()
  expect(finished).toBe(false); expect(existsSync(p.path!)).toBe(true)
  expect(service.attachments(a.id)).toHaveLength(1)
  lock.release(); await detach
  expect(existsSync(p.path!)).toBe(false); expect(service.attachments(a.id)).toEqual([])
})

it('rejects a queued attachment change if the account changes while waiting', async () => {
  const a = addAgent('bare'); await login('account-a')
  const lock = turnLock.acquire(a.id, 'running-turn')
  const change = service.setAttachments(a.id, 'cloud', [])
  const rejected = expect(change).rejects.toThrow('account changed')
  await login('account-b'); lock.release(); await rejected
})

it('restores cached cloud attachments at offline startup and recovers when the network returns', async () => {
  const a = addAgent('bare'); world.metadata = [metadata()]; await login('account-a')
  await service.setAttachments(a.id, 'cloud', ['cloud-fixture']); const p = await prepare(a.id)
  world.list.mockRejectedValue(new Error('offline')); world.fetch.mockRejectedValue(new Error('offline'))
  await service.activate('account-a'); await service.sync()
  expect(service.attachments(a.id)[0].state).toBe('ready')
  expect((await prepare(a.id)).path).toBe(p.path)
  world.list.mockResolvedValue({ items: world.metadata })
  await service.sync(); expect(service.status().error).toBeNull()
})

it('retries permission refusals on the next scheduled poll, but stops after a real authentication failure', async () => {
  const a = addAgent('bare'); world.metadata = [metadata()]; await login('account-a')
  await service.setAttachments(a.id, 'cloud', ['cloud-fixture'])
  world.rows.forEach(r => { r.payload_fetched_at = null })
  world.fetch.mockRejectedValue(Object.assign(new Error('Forbidden'), { code: 'reauth_required', status: 403 }))
  await sleep()
  vi.useFakeTimers()
  try {
    await service.activate('account-a'); await service.sync()
    expect(service.status().error).toBe('permission_denied')
    world.fetch.mockResolvedValue({ items: [], refused: [{ id: 'cloud-fixture', reason: 'no_access' }], current_user: null, owner_identity: null })
    const calls = world.list.mock.calls.length
    await vi.advanceTimersByTimeAsync(300_001)
    expect(world.list.mock.calls.length).toBeGreaterThan(calls)
    expect(service.status().error).toBeNull()
    world.list.mockRejectedValue(Object.assign(new Error('Unauthorized'), { code: 'reauth_required', status: 401 }))
    await service.sync()
    const stoppedAt = world.list.mock.calls.length
    await vi.advanceTimersByTimeAsync(600_001)
    expect(world.list).toHaveBeenCalledTimes(stoppedAt)
    expect(service.status().error).toBe('reauth_required')
  } finally { vi.useRealTimers() }
})

it('isolates undecryptable bundles and restarts an attached runtime only when values change', async () => {
  const broken = addAgent('bare'), healthy = addAgent('kit')
  const bad = service.save({ name: 'Bad', type: 'api_token', values: { api_token: 'fixture-bad-secret' } })
  const good = service.save({ name: 'Good', type: 'api_token', values: { api_token: 'fixture-good-secret' } }); await sleep()
  await service.setAttachments(broken.id, 'local', [bad.id])
  await service.setAttachments(healthy.id, 'local', [good.id])
  const initial = await prepare(healthy.id)
  world.rows.get(bad.id).payload_enc = Buffer.from('invalid-encrypted-data')
  await expect(service.activate('__default__')).resolves.toBeUndefined()
  await expect(prepare(broken.id)).rejects.toThrow('decrypted')
  expect((await prepare(healthy.id)).generation).toBe(initial.generation)
  service.setSuspended(true); service.setSuspended(false)
  expect((await prepare(healthy.id)).generation).toBe(initial.generation)
  service.save({ id: good.id, name: 'Good', type: 'api_token', values: { api_token: 'fixture-rotated-secret' } })
  expect((await prepare(healthy.id)).generation).not.toBe(initial.generation)
})

it('does not wait for stalled cloud requests during activation', async () => {
  world.user = 'account-a'
  let finish!: (response: unknown) => void
  world.list.mockImplementation(() => new Promise(resolve => { finish = resolve }))
  await service.activate('account-a')
  expect(world.list).toHaveBeenCalled()
  world.list.mockResolvedValue({ items: [] })
  finish({ items: [] })
  await service.sync()
})

it('pins manual sync to its profile and does not join a stalled previous profile', async () => {
  world.metadata = [metadata()]; await login('account-a')
  let finish!: (response: unknown) => void
  world.list.mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
  const old = service.sync('account-a')
  const oldSignal = world.list.mock.calls.at(-1)![1] as AbortSignal
  world.user = 'account-b'
  await service.activate('account-b')
  expect(oldSignal.aborted).toBe(true)
  const since = world.list.mock.calls.length
  await service.sync('account-b')
  expect(service.status().error).toBeNull()
  expect(world.list.mock.calls.slice(since).every(([id]) => id === 'account-b')).toBe(true)
  const count = world.list.mock.calls.length
  await expect(service.sync('account-a')).rejects.toThrow('active profile changed')
  expect(world.list).toHaveBeenCalledTimes(count)
  finish({ items: [] }); await old
  expect(world.list).toHaveBeenCalledTimes(count)
  expect(service.list().some(c => c.cloudId === 'cloud-fixture')).toBe(true)
})

it.each([[404, 'not_supported'], [405, 'not_supported'], [500, 'server_error']])('distinguishes HTTP %s from offline failures', async (status, error) => {
  await login('account-a')
  world.list.mockRejectedValue(Object.assign(new Error('request failed'), { status }))
  await service.sync('account-a')
  expect(service.status().error).toBe(error)
})

it('updates and clears Service URI without replacing stored token values', async () => {
  const a = addAgent('bare')
  const c = service.save({ name: 'Token', type: 'api_token', serviceUri: 'old-service', values: { api_token: 'fixture-preserved-token' } })
  await service.setAttachments(a.id, 'local', [c.id])
  for (const serviceUri of ['new-service', '']) {
    service.save({ id: c.id, name: 'Token', type: 'api_token', serviceUri })
    const p = await prepare(a.id)
    const [entry] = JSON.parse(readFileSync(p.path!, 'utf8'))
    expect(entry.service_uri).toBe(serviceUri || null)
    expect(entry.credential_data.service_uri).toBe(serviceUri || undefined)
    expect(entry.credential_data.http_header_value).toBe('Bearer fixture-preserved-token')
  }
})

it('rejects list and sync requests for another profile or a changed server before HTTP', async () => {
  await login('local-core')
  world.list.mockClear()
  expect(service.snapshot('local-core', 'http://localhost:8000').error).toBeNull()
  expect(() => service.snapshot('demo', 'https://demo.example.test')).toThrow('active profile changed')
  expect(() => service.snapshot('local-core', 'https://demo.example.test')).toThrow('active profile changed')
  await expect(service.sync('demo', 'https://demo.example.test')).rejects.toThrow('active profile changed')
  await expect(service.sync('local-core', 'https://demo.example.test')).rejects.toThrow('active profile changed')
  expect(world.list).not.toHaveBeenCalled()
  await service.sync('local-core', 'http://localhost:8000')
  expect(world.list).toHaveBeenCalledWith('local-core', expect.any(AbortSignal))
})
