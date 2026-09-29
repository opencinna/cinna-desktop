import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, statSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import type { ServiceCredentialRow } from '../../db/serviceCredentials'
const world = vi.hoisted(() => ({ user: '__default__', home: '', secure: true, agents: [] as any[], rows: new Map<string, any>(), metadata: [] as any[], byUser: {} as Record<string, any[]>, identity: false, users: new Map<string, any>(), unlocked: new Set<string>(), token: 'fixture-cloud-token-123', allowed: true, fetch: vi.fn(), list: vi.fn() }))
vi.mock('../../host/runtimeHost', () => ({ runtimeHost: { getPath: () => world.home, keystore: {
  isEncryptionAvailable: () => true,
  isSecureStorageAvailable: () => world.secure,
  encryptString: (s: string) => Buffer.from([...Buffer.from(s)].map(b => b ^ 0x93)),
  decryptString: (b: Buffer) => Buffer.from([...b].map(v => v ^ 0x93)).toString()
} } }))
vi.mock('../../host/events', () => ({ publishEvent: vi.fn() }))
vi.mock('../../auth/scope', () => ({ getProfileScopeUserId: () => world.user }))
vi.mock('../../auth/cinna-tokens', () => ({ getStoredCinnaSubject: (id: string) => id.replace('new-', '') }))
vi.mock('../../db/users', () => ({ userRepo: { get: (id: string) => world.users.get(id) ?? ({ id, type: id === '__default__' ? 'local_user' : 'cinna_user', cinnaServerUrl: 'http://localhost:8000', displayName: id, username: id, passwordHash: null }), list: () => [...world.users.values()] } }))
vi.mock('../../db/serviceCredentials', () => ({ credentialDto: (r: ServiceCredentialRow) => ({ ...JSON.parse(r.metadata), id: r.id, origin: r.origin, cloudId: r.cloud_id, hasValues: !!r.payload_enc, expiresAt: r.expires_at }), serviceCredentialRepo: {
  list: (id: string) => [...world.rows.values()].filter(r => r.user_id === id), get: (id: string) => world.rows.get(id), put: (r: any) => world.rows.set(r.id, r), remove: (id: string) => world.rows.delete(id), clearProfile: (id: string) => { for (const [key, row] of world.rows) if (row.user_id === id && row.origin === 'cloud') world.rows.delete(key) }
} }))
vi.mock('../localAgents/localAgentService', () => ({ localAgentService: { list: () => ({ agents: world.agents }), get: (_: string, id: string) => { const a = world.agents.find(a => a.id === id); if (!a) throw new Error('Agent missing'); return a } } }))
vi.mock('../localAgents/scannerService', () => ({ markAllRootsDirty() {} }))
vi.mock('../../shell/env', () => ({ getShellEnv: async () => process.env, usableTool: async (bin: string) => bin }))
vi.mock('./cloud', () => ({ serviceCredentialCloud: { list: (...args: unknown[]) => world.list(...args), materialize: (...args: unknown[]) => world.fetch(...args) } }))
import { serviceCredentialService as service } from './service'
import { turnLock } from '../localAgents/turnLock'
import { clearCredentialRedaction, redactCredentialText } from '../../security/serviceCredentialRedaction'
const sleep = () => new Promise(resolve => setTimeout(resolve, 30))
beforeEach(async () => {
  world.home = mkdtempSync(join(tmpdir(), 'cinna-credentials-')); world.user = '__default__'; world.rows.clear(); world.secure = true; world.agents = []; world.metadata = []; world.byUser = {}; world.identity = false; world.users.clear(); world.unlocked.clear(); world.allowed = true
  world.list.mockImplementation(async (user: string) => ({ items: world.byUser[user] ?? world.metadata }))
  world.fetch.mockImplementation(async (user: string, ids: string[]) => ({ items: world.allowed ? ids.map(id => ({ id, revision: 'r1', entry: { id, name: 'Cloud', type: 'api_token', notes: null, service_uri: 'api', is_placeholder: false, credential_data: { http_header_name: 'Authorization', http_header_value: `Bearer ${world.token}` } }, service_account_file: null, ssh_key: null })) : [], refused: world.allowed ? [] : ids.map(id => ({ id, reason: 'no_access' })),
    current_user: world.identity ? { id: 'current_user', name: user, type: 'current_user', notes: null, service_uri: null, is_placeholder: false, credential_data: { email: `${user}@example.test` } } : null, owner_identity: null }))
  service.installUnlockCheck(id => world.unlocked.has(id))
  await service.activate('__default__')
})
afterEach(async () => { service.retire(); world.agents = []; turnLock.releaseAll(); await sleep(); rmSync(world.home, { recursive: true, force: true }); clearCredentialRedaction() })
function addAgent(kind: 'kit' | 'bare') {
  const path = join(world.home, kind); mkdirSync(path)
  const a = { id: `folder:${kind}`, kind, path }; world.agents.push(a); return a
}
/** A Cinna profile row; `login` registers one on demand. */
function register(id: string, extra: Record<string, unknown> = {}) {
  if (!world.users.has(id)) world.users.set(id, { id, type: 'cinna_user', cinnaServerUrl: 'http://localhost:8000', displayName: id, username: id, passwordHash: null, ...extra })
  return world.users.get(id)
}
/** The account key the service derives: sha256(origin + "\n" + jwt.sub)[:16]. */
function key(id: string) { return createHash('sha256').update('http://localhost:8000\n' + id.replace('new-', '')).digest('hex').slice(0, 16) }
function metadata() { return { id: 'cloud-fixture', name: 'Cloud', type: 'api_token', notes: null, service_uri: 'api', status: 'complete', is_placeholder: false, relation: 'shared', owner_email: 'owner@example.test', local_use_allowed: true, revision: 'r1' } }
async function login(user: string) { register(user); world.user = user; await service.activate(user); await service.sync(); await sleep() }
async function prepare(id: string) { return turnLock.withQueuedLock(id, 'test-turn', new AbortController().signal, () => service.prepare(id)) }
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
    await service.setAttachments(a.id, key('account-a'), ['cloud-fixture']); const p = await prepare(a.id)
    expect(readFileSync(p.path!, 'utf8')).toContain(world.token)
    world.metadata[0].local_use_allowed = false; await service.sync(); await sleep()
    expect(existsSync(p.path!)).toBe(false)
    expect(service.attachments(a.id)[0].state).toBe('local_use_not_allowed')
    expect([...world.rows.values()].every(r => !r.payload_enc)).toBe(true)
  })
  it('keeps delivering across profile switches and restores stable attachment intent after profile recreation', async () => {
    const a = addAgent('kit'); world.metadata = [metadata()]; await login('account-a')
    await service.setAttachments(a.id, key('account-a'), ['cloud-fixture']); const p = await prepare(a.id)
    const bytes = readFileSync(p.path!, 'utf8'), modified = statSync(p.path!).mtimeMs
    await login('account-b')
    expect(readFileSync(p.path!, 'utf8')).toBe(bytes); expect(statSync(p.path!).mtimeMs).toBe(modified)
    expect((await prepare(a.id)).generation).toBe(p.generation)
    expect(service.attachments(a.id)).toMatchObject([{ ref: 'cloud-fixture', group: key('account-a'), groupLabel: 'account-a', state: 'ready', serverUrl: 'http://localhost:8000', account: { name: 'account-a', email: 'account-a' } }])
    expect([...world.rows.values()].filter(r => r.cloud_id === 'cloud-fixture')).toHaveLength(2)
    service.signOut('account-a'); world.users.delete('account-a'); await sleep()
    expect(existsSync(p.path!)).toBe(false)
    expect(service.attachments(a.id)).toMatchObject([{ ref: 'cloud-fixture', groupLabel: 'Signed-out account', state: 'account_unavailable', credential: null, serverUrl: null, account: null }])
    await login('new-account-a')
    expect(service.attachments(a.id)[0]).toMatchObject({ ref: 'cloud-fixture', group: key('account-a'), state: 'ready' }); expect((await prepare(a.id)).generation).toBe(p.generation)
  })
  it('defers background revocation during a turn and cleans on release', async () => {
    const a = addAgent('bare'); world.metadata = [metadata()]; await login('account-a')
    await service.setAttachments(a.id, key('account-a'), ['cloud-fixture']); const p = await prepare(a.id)
    const lock = turnLock.acquire(a.id, 'turn'); world.metadata = []; await service.sync()
    expect(existsSync(p.path!)).toBe(true)
    lock.release(); await sleep(); expect(existsSync(p.path!)).toBe(false)
    expect(service.attachments(a.id)[0].state).toBe('missing')
  })
  it('never prunes on malformed lists; discards a list for an account locked while it was in flight', async () => {
    register('account-a', { passwordHash: 'hash' }); world.unlocked.add('account-a')
    world.metadata = [metadata()]; await login('account-a')
    world.list.mockResolvedValueOnce({ invalid: [] }); await service.sync(); expect(service.list()).toHaveLength(1)
    world.user = 'account-b'; register('account-b'); await service.activate('account-b')
    let finish!: (v: unknown) => void
    world.list.mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
    service.renewed('account-a'); await sleep()
    const signal = world.list.mock.calls.at(-1)![1] as AbortSignal
    expect(world.list.mock.calls.at(-1)![0]).toBe('account-a')
    world.unlocked.clear(); service.refreshAccounts()
    expect(signal.aborted).toBe(true)
    finish({ items: [] }); await sleep()
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
  await service.setAttachments(a.id, key('account-a'), ['cloud-fixture']); const p = await prepare(a.id)
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
  await service.setAttachments(a.id, key('account-a'), ['cloud-fixture']); const p = await prepare(a.id)
  const { unlinkSync, symlinkSync } = await import('node:fs')
  unlinkSync(p.path!); symlinkSync(join(world.home, 'authored.json'), p.path!)
  writeFileSync(join(world.home, 'authored.json'), 'authored')
  const healthy = addAgent('kit')
  // Logout makes the account ineligible; its cleanup fails only for the linked agent.
  expect(() => service.signOut('account-a')).not.toThrow(); await sleep()
  expect(service.status().error).toBe('cleanup_failed')
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

it('rejects a queued attachment change if its account becomes ineligible while waiting, not on a profile switch', async () => {
  const a = addAgent('bare'); await login('account-a')
  const lock = turnLock.acquire(a.id, 'running-turn')
  const kept = service.setAttachments(a.id, key('account-a'), [])
  await login('account-b'); lock.release(); await expect(kept).resolves.toEqual([])
  const again = turnLock.acquire(a.id, 'running-turn')
  const change = service.setAttachments(a.id, key('account-a'), [])
  const rejected = expect(change).rejects.toThrow('account changed')
  service.signOut('account-a'); again.release(); await rejected
  // Signed out: its list may only shrink, so adding a reference is refused.
  await expect(service.setAttachments(a.id, key('account-a'), ['cloud-fixture'])).rejects.toThrow('Sign in')
  await expect(service.setAttachments(a.id, 'cloud', [])).rejects.toThrow('Sign in')
})

it('restores cached cloud attachments at offline startup and recovers when the network returns', async () => {
  const a = addAgent('bare'); world.metadata = [metadata()]; await login('account-a')
  await service.setAttachments(a.id, key('account-a'), ['cloud-fixture']); const p = await prepare(a.id)
  world.list.mockRejectedValue(new Error('offline')); world.fetch.mockRejectedValue(new Error('offline'))
  service.retire(); await service.activate('account-a'); await service.sync()
  expect(service.attachments(a.id)[0].state).toBe('ready')
  expect((await prepare(a.id)).path).toBe(p.path)
  world.list.mockResolvedValue({ items: world.metadata })
  await service.sync(); expect(service.status().error).toBeNull()
})

it('retries permission refusals on the next scheduled poll, but stops after a real authentication failure', async () => {
  const a = addAgent('bare'); world.metadata = [metadata()]; await login('account-a')
  await service.setAttachments(a.id, key('account-a'), ['cloud-fixture'])
  world.rows.forEach(r => { r.payload_fetched_at = null })
  world.fetch.mockRejectedValue(Object.assign(new Error('Forbidden'), { code: 'reauth_required', status: 403 }))
  await sleep()
  vi.useFakeTimers()
  try {
    // A fresh start, so the account's poll timer is created under fake timers.
    service.retire(); await service.activate('account-a'); await service.sync()
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
  world.user = 'account-a'; register('account-a')
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
  world.user = 'account-b'; register('account-b')
  await service.activate('account-b'); await sleep()
  const since = world.list.mock.calls.length
  await service.sync('account-b')
  expect(service.status().error).toBeNull()
  expect(world.list.mock.calls.slice(since).every(([id]) => id === 'account-b')).toBe(true)
  const count = world.list.mock.calls.length
  await expect(service.sync('account-a')).rejects.toThrow('active profile changed')
  expect(world.list).toHaveBeenCalledTimes(count)
  // A profile switch no longer retires account-a: its own pending sync still completes for it.
  finish({ items: [] }); await old
  expect(world.list).toHaveBeenCalledTimes(count)
  expect([...world.rows.values()].some(r => r.user_id === 'account-a')).toBe(false)
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

describe('multiple eligible accounts', () => {
  const read = (path: string) => JSON.parse(readFileSync(path, 'utf8')) as { id: string; type: string }[]
  function cloud(id: string) { return { ...metadata(), id } }
  it('delivers every eligible account to one agent, with current_user only while a single account contributes', async () => {
    const a = addAgent('kit'); world.identity = true
    world.byUser = { 'account-a': [cloud('cred-a')], 'account-b': [cloud('cred-b'), { ...cloud('cred-off'), local_use_allowed: false }] }
    register('account-a', { displayName: 'Beta' }); register('account-b', { displayName: 'Alpha' })
    const local = service.save({ name: 'Local', type: 'api_token', serviceUri: 'local', values: { api_token: 'local-fixture-secret-9' } })
    await login('account-a'); await login('account-b')
    await service.setAttachments(a.id, 'local', [local.id])
    await service.setAttachments(a.id, key('account-a'), ['cred-a'])
    await service.setAttachments(a.id, key('account-b'), ['cred-b'])
    const p = await prepare(a.id)
    // Local first, then accounts by profile name (Alpha = account-b before Beta = account-a).
    // Core gives every current_user entry the same id, so two contributing accounts write none.
    expect(read(p.path!).map(e => e.id)).toEqual([local.id, 'cred-b', 'cred-a'])
    expect(service.attachments(a.id).map(v => [v.groupLabel, v.state, v.serverUrl])).toEqual([['This computer', 'ready', null], ['Alpha', 'ready', 'http://localhost:8000'], ['Beta', 'ready', 'http://localhost:8000']])
    expect(service.attachOptions(a.id).groups.map(g => [g.label, g.detail, g.items.map(i => [i.cloudId ?? i.name, i.attached])])).toEqual([
      ['This computer', '', [['Local', true]]], ['Alpha', 'localhost:8000', [['cred-b', true]]], ['Beta', 'localhost:8000', [['cred-a', true]]]])
    // Switching the current profile does not change delivered files.
    const bytes = readFileSync(p.path!, 'utf8'), modified = statSync(p.path!).mtimeMs
    world.user = '__default__'; await service.activate('__default__'); await sleep()
    expect(readFileSync(p.path!, 'utf8')).toBe(bytes); expect(statSync(p.path!).mtimeMs).toBe(modified)
    expect((await prepare(a.id)).generation).toBe(p.generation)
    // Down to one contributing account: its current_user is written again.
    await service.setAttachments(a.id, key('account-a'), [])
    const single = read((await prepare(a.id)).path!) as unknown as { id: string; credential_data?: { email?: string } }[]
    expect(single.map(e => e.id)).toEqual([local.id, 'cred-b', 'current_user'])
    expect(single[2].credential_data?.email).toBe('account-b@example.test')
  })
  it('syncs a renewed account once, whether it just became eligible or was already', async () => {
    register('account-r'); world.list.mockClear()
    service.renewed('account-r'); await sleep()
    expect(world.list.mock.calls.filter(([user]) => user === 'account-r')).toHaveLength(1)
    world.list.mockClear(); service.renewed('account-r'); await sleep()
    expect(world.list.mock.calls.filter(([user]) => user === 'account-r')).toHaveLength(1)
  })
  it('writes one Core record attached under two accounts once', async () => {
    const a = addAgent('bare')
    world.byUser = { 'account-a': [cloud('same-record')], 'account-b': [cloud('same-record')] }
    await login('account-a'); await login('account-b')
    await service.setAttachments(a.id, key('account-a'), ['same-record'])
    await service.setAttachments(a.id, key('account-b'), ['same-record'])
    expect(read((await prepare(a.id)).path!).map(e => e.id)).toEqual(['same-record'])
  })
  it('keeps a locked password profile\'s attachments undelivered until it is unlocked', async () => {
    const a = addAgent('bare'); world.metadata = [metadata()]
    register('account-p', { passwordHash: 'hash' }); world.unlocked.add('account-p')
    await login('account-p'); await service.setAttachments(a.id, key('account-p'), ['cloud-fixture'])
    const p = await prepare(a.id); expect(readFileSync(p.path!, 'utf8')).toContain(world.token)
    world.user = '__default__'; await service.activate('__default__')
    world.unlocked.clear(); service.refreshAccounts(); await sleep()
    expect(service.attachments(a.id)).toMatchObject([{ ref: 'cloud-fixture', group: key('account-p'), groupLabel: 'Signed-out account', state: 'account_unavailable', credential: null }])
    expect(service.attachOptions(a.id).groups.map(g => g.key)).toEqual(['local'])
    expect(existsSync(p.path!)).toBe(false); expect((await prepare(a.id)).path).toBeUndefined()
    await expect(service.setAttachments(a.id, key('account-p'), ['cloud-fixture', 'other-ref'])).rejects.toThrow('Sign in')
    world.unlocked.add('account-p'); service.refreshAccounts(); await sleep()
    expect(service.attachments(a.id)[0]).toMatchObject({ groupLabel: 'account-p', state: 'ready' })
    expect(readFileSync((await prepare(a.id)).path!, 'utf8')).toContain(world.token)
  })
  it('prunes a cached, attached record once Core stops listing it for local use', async () => {
    const a = addAgent('bare')
    world.byUser = { 'account-a': [cloud('cloud-fixture'), cloud('cred-other')] }
    await login('account-a')
    await service.setAttachments(a.id, key('account-a'), ['cloud-fixture']); expect(readFileSync((await prepare(a.id)).path!, 'utf8')).toContain(world.token)
    world.byUser['account-a'] = [cloud('cred-other')]; await service.sync(); await sleep()
    expect(service.attachments(a.id)[0]).toMatchObject({ ref: 'cloud-fixture', state: 'missing', credential: null })
    expect(service.attachOptions(a.id).groups[1].items.map(i => i.cloudId)).toEqual(['cred-other'])
    expect((await prepare(a.id)).path).toBeUndefined()
  })
  it('lets a signed-out account\'s attachment be detached, and keeps it detached when the account returns', async () => {
    const a = addAgent('bare'); world.metadata = [metadata()]; await login('account-a')
    await service.setAttachments(a.id, key('account-a'), ['cloud-fixture'])
    world.user = '__default__'; service.signOut('account-a'); await service.activate('__default__'); await sleep()
    await expect(service.setAttachments(a.id, 'not-an-account', [])).rejects.toThrow('Sign in')
    expect(await service.setAttachments(a.id, key('account-a'), [])).toEqual([])
    await login('account-a')
    expect(service.attachments(a.id)).toEqual([]); expect((await prepare(a.id)).path).toBeUndefined()
  })
  it('makes a logged-out account ineligible until that profile is activated again', async () => {
    const a = addAgent('bare'); world.metadata = [metadata()]; await login('account-a')
    await service.setAttachments(a.id, key('account-a'), ['cloud-fixture']); const p = await prepare(a.id)
    world.user = '__default__'; service.signOut('account-a'); await service.activate('__default__'); await sleep()
    expect(existsSync(p.path!)).toBe(false)
    expect(service.attachments(a.id)[0].state).toBe('account_unavailable')
    service.refreshAccounts(); expect(service.attachments(a.id)[0].state).toBe('account_unavailable')
    await login('account-a')
    expect(service.attachments(a.id)[0].state).toBe('ready'); expect((await prepare(a.id)).path).toBe(p.path)
  })
  it('discards a delivery for an account made ineligible mid-flight', async () => {
    const a = addAgent('bare'); world.metadata = [metadata()]
    register('account-p', { passwordHash: 'hash' }); world.unlocked.add('account-p'); await login('account-p')
    await service.setAttachments(a.id, key('account-p'), ['cloud-fixture'])
    world.user = '__default__'; await service.activate('__default__')
    world.rows.forEach(r => { r.payload_enc = null; r.payload_fetched_at = null })
    let finish!: (v: unknown) => void
    const original = world.fetch.getMockImplementation()!
    world.fetch.mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
    const turn = prepare(a.id); await sleep()
    const signal = world.fetch.mock.calls.at(-1)![2] as AbortSignal
    world.unlocked.clear(); service.refreshAccounts()
    expect(signal.aborted).toBe(true)
    finish(await original('account-p', ['cloud-fixture']))
    await expect(turn).rejects.toThrow('account changed')
    expect([...world.rows.values()].every(r => !r.payload_enc)).toBe(true)
    await sleep()
    expect(service.attachments(a.id)[0].state).toBe('account_unavailable')
  })
})
