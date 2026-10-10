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
vi.mock('../../db/serviceCredentials', () => ({ credentialDto: (r: ServiceCredentialRow) => { const { keyStub: _stub, ...m } = JSON.parse(r.metadata); return { ...m, keyStatus: m.keyStatus ?? null, agentApi: m.agentApi ?? null, keyBlocked: m.keyBlocked ?? null, id: r.id, origin: r.origin, cloudId: r.cloud_id, hasValues: !!r.payload_enc, expiresAt: r.expires_at } }, serviceCredentialRepo: {
  list: (id: string) => [...world.rows.values()].filter(r => r.user_id === id), get: (id: string) => world.rows.get(id), put: (r: any) => world.rows.set(r.id, r), remove: (id: string) => world.rows.delete(id), clearProfile: (id: string) => { for (const [key, row] of world.rows) if (row.user_id === id && row.origin === 'cloud') world.rows.delete(key) }
} }))
vi.mock('../localAgents/localAgentService', () => ({ localAgentService: { list: () => ({ agents: world.agents }), get: (_: string, id: string) => { const a = world.agents.find(a => a.id === id); if (!a) throw new Error('Agent missing'); return a } } }))
vi.mock('../localAgents/scannerService', () => ({ markAllRootsDirty() {} }))
vi.mock('../../shell/env', () => ({ getShellEnv: async () => process.env, usableTool: async (bin: string) => bin }))
vi.mock('./cloud', () => ({ serviceCredentialCloud: { list: (...args: unknown[]) => world.list(...args), materialize: (...args: unknown[]) => world.fetch(...args) } }))
import { keyApiUrl, serviceCredentialService as service } from './service'
import { turnLock } from '../localAgents/turnLock'
import { clearCredentialRedaction, redactCredentialText } from '../../security/serviceCredentialRedaction'
import { getLogEntries } from '../../logger/logger'
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
/** As a turn prepares: under a shared hold, so turns of one agent may prepare side by side. */
async function prepare(id: string) { return turnLock.withQueuedSharedLock(id, 'test-turn', new AbortController().signal, () => service.prepare(id)) }
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
    const helper = join(process.cwd(), 'resources/cinna-agent-kit/templates/agent/scripts')
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

it('regenerates after a turn that was queued first, instead of failing the regeneration', async () => {
  const a = addAgent('bare')
  const c = service.save({ name: 'Token', type: 'api_token', values: { api_token: 'fixture-queued-secret' } }); await sleep()
  await service.setAttachments(a.id, 'local', [c.id]); await prepare(a.id)
  const editor = turnLock.acquire(a.id, 'editor')
  // A turn queued behind the editor, before the regeneration is.
  let finishTurn!: () => void
  const turn = turnLock.withQueuedSharedLock(a.id, 'queued-turn', new AbortController().signal, () => new Promise<void>((resolve) => { finishTurn = resolve }))
  service.save({ name: 'Other', type: 'api_token', values: { api_token: 'fixture-other-secret' } })
  editor.release(); await sleep()
  // The turn won the release; the regeneration waits for it rather than failing.
  expect(turnLock.isLocked(a.id)).toBe(true)
  expect(service.status().error).toBeNull()
  finishTurn(); await turn; await sleep()
  expect(service.status().error).toBeNull()
  expect(turnLock.isLocked(a.id)).toBe(false)
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

it('serializes concurrent preparations of one agent, so neither acts on a stale read', async () => {
  const a = addAgent('kit'); world.metadata = [metadata()]; await login('account-a')
  await service.setAttachments(a.id, key('account-a'), ['cloud-fixture'])
  // Stale cache: each preparation that reads it before the other has written refetches.
  for (const row of world.rows.values()) if (row.cloud_id === 'cloud-fixture') row.payload_fetched_at = 0
  let inFlight = 0, peak = 0
  const deliver = world.fetch.getMockImplementation()!
  world.fetch.mockImplementation(async (...args: unknown[]) => {
    inFlight++; peak = Math.max(peak, inFlight)
    try { await sleep(); return await deliver(...args) } finally { inFlight-- }
  })
  world.fetch.mockClear()
  const [one, two] = await Promise.all([prepare(a.id), prepare(a.id)])
  expect(peak).toBe(1)
  expect(world.fetch).toHaveBeenCalledTimes(1)
  expect(two.generation).toBe(one.generation)
  expect(readFileSync(one.path!, 'utf8')).toContain(world.token)
})

describe('issued Agent API keys', () => {
  const base = 'http://localhost:8000/api/v1/agent-api/prod-1'
  const keys = { token: 'issued-key-token-AAA111', refuse: null as null | { reason: string; key_status?: string } }
  function key(id = 'key-1', extra: Record<string, unknown> = {}) {
    return { id, name: 'CRM API', type: 'agent_api', notes: null, service_uri: 'crm-api', status: 'complete', is_placeholder: false, relation: 'owned', owner_email: null,
      local_use_allowed: true, revision: 'k1', key_status: 'active', expires_at: null,
      agent_api: { producer_agent_id: 'prod-1', producer_name: 'CRM', issuer_email: 'ana@example.test', base_url: base, spec_url: `${base}/openapi.json`, expires_at: null }, ...extra }
  }
  const delivered = (id: string, meta: any) => ({ id, name: meta.name, type: 'agent_api', notes: null, service_uri: meta.service_uri, is_placeholder: false,
    credential_data: { base_url: base, spec_url: `${base}/openapi.json`, token: keys.token, label: 'CRM key', producer_agent_id: 'prod-1' } })
  const listed = (user: string): any[] => world.byUser[user] ?? world.metadata
  const file = (path: string) => JSON.parse(readFileSync(path, 'utf8')) as any[]
  beforeEach(() => {
    keys.token = 'issued-key-token-AAA111'; keys.refuse = null; world.fetch.mockClear(); world.list.mockClear()
    world.fetch.mockImplementation(async (user: string, ids: string[]) => {
      const refused = keys.refuse ? ids.map(id => ({ id, ...keys.refuse })) : []
      const items = keys.refuse ? [] : ids.map(id => {
        const meta = listed(user).find(m => m.id === id)
        const entry = meta.type === 'agent_api' ? delivered(id, meta) : { id, name: meta.name, type: meta.type, notes: null, service_uri: meta.service_uri, is_placeholder: false, credential_data: { http_header_name: 'Authorization', http_header_value: `Bearer ${world.token}` } }
        return { id, revision: meta.revision, entry, service_account_file: null, ssh_key: null }
      })
      return { items, refused, current_user: world.identity ? { id: 'current_user', name: user, type: 'current_user', notes: null, service_uri: null, is_placeholder: false, credential_data: { email: `${user}@example.test` } } : null, owner_identity: null }
    })
  })
  // `key` here shadows the file's account-key helper; this is the account key.
  const account = (id: string) => createHash('sha256').update('http://localhost:8000\n' + id).digest('hex').slice(0, 16)
  async function setup(kind: 'kit' | 'bare' = 'kit', items: any[] = [key()], refs = ['key-1']) {
    world.metadata = items
    const a = addAgent(kind); await login('account-a')
    await service.setAttachments(a.id, account('account-a'), refs)
    return a
  }
  /** Sync, then let the queued regeneration (an exclusive hold) finish. */
  async function relist(items: any[]) {
    world.metadata = items; await service.sync(); await sleep()
    for (let i = 0; i < 100 && world.agents.some(a => turnLock.isExclusivelyLocked(a.id)); i++) await sleep()
  }

  it('writes an active key verbatim, keeps the token out of DTOs, prompt and logs', async () => {
    const a = await setup()
    const p = await prepare(a.id)
    expect(file(p.path!)).toEqual([delivered('key-1', key())])
    expect(p.prompt).toContain('CRM API (agent_api; slot crm-api): ready')
    expect(p.prompt).not.toContain(keys.token)
    expect(redactCredentialText(`calling with ${keys.token}`)).toBe('calling with ***REDACTED***')
    const [dto] = service.attachments(a.id)
    expect(dto.credential).toMatchObject({ keyStatus: 'active', agentApi: { producerName: 'CRM', issuerEmail: 'ana@example.test' }, hasValues: true })
    for (const value of [service.attachments(a.id), service.list(), service.attachOptions(a.id)]) {
      expect(JSON.stringify(value)).not.toContain(keys.token)
      expect(JSON.stringify(value)).not.toContain('base_url')
    }
  })

  it('does not cache an agent_api item that is shared or has no key status, and prunes a cached one that turns so', async () => {
    world.metadata = [key('k-shared', { relation: 'shared' }), key('k-bare', { key_status: undefined }), key('k-null', { key_status: null }), key()]
    await login('account-a')
    expect(service.list().map(c => c.cloudId)).toEqual(['key-1'])
    await relist([key('key-1', { relation: 'shared' })])
    expect(service.list()).toEqual([])
  })

  it('drops the token on revocation without a materialize call and writes a token-less entry', async () => {
    const a = await setup()
    const p = await prepare(a.id)
    world.fetch.mockClear()
    await relist([key('key-1', { revision: 'k2', key_status: 'revoked_by_issuer' })])
    expect(world.fetch).not.toHaveBeenCalled()
    expect([...world.rows.values()].every(r => !r.payload_enc)).toBe(true)
    expect(readFileSync(p.path!, 'utf8')).not.toContain(keys.token)
    expect(file(p.path!)).toEqual([{ id: 'key-1', name: 'CRM API', type: 'agent_api', notes: null, service_uri: 'crm-api', is_placeholder: false,
      unavailable_reason: 'key_revoked', key_status: 'revoked_by_issuer', credential_data: { base_url: base, spec_url: `${base}/openapi.json`, label: 'CRM key', producer_agent_id: 'prod-1' } }])
    expect(service.attachments(a.id)[0]).toMatchObject({ state: 'key_unavailable', credential: { keyStatus: 'revoked_by_issuer', hasValues: false } })
    const again = await prepare(a.id)
    expect(world.fetch).not.toHaveBeenCalled()
    expect(again.prompt).toContain('CRM API (agent_api; slot crm-api): unavailable — revoked by issuer')
    // The helper explains the reason instead of "not configured".
    const helper = join(process.cwd(), 'resources/cinna-agent-kit/templates/agent/scripts')
    const out = execFileSync('python3', ['-c', "from cinna_credentials import require_slot\ntry:\n  require_slot('crm-api')\nexcept Exception as e:\n  print(e)"], { env: { ...process.env, PYTHONPATH: helper, CINNA_CREDENTIALS_PATH: again.path! }, encoding: 'utf8' })
    expect(out).toContain('unavailable')
  })

  it('keeps the delivered stub where the list reports nulls, and uses the list facts before any delivery', async () => {
    const a = await setup()
    const p = await prepare(a.id)
    await relist([key('key-1', { revision: 'k2', key_status: 'producer_removed', agent_api: { producer_agent_id: null, producer_name: 'CRM', issuer_email: 'ana@example.test', base_url: null, spec_url: null, expires_at: null } })])
    expect(file(p.path!)[0]).toMatchObject({ unavailable_reason: 'key_revoked', key_status: 'producer_removed', credential_data: { base_url: base, spec_url: `${base}/openapi.json`, label: 'CRM key', producer_agent_id: 'prod-1' } })
    // Never delivered: list facts only, or nothing.
    const b = addAgent('bare')
    world.metadata = [key('key-1', { revision: 'k2', key_status: 'producer_removed' }), key('key-2', { key_status: 'expired', agent_api: null }), key('key-3', { key_status: 'issuer_removed', service_uri: 'other' })]
    await service.sync(); await sleep()
    await service.setAttachments(b.id, account('account-a'), ['key-2', 'key-3'])
    const entries = file((await prepare(b.id)).path!)
    expect(entries.map(e => [e.id, e.unavailable_reason, e.key_status, e.credential_data])).toEqual([
      ['key-2', 'key_expired', 'expired', {}],
      ['key-3', 'key_revoked', 'issuer_removed', { base_url: base, spec_url: `${base}/openapi.json`, producer_agent_id: 'prod-1' }]])
    expect(JSON.stringify(entries)).not.toContain('token')
  })

  it('pauses fail-closed and recovers with one materialize when the key is active again', async () => {
    const a = await setup()
    const p = await prepare(a.id)
    await relist([key('key-1', { revision: 'k2', key_status: 'external_access_paused' })])
    expect(file(p.path!)[0]).toMatchObject({ unavailable_reason: 'key_paused', key_status: 'external_access_paused' })
    expect(file(p.path!)[0].credential_data.token).toBeUndefined()
    world.fetch.mockClear()
    await relist([key('key-1', { revision: 'k3' })])
    expect(world.fetch).toHaveBeenCalledTimes(1)
    expect(file(p.path!)).toEqual([delivered('key-1', key())])
    await service.sync(); await sleep()
    expect(world.fetch).toHaveBeenCalledTimes(1)
  })

  it('writes a rotated token after one sync and keeps the old one redacted', async () => {
    const a = await setup()
    const p = await prepare(a.id), old = keys.token
    keys.token = 'issued-key-token-BBB222'
    await relist([key('key-1', { revision: 'k2' })])
    expect(readFileSync(p.path!, 'utf8')).toContain('issued-key-token-BBB222')
    expect(readFileSync(p.path!, 'utf8')).not.toContain(old)
    expect(redactCredentialText(`${old} ${keys.token}`)).toBe('***REDACTED*** ***REDACTED***')
  })

  it('takes a key refusal as the key status, not as the owner\'s local-use setting, and stops fetching it for that pass', async () => {
    world.metadata = [key()]
    const a = addAgent('kit'); await login('account-a')
    keys.refuse = { reason: 'key_revoked', key_status: 'revoked_by_issuer' }
    await service.setAttachments(a.id, account('account-a'), ['key-1'])
    const [dto] = service.attachments(a.id)
    expect(dto).toMatchObject({ state: 'key_unavailable', credential: { keyStatus: 'revoked_by_issuer', localUseAllowed: true } })
    // No list in between: a turn start does not ask again.
    world.fetch.mockClear()
    await prepare(a.id)
    expect(world.fetch).not.toHaveBeenCalled()
    // A refusal without a status falls back by reason.
    keys.refuse = { reason: 'key_paused' }
    await relist([key('key-1', { revision: 'k2' })])
    expect(world.fetch).toHaveBeenCalledTimes(1)
    expect(service.attachments(a.id)[0].credential?.keyStatus).toBe('external_access_paused')
  })

  it('lets the list win over a refusal on the next pass, even at the same revision (pause then resume)', async () => {
    world.metadata = [key()]
    const a = addAgent('kit'); await login('account-a')
    keys.refuse = { reason: 'key_paused', key_status: 'external_access_paused' }
    await service.setAttachments(a.id, account('account-a'), ['key-1'])
    expect(service.attachments(a.id)[0].state).toBe('key_unavailable')
    keys.refuse = null; world.fetch.mockClear()
    await relist([key()])
    expect(world.fetch).toHaveBeenCalledTimes(1)
    expect(service.attachments(a.id)[0]).toMatchObject({ state: 'ready', credential: { keyStatus: 'active' } })
    expect(file((await prepare(a.id)).path!)).toEqual([delivered('key-1', key())])
  })

  it('lets a filled credential for the slot win over a dead key, and a dead key does not count for current_user', async () => {
    world.identity = true
    const a = await setup('bare', [key('key-1', { key_status: 'revoked_by_issuer' }), key('key-2')], ['key-1', 'key-2'])
    expect(file((await prepare(a.id)).path!).map(e => e.id)).toEqual(['key-2', 'current_user'])
    await service.setAttachments(a.id, account('account-a'), ['key-1'])
    const entries = file((await prepare(a.id)).path!)
    expect(entries.map(e => e.id)).toEqual(['key-1'])
    expect(entries[0].unavailable_reason).toBe('key_revoked')
  })

  it('offers active and paused keys and hides terminal ones unless already attached', async () => {
    const items = [key('k-active'), key('k-paused', { key_status: 'api_disabled' }), key('k-revoked', { key_status: 'revoked_by_issuer' }), key('k-expired', { key_status: 'expired' }), key('k-unknown', { key_status: 'quarantined' })]
    const a = await setup('kit', items, ['k-expired'])
    expect(service.attachOptions(a.id).groups[1].items.map(i => [i.cloudId, i.attached])).toEqual([['k-active', false], ['k-paused', false], ['k-expired', true]])
    expect(service.attachments(a.id)).toMatchObject([{ ref: 'k-expired', state: 'key_unavailable', credential: { keyStatus: 'expired' } }])
    await service.setAttachments(a.id, account('account-a'), ['k-expired', 'k-paused'])
    expect(service.attachments(a.id).map(v => v.state)).toEqual(['key_unavailable', 'key_unavailable'])
  })

  it('treats an unknown key status as unavailable', async () => {
    const a = await setup('kit', [key('key-1', { key_status: 'quarantined' })])
    const p = await prepare(a.id)
    expect(world.fetch).not.toHaveBeenCalled()
    expect(file(p.path!)[0]).toMatchObject({ unavailable_reason: 'key_revoked', key_status: 'quarantined' })
    expect(p.prompt).toContain('crm-api): unavailable')
    expect(service.attachments(a.id)[0].state).toBe('key_unavailable')
  })

  it('prunes a key the recipient deleted and removes its entry', async () => {
    const a = await setup('bare')
    const p = await prepare(a.id)
    await relist([])
    expect(service.list()).toEqual([])
    expect(existsSync(p.path!)).toBe(false)
    expect(service.attachments(a.id)[0].state).toBe('missing')
  })

  it('accepts an ISO-8601 key expiry and ignores an invalid one', async () => {
    world.metadata = [key('key-1', { expires_at: '2030-01-02T03:04:05Z' }), key('key-2', { expires_at: null, agent_api: { ...key().agent_api, expires_at: '2031-01-01T00:00:00Z' } }), key('key-3', { expires_at: 'not-a-date' })]
    await login('account-a')
    expect(service.list().map(c => [c.cloudId, c.expiresAt])).toEqual([['key-1', Date.parse('2030-01-02T03:04:05Z')], ['key-2', Date.parse('2031-01-01T00:00:00Z')], ['key-3', null]])
  })

  it('accepts a key API address over https, http to this computer, or http to its own account origin only', () => {
    const at = (base_url: unknown) => ({ id: 'k', name: 'k', type: 'agent_api', notes: null, service_uri: 'k', is_placeholder: false, credential_data: { base_url } })
    const own = 'http://cinna.lan:8080'
    expect(keyApiUrl(at('https://crm.example.test/api'), own)?.href).toBe('https://crm.example.test/api')
    expect(keyApiUrl(at('http://localhost:8000/api'), own)).not.toBeNull()
    expect(keyApiUrl(at('http://127.0.0.1:9/api'), own)).not.toBeNull()
    expect(keyApiUrl(at('http://cinna.lan:8080/api/v1/agent-api/p'), own)).not.toBeNull()
    expect(keyApiUrl(at('http://cinna.lan/api'), own)).toBeNull()
    expect(keyApiUrl(at('http://crm.example.test/api'), own)).toBeNull()
    expect(keyApiUrl(at('ftp://cinna.lan:8080/api'), own)).toBeNull()
    expect(keyApiUrl(at('/relative'), own)).toBeNull()
    expect(keyApiUrl(at(undefined), own)).toBeNull()
  })

  it('does not store a key whose API address is not https or loopback, and writes it token-less until the revision changes', async () => {
    world.identity = true
    const insecure = (id: string) => ({ ...delivered(id, key()), credential_data: { ...delivered(id, key()).credential_data, base_url: 'http://crm.example.test/api' } })
    const deliver = world.fetch.getMockImplementation()!
    world.fetch.mockImplementation(async (user: string, ids: string[]) => ({ ...(await deliver(user, ids)), items: ids.map(id => ({ id, revision: 'k1', entry: insecure(id), service_account_file: null, ssh_key: null })) }))
    const logs = () => getLogEntries().filter(e => e.scope === 'service-credentials' && e.message.startsWith('Issued key not stored')).length
    const logged = logs()
    const a = await setup('kit')
    expect([...world.rows.values()].every(r => !r.payload_enc)).toBe(true)
    expect(service.attachments(a.id)[0]).toMatchObject({ state: 'key_unavailable', credential: { keyStatus: 'active', keyBlocked: 'insecure_base_url', hasValues: false } })
    const p = await prepare(a.id)
    // Token-less entry; the key does not make its account contribute current_user.
    expect(file(p.path!)).toEqual([{ id: 'key-1', name: 'CRM API', type: 'agent_api', notes: null, service_uri: 'crm-api', is_placeholder: false,
      unavailable_reason: 'insecure_base_url', credential_data: { base_url: base, spec_url: `${base}/openapi.json`, producer_agent_id: 'prod-1' } }])
    expect(readFileSync(p.path!, 'utf8')).not.toContain(keys.token)
    expect(p.prompt).toContain('crm-api): unavailable — insecure API address')
    expect(JSON.stringify(service.attachments(a.id))).not.toContain('keyStub')
    // Same revision: not fetched again, logged once.
    world.fetch.mockClear()
    await relist([key()]); await prepare(a.id)
    expect(world.fetch).not.toHaveBeenCalled()
    expect(logs() - logged).toBe(1)
    // A new revision clears the mark and delivers again.
    world.fetch.mockImplementation(deliver)
    await relist([key('key-1', { revision: 'k2' })])
    expect(service.attachments(a.id)[0]).toMatchObject({ state: 'ready', credential: { keyBlocked: null } })
    expect(file(p.path!).map(e => e.id)).toEqual(['key-1', 'current_user'])
    expect(readFileSync(p.path!, 'utf8')).toContain(keys.token)
  })

  it('reads ISO-8601 expiry only for issued keys', async () => {
    world.metadata = [{ ...metadata(), id: 'plain', expires_at: '2030-01-02T03:04:05Z' }, { ...metadata(), id: 'seconds', expires_at: 1_900_000_000 }]
    await login('account-a')
    expect(service.list().map(c => [c.cloudId, c.expiresAt])).toEqual([['plain', null], ['seconds', 1_900_000_000_000]])
  })

  describe('refresh', () => {
    afterEach(() => { vi.useRealTimers() })
    it('polls every minute while a key is attached, every five minutes otherwise, and re-arms when it shortens', async () => {
      world.metadata = [key()]
      const a = addAgent('bare'); await login('account-a')
      vi.useFakeTimers(); vi.setSystemTime(new Date('2026-10-07T10:00:30Z'))
      service.retire(); await service.activate('account-a'); await vi.advanceTimersByTimeAsync(0)
      const calls = () => world.list.mock.calls.length
      let before = calls()
      // Nothing attached: the next poll is at 10:05.
      await vi.advanceTimersByTimeAsync(5_000)
      await service.setAttachments(a.id, account('account-a'), ['key-1'])
      await vi.advanceTimersByTimeAsync(25_001) // 10:01:00
      expect(calls()).toBe(before + 1)
      before = calls()
      await vi.advanceTimersByTimeAsync(60_000) // 10:02:00
      expect(calls()).toBe(before + 1)
      await service.setAttachments(a.id, account('account-a'), [])
      before = calls()
      await vi.advanceTimersByTimeAsync(60_000) // 10:03:00: the tick armed while fast; it then slows down
      expect(calls()).toBe(before + 1)
      before = calls()
      await vi.advanceTimersByTimeAsync(110_000) // 10:04:50
      expect(calls()).toBe(before)
      await vi.advanceTimersByTimeAsync(10_001) // 10:05:00
      expect(calls()).toBe(before + 1)
    })
    it('syncs at once on resume for an account with a key', async () => {
      await setup('bare')
      const before = world.list.mock.calls.length
      service.setSuspended(true); service.setSuspended(false); await sleep()
      expect(world.list.mock.calls.length).toBe(before + 1)
    })
    it('syncs a stale account at turn start within a 5 s budget, and never for an agent without keys', async () => {
      const a = await setup('bare')
      const first = await prepare(a.id)
      let finish!: (v: unknown) => void
      world.list.mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
      vi.useFakeTimers(); vi.setSystemTime(Date.now() + 150_000)
      const before = world.list.mock.calls.length
      let done = false
      const turn = prepare(a.id).then(v => { done = true; return v })
      await vi.advanceTimersByTimeAsync(4_900)
      expect(world.list.mock.calls.length).toBe(before + 1)
      expect(done).toBe(false)
      await vi.advanceTimersByTimeAsync(200)
      expect((await turn).path).toBe(first.path)
      vi.useRealTimers()
      finish({ items: world.metadata }); await sleep()
      // An agent with only an ordinary cloud credential: no list call at turn start.
      const b = addAgent('kit')
      world.metadata.push({ ...metadata(), id: 'plain' })
      await service.sync(); await sleep()
      await service.setAttachments(b.id, account('account-a'), ['plain'])
      vi.useFakeTimers(); vi.setSystemTime(Date.now() + 150_000)
      const count = world.list.mock.calls.length
      await prepare(b.id)
      expect(world.list.mock.calls.length).toBe(count)
    })
    it('waits at most once per interval for a slow Core, and never for a terminal key', async () => {
      const a = await setup('bare')
      await prepare(a.id)
      let finish!: (v: unknown) => void
      world.list.mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
      vi.useFakeTimers(); vi.setSystemTime(Date.now() + 150_000)
      const before = world.list.mock.calls.length
      const first = prepare(a.id)
      await vi.advanceTimersByTimeAsync(5_001); await first
      // The next turn right after: the attempt is recent, so no second wait and no second list call.
      let done = false
      const second = prepare(a.id).then(() => { done = true })
      await vi.advanceTimersByTimeAsync(0)
      expect(done).toBe(true); await second
      expect(world.list.mock.calls.length).toBe(before + 1)
      vi.useRealTimers()
      finish({ items: world.metadata }); await sleep()
      // Only a terminal key attached: no turn-start sync at all.
      await relist([key('key-1', { revision: 'k2', key_status: 'revoked_by_issuer' })])
      vi.useFakeTimers(); vi.setSystemTime(Date.now() + 150_000)
      const count = world.list.mock.calls.length
      await prepare(a.id)
      expect(world.list.mock.calls.length).toBe(count)
    })
  })

  describe('during a running turn (D7)', () => {
    it('writes a rotation and a revocation without waiting for the turn', async () => {
      const a = await setup('kit')
      const p = await prepare(a.id)
      const turn = turnLock.acquireShared(a.id, 'running-turn')
      try {
        keys.token = 'issued-key-token-CCC333'
        await relist([key('key-1', { revision: 'k2' })])
        await vi.waitFor(() => expect(file(p.path!)[0].credential_data.token).toBe('issued-key-token-CCC333'))
        await relist([key('key-1', { revision: 'k3', key_status: 'revoked_by_issuer' })])
        await vi.waitFor(() => expect(file(p.path!)[0]).toMatchObject({ unavailable_reason: 'key_revoked' }))
        expect(readFileSync(p.path!, 'utf8')).not.toContain('issued-key-token')
        expect(turnLock.isLocked(a.id)).toBe(true)
      } finally { turn.release() }
    })
    it('waits for the turn when the same pass changes anything else', async () => {
      const a = await setup('bare', [key(), { ...metadata(), id: 'plain', service_uri: 'plain' }], ['key-1', 'plain'])
      const p = await prepare(a.id), bytes = readFileSync(p.path!, 'utf8')
      const turn = turnLock.acquireShared(a.id, 'running-turn')
      keys.token = 'issued-key-token-DDD444'
      await relist([key('key-1', { revision: 'k2' })]); await sleep(); await sleep()
      expect(readFileSync(p.path!, 'utf8')).toBe(bytes)
      turn.release()
      await vi.waitFor(() => expect(file(p.path!).map(e => [e.id, e.credential_data.token])).toEqual([['key-1', 'issued-key-token-DDD444']]))
    })
  })
})

describe('auto-attach and the Finish setup state', () => {
  const slot = (name: string, serviceUri: string | null, expectedKeys: string[] = [], presentKeys: string[] = [], optional = false) =>
    ({ name, type: 'api_token', optional, envPrefix: null, serviceUri, expectedKeys, presentKeys, satisfied: optional || (expectedKeys.length > 0 && presentKeys.length === expectedKeys.length) })
  const rec = (id: string, name: string, service_uri: string | null, over: Record<string, unknown> = {}) =>
    ({ ...metadata(), id, name, service_uri, ...over })
  /** The scanner's judgement, as the real scan computes it: a matching attachment decides, ready preferred. */
  function kitAgent(slots: ReturnType<typeof slot>[]) {
    const a = addAgent('kit') as any
    Object.defineProperty(a, 'credentials', { get: () => slots.map(s => {
      const attached = service.metadataForPath(a.path).filter(m => m.type === s.type)
      const matching = s.serviceUri ? attached.filter(m => m.serviceUri === s.serviceUri)
        : [attached.filter(m => m.name === s.name), attached.filter(m => m.serviceUri === s.name)].find(g => g.length) ?? []
      const pick = matching.find(m => m.state === 'ready') ?? matching[0]
      return { ...s, attachment: pick ? { credentialId: pick.id, state: pick.state } : null, satisfied: s.optional || (pick ? pick.state === 'ready' : s.satisfied) }
    }) })
    return a
  }
  const group = (a: { id: string }, user: string) => service.attachments(a.id).filter(v => v.group === key(user)).map(v => v.ref)

  it('attaches the single matching record of the active account, and reports it', async () => {
    const a = kitAgent([slot('acme', 'acme-api'), slot('weather', null, ['WEATHER_API_KEY'])])
    world.metadata = [rec('acme-1', 'Acme API', 'acme-api'), rec('other', 'Acme API (other)', null)]
    await login('account-b')
    expect(await service.autoAttach(a.id)).toEqual([{ slot: 'acme', credentialName: 'Acme API' }])
    expect(group(a, 'account-b')).toEqual(['acme-1'])
    const setup = service.setupState(a.id)
    expect(setup.slots.map(s => [s.name, s.state, s.attached?.credential.name ?? null])).toEqual([['acme', 'connected', 'Acme API'], ['weather', 'missing', null]])
    expect(setup.slots[0].attached).toMatchObject({ state: 'ready', credential: { relation: 'shared', ownerEmail: 'owner@example.test' } })
    expect(setup.setupNeeded).toBe(true)
  })

  it('attaches nothing when no record fits, or two do, and offers both to pick from', async () => {
    const a = kitAgent([slot('acme', 'acme-api')])
    world.metadata = [rec('x', 'Unrelated', 'elsewhere')]
    await login('account-b')
    expect(await service.autoAttach(a.id)).toEqual([])
    expect(service.attachments(a.id)).toEqual([])

    world.metadata = [rec('one', 'Acme one', 'acme-api'), rec('two', 'Acme two', 'acme-api')]
    await service.sync(); await sleep()
    expect(await service.autoAttach(a.id)).toEqual([])
    expect(service.attachments(a.id)).toEqual([])
    const [s] = service.setupState(a.id).slots
    expect(s.state).toBe('missing')
    expect(s.options.map(o => [o.ref, o.group])).toEqual([['one', key('account-b')], ['two', key('account-b')]])
  })

  it('prefers the owned record and matches name-only slots by name, then service_uri', async () => {
    const a = kitAgent([slot('acme', 'acme-api'), slot('weather', null), slot('maps', null)])
    world.metadata = [rec('s1', 'Acme shared', 'acme-api'), rec('s2', 'Acme shared 2', 'acme-api'), rec('o1', 'Acme mine', 'acme-api', { relation: 'owned' }),
      rec('w-uri', 'Weather by uri', 'weather', { relation: 'owned' }), rec('w-name', 'weather', null), rec('m-uri', 'Maps Inc', 'maps')]
    await login('account-b')
    expect(await service.autoAttach(a.id)).toEqual([
      { slot: 'acme', credentialName: 'Acme mine' }, { slot: 'weather', credentialName: 'weather' }, { slot: 'maps', credentialName: 'Maps Inc' }])
    expect(group(a, 'account-b')).toEqual(['o1', 'w-name', 'm-uri'])
  })

  it('skips satisfied slots and records kept off this computer, and never removes an attachment', async () => {
    const a = kitAgent([slot('acme', 'acme-api', ['ACME_TOKEN'], ['ACME_TOKEN']), slot('weather', 'weather'), slot('maps', 'maps')])
    world.metadata = [rec('acme-1', 'Acme', 'acme-api'), rec('keep', 'Kept', 'unrelated'), rec('w1', 'Weather', 'weather'), rec('m-off', 'Maps', 'maps', { local_use_allowed: false })]
    await login('account-b')
    await service.setAttachments(a.id, key('account-b'), ['keep'])
    expect(await service.autoAttach(a.id)).toEqual([{ slot: 'weather', credentialName: 'Weather' }])
    expect(group(a, 'account-b')).toEqual(['keep', 'w1'])
    // Now that weather has a ready attachment, a second run adds nothing.
    world.metadata.push(rec('w2', 'Weather 2', 'weather', { relation: 'owned' })); await service.sync(); await sleep()
    expect(await service.autoAttach(a.id)).toEqual([])
    expect(group(a, 'account-b')).toEqual(['keep', 'w1'])
    const states = service.setupState(a.id).slots.map(s => [s.name, s.state, s.options.length])
    expect(states).toEqual([['acme', 'env', 1], ['weather', 'connected', 0], ['maps', 'missing', 0]])
  })

  it('answers at once, without a sync, when no slot is missing', async () => {
    // A fieldless slot is filled by any name under its prefix, as the kit reads it.
    const slots = [slot('acme', 'acme-api', ['ACME_TOKEN'], ['ACME_TOKEN']), slot('vendor', 'vendor', [], ['VENDOR_X'])]
    const a = kitAgent(slots)
    world.metadata = [rec('acme-1', 'Acme', 'acme-api'), rec('v1', 'Vendor', 'vendor')]
    await login('account-b')
    world.list.mockClear()
    expect(await service.autoAttach(a.id)).toEqual([])
    expect(world.list).not.toHaveBeenCalled()
    expect(service.setupState(a.id).slots.map(s => s.state)).toEqual(['env', 'env'])
    // A missing slot does sync first.
    slots[1] = slot('vendor', 'vendor')
    expect(await service.autoAttach(a.id)).toEqual([{ slot: 'vendor', credentialName: 'Vendor' }])
    expect(world.list).toHaveBeenCalled()
  })

  it('touches only the active profile account, and does nothing on a local profile', async () => {
    const a = kitAgent([slot('acme', 'acme-api')])
    world.byUser = { 'account-a': [rec('a-acme', 'A Acme', 'acme-api')], 'account-b': [] }
    await login('account-a'); await login('account-b')
    expect(await service.autoAttach(a.id)).toEqual([])
    expect(service.attachments(a.id)).toEqual([])
    world.user = '__default__'; await service.activate('__default__')
    expect(await service.autoAttach(a.id)).toEqual([])
    expect(service.setupState(a.id).slots[0].options).toEqual([])
  })

  it('shows an attached record that stopped counting as missing, with why, beside the other options', async () => {
    const a = kitAgent([slot('acme', 'acme-api', ['ACME_TOKEN'], ['ACME_TOKEN'])])
    world.metadata = [rec('acme-1', 'Acme API', 'acme-api'), rec('acme-2', 'Acme backup', 'acme-api')]
    await login('account-b')
    await service.setAttachments(a.id, key('account-b'), ['acme-1'])
    expect(service.setupState(a.id).slots[0]).toMatchObject({ state: 'connected', options: [] })
    world.metadata[0].local_use_allowed = false; await service.sync(); await sleep()
    // `.env` holds the name, but the matching attachment decides, as readiness says.
    const [s] = service.setupState(a.id).slots
    expect(s).toMatchObject({ state: 'missing', attached: { state: 'local_use_not_allowed', credential: { name: 'Acme API' } } })
    expect(s.options.map(o => o.ref)).toEqual(['acme-2'])
    expect(service.setupState(a.id).setupNeeded).toBe(true)
  })

  it('never waits for a running turn: attaches nothing, at once, and queues nothing', async () => {
    const a = kitAgent([slot('acme', 'acme-api')])
    world.metadata = [rec('acme-1', 'Acme API', 'acme-api')]
    await login('account-b'); await sleep()
    const turn = turnLock.acquireShared(a.id, 'turn')
    try {
      const started = Date.now()
      expect(await service.autoAttach(a.id)).toEqual([])
      expect(Date.now() - started).toBeLessThan(1000)
    } finally { turn.release() }
    await sleep()
    expect(service.attachments(a.id)).toEqual([])
    // With the agent free it attaches, even right behind a background regeneration.
    expect(await service.autoAttach(a.id)).toEqual([{ slot: 'acme', credentialName: 'Acme API' }])
  })

  it('swallows a failed attach and answers nothing attached', async () => {
    const a = kitAgent([slot('acme', 'acme-api')])
    mkdirSync(join(a.path, 'credentials')); writeFileSync(join(a.path, 'credentials/credentials.json'), '[]')
    execFileSync('git', ['init', '-q', a.path]); execFileSync('git', ['-C', a.path, 'add', 'credentials/credentials.json'])
    world.metadata = [rec('acme-1', 'Acme API', 'acme-api')]
    await login('account-b')
    await expect(service.autoAttach(a.id)).resolves.toEqual([])
    expect(service.attachments(a.id)).toEqual([])
  })

  it('appends through attach without dropping what is there', async () => {
    const a = kitAgent([slot('acme', 'acme-api')])
    world.metadata = [rec('one', 'Acme one', 'acme-api'), rec('two', 'Acme two', 'acme-api')]
    await login('account-b')
    await service.setAttachments(a.id, key('account-b'), ['one'])
    await service.attach(a.id, key('account-b'), 'two')
    expect(group(a, 'account-b')).toEqual(['one', 'two'])
  })
})
