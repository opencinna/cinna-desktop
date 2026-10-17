import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, statSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import type { ServiceCredentialRow } from '../../db/serviceCredentials'
const world = vi.hoisted(() => ({ user: '__default__', home: '', secure: true, agents: [] as any[], rows: new Map<string, any>(), metadata: [] as any[], byUser: {} as Record<string, any[]>, identity: false, users: new Map<string, any>(), unlocked: new Set<string>(), token: 'fixture-cloud-token-123', allowed: true, fetch: vi.fn(), list: vi.fn(), provision: vi.fn(), open: vi.fn(), oauthCreate: vi.fn(), oauthAuthorize: vi.fn(), accessToken: vi.fn() }))
vi.mock('../../host/runtimeHost', () => ({ runtimeHost: { getPath: () => world.home, shell: { openExternal: (url: string) => world.open(url) }, keystore: {
  isEncryptionAvailable: () => true,
  isSecureStorageAvailable: () => world.secure,
  encryptString: (s: string) => Buffer.from([...Buffer.from(s)].map(b => b ^ 0x93)),
  decryptString: (b: Buffer) => Buffer.from([...b].map(v => v ^ 0x93)).toString()
} } }))
vi.mock('../../host/events', () => ({ publishEvent: vi.fn() }))
vi.mock('../../auth/scope', () => ({ getProfileScopeUserId: () => world.user }))
vi.mock('../../auth/cinna-tokens', () => ({ getStoredCinnaSubject: (id: string) => id.replace('new-', '') }))
vi.mock('../../db/users', () => ({ userRepo: { get: (id: string) => world.users.get(id) ?? ({ id, type: id === '__default__' ? 'local_user' : 'cinna_user', cinnaServerUrl: 'http://localhost:8000', displayName: id, username: id, passwordHash: null }), list: () => [...world.users.values()] } }))
vi.mock('../../db/serviceCredentials', () => ({ credentialDto: (r: ServiceCredentialRow) => { const { keyStub: _stub, ...m } = JSON.parse(r.metadata); return { ...m, keyStatus: m.keyStatus ?? null, agentApi: m.agentApi ?? null, keyBlocked: m.keyBlocked ?? null, oauthStatus: m.oauthStatus ?? null, grantedUserEmail: m.grantedUserEmail ?? null, id: r.id, origin: r.origin, cloudId: r.cloud_id, hasValues: !!r.payload_enc, expiresAt: r.expires_at } }, serviceCredentialRepo: {
  list: (id: string) => [...world.rows.values()].filter(r => r.user_id === id), get: (id: string) => world.rows.get(id), put: (r: any) => world.rows.set(r.id, r), remove: (id: string) => world.rows.delete(id), clearProfile: (id: string) => { for (const [key, row] of world.rows) if (row.user_id === id && row.origin === 'cloud') world.rows.delete(key) }
} }))
vi.mock('../localAgents/localAgentService', () => ({ localAgentService: { list: () => ({ agents: world.agents }), get: (_: string, id: string) => { const a = world.agents.find(a => a.id === id); if (!a) throw new Error('Agent missing'); return a } } }))
vi.mock('../localAgents/scannerService', () => ({ markAllRootsDirty() {} }))
vi.mock('../../shell/env', () => ({ getShellEnv: async () => process.env, usableTool: async (bin: string) => bin }))
vi.mock('./cloud', () => ({ serviceCredentialCloud: { list: (...args: unknown[]) => world.list(...args), materialize: (...args: unknown[]) => world.fetch(...args), provisionLocal: (...args: unknown[]) => world.provision(...args),
  createOAuth: (...args: unknown[]) => world.oauthCreate(...args), authorizeOAuth: (...args: unknown[]) => world.oauthAuthorize(...args), accessToken: (...args: unknown[]) => world.accessToken(...args) } }))
import { keyApiUrl, oauthFlowTiming, tokenTiming, serviceCredentialService as service } from './service'
import { publishEvent } from '../../host/events'
import { SERVICE_CREDENTIALS_CHANGED } from '../../../shared/serviceCredentials'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { engineCredentialEnv } from '../skillRuntime'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { turnLock } from '../localAgents/turnLock'
import { desktopStateService } from '../localAgents/desktopStateService'
import { clearCredentialRedaction, redactCredentialText } from '../../security/serviceCredentialRedaction'
import { getLogEntries } from '../../logger/logger'
const sleep = () => new Promise(resolve => setTimeout(resolve, 30))
beforeEach(async () => {
  world.home = mkdtempSync(join(tmpdir(), 'cinna-credentials-')); world.user = '__default__'; world.rows.clear(); world.secure = true; world.agents = []; world.metadata = []; world.byUser = {}; world.identity = false; world.users.clear(); world.unlocked.clear(); world.allowed = true
  world.list.mockImplementation(async (user: string) => ({ items: world.byUser[user] ?? world.metadata }))
  world.provision.mockReset(); world.provision.mockResolvedValue({ slots: [] })
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
    await expect(service.setAttachments(a.id, 'local', [c.id])).rejects.toThrow('is tracked by git')
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

describe('skill slots: auto-attach, provision-local and the Finish setup state', () => {
  const rec = (id: string, name: string, service_uri: string | null, over: Record<string, unknown> = {}) =>
    ({ ...metadata(), id, name, service_uri, ...over })
  type Declared = { slot: string; type?: string }
  const skill = (name: string, declared: Declared[], over: Record<string, unknown> = {}) => ({
    name, description: '', version: null, source: 'authored', path: '', deliverable: true, issues: [],
    credentials: declared.map(d => ({ slot: d.slot, type: d.type ?? 'api_token', description: null })), ...over
  })
  const catalog = (name: string, declared: Declared[], packageUuid = 'pkg-uuid', revisionNumber = 3) =>
    skill(name, declared, { source: 'catalog', packageUuid, revisionNumber, packageId: 'erp' })
  /** A kit agent with no slots of its own and these skill rows. */
  function skillAgent(skills: ReturnType<typeof skill>[]) {
    const a = addAgent('kit') as any
    a.credentials = []; a.skills = skills
    return a
  }
  const group = (a: { id: string }, user: string) => service.attachments(a.id).filter(v => v.group === key(user)).map(v => v.ref)

  it('attaches the one record whose type and Service URI are the slot, and says it was a skill slot', async () => {
    const a = skillAgent([skill('erp-orders', [{ slot: 'erp-api' }])])
    world.metadata = [rec('erp-1', 'ERP', 'erp-api'), rec('imap', 'ERP mail', 'erp-api', { type: 'email_imap' }), rec('named', 'erp-api', null)]
    await login('account-b')
    expect(await service.autoAttachSkills(a.id)).toEqual([{ slot: 'erp-api', credentialName: 'ERP', skill: true }])
    expect(group(a, 'account-b')).toEqual(['erp-1'])
    const [s] = service.setupState(a.id).skillSlots
    expect(s).toMatchObject({ slot: 'erp-api', type: 'api_token', skills: ['erp-orders'], state: 'connected', attached: { state: 'ready', credential: { name: 'ERP' } }, options: [] })
    expect(s.attached!.credential).not.toHaveProperty('state')
  })

  it('matches strictly: never by name, never another type', async () => {
    const a = skillAgent([skill('erp-orders', [{ slot: 'erp-api' }])])
    world.metadata = [rec('named', 'erp-api', null), rec('imap', 'ERP mail', 'erp-api', { type: 'email_imap' })]
    await login('account-b')
    expect(await service.autoAttachSkills(a.id)).toEqual([])
    expect(service.setupState(a.id).skillSlots[0]).toMatchObject({ state: 'missing', options: [] })
    // Attached by hand, the record of another type does not fill it; it is named as the mismatch.
    await service.setAttachments(a.id, key('account-b'), ['imap'])
    expect(service.setupState(a.id).skillSlots[0]).toMatchObject({ state: 'missing', attached: null, typeMismatch: { name: 'ERP mail', type: 'email_imap' } })
  })

  it('names a record of the slot’s type and Service URI that may not be used on this computer, when nothing fits', async () => {
    const a = skillAgent([skill('erp-orders', [{ slot: 'erp-api' }])])
    world.metadata = [rec('far', 'ERP (cloud only)', 'erp-api', { local_use_allowed: false, relation: 'shared' })]
    await login('account-b')
    expect(await service.autoAttachSkills(a.id)).toEqual([])
    expect(service.setupState(a.id).skillSlots[0]).toMatchObject({ state: 'missing', options: [], notLocal: { name: 'ERP (cloud only)' } })
  })

  it('attaches only when exactly one record fits, the owned one before shared ones, and offers the rest', async () => {
    const a = skillAgent([skill('erp-orders', [{ slot: 'erp-api' }])])
    world.metadata = [rec('one', 'ERP one', 'erp-api'), rec('two', 'ERP two', 'erp-api')]
    await login('account-b')
    expect(await service.autoAttachSkills(a.id)).toEqual([])
    expect(service.attachments(a.id)).toEqual([])
    expect(service.setupState(a.id).skillSlots[0].options.map(o => o.ref)).toEqual(['one', 'two'])
    world.metadata.push(rec('mine', 'ERP mine', 'erp-api', { relation: 'owned' })); await service.sync(); await sleep()
    expect(await service.autoAttachSkills(a.id)).toEqual([{ slot: 'erp-api', credentialName: 'ERP mine', skill: true }])
    expect(group(a, 'account-b')).toEqual(['mine'])
  })

  it('never adds to or replaces what the user attached for the slot', async () => {
    const a = skillAgent([skill('erp-orders', [{ slot: 'erp-api' }]), skill('crm-sync', [{ slot: 'crm', type: 'odoo' }])])
    world.metadata = [rec('chosen', 'ERP chosen', 'erp-api'), rec('crm-imap', 'CRM mail', 'crm', { type: 'email_imap' })]
    await login('account-b')
    await service.setAttachments(a.id, key('account-b'), ['chosen', 'crm-imap'])
    world.metadata.push(rec('better', 'ERP better', 'erp-api', { relation: 'owned' }), rec('crm-odoo', 'CRM', 'crm', { type: 'odoo' }))
    await service.sync(); await sleep()
    expect(await service.autoAttachSkills(a.id)).toEqual([])
    expect(group(a, 'account-b')).toEqual(['chosen', 'crm-imap'])
    expect(world.provision).not.toHaveBeenCalled()
  })

  it('provisions each pinned catalog revision first, so a publisher-shared credential can be attached', async () => {
    const a = skillAgent([catalog('erp-orders', [{ slot: 'erp-api' }]), catalog('erp-invoices', [{ slot: 'erp-api' }]), skill('own', [{ slot: 'own-api' }])])
    world.metadata = []
    await login('account-b')
    world.provision.mockImplementation(async () => {
      world.metadata = [rec('erp-pub', 'ERP (publisher)', 'erp-api')]
      return { slots: [{ slot: 'erp-api', type: 'api_token', provided_by: 'publisher', outcome: 'shared', credential_id: 'erp-pub' }] }
    })
    expect(await service.autoAttachSkills(a.id)).toEqual([{ slot: 'erp-api', credentialName: 'ERP (publisher)', skill: true }])
    // One call per revision, never for an own skill.
    expect(world.provision.mock.calls.map(c => c.slice(0, 3))).toEqual([['account-b', 'pkg-uuid', 3]])
    expect(group(a, 'account-b')).toEqual(['erp-pub'])
    expect(service.setupState(a.id).skillSlots.map(s => [s.slot, s.state, s.provision])).toEqual([['erp-api', 'connected', 'shared'], ['own-api', 'missing', null]])
  })

  it('shows a publisher credential that may not come to this computer, and survives a failed provision', async () => {
    const a = skillAgent([catalog('mail', [{ slot: 'mail-in', type: 'email_imap' }], 'pkg-mail', 1), catalog('erp', [{ slot: 'erp-api' }], 'pkg-erp', 2)])
    world.metadata = [rec('erp-1', 'ERP', 'erp-api')]
    await login('account-b')
    world.provision.mockImplementation(async (_user: string, uuid: string) => {
      if (uuid === 'pkg-erp') throw Object.assign(new Error('nope'), { status: 404 })
      return { slots: [{ slot: 'mail-in', type: 'email_imap', provided_by: 'publisher', outcome: 'not_allowed_locally', credential_id: null }, { slot: 'x', type: 'y', outcome: 'bogus' }] }
    })
    expect(await service.autoAttachSkills(a.id)).toEqual([{ slot: 'erp-api', credentialName: 'ERP', skill: true }])
    expect(service.setupState(a.id).skillSlots.map(s => [s.slot, s.state, s.provision])).toEqual([['mail-in', 'missing', 'not_allowed_locally'], ['erp-api', 'connected', null]])
  })

  it('attaches one record to a Service URI two skills declare with different types', async () => {
    const a = skillAgent([skill('erp-orders', [{ slot: 'erp-api' }]), skill('erp-sync', [{ slot: 'erp-api', type: 'odoo' }])])
    world.metadata = [rec('erp-token', 'ERP token', 'erp-api'), rec('erp-odoo', 'ERP odoo', 'erp-api', { type: 'odoo' })]
    await login('account-b')
    expect(await service.autoAttachSkills(a.id)).toEqual([{ slot: 'erp-api', credentialName: 'ERP token', skill: true }])
    expect(group(a, 'account-b')).toEqual(['erp-token'])
  })

  it('lists deliverable skills only, one entry per slot and type, and never decides setupNeeded', async () => {
    const a = skillAgent([
      skill('a', [{ slot: 'erp-api' }, { slot: 'erp-api', type: 'odoo' }]), skill('b', [{ slot: 'erp-api' }]),
      skill('broken', [{ slot: 'hidden' }], { deliverable: false })
    ])
    const setup = service.setupState(a.id)
    expect(setup.skillSlots.map(s => [s.slot, s.type, s.skills])).toEqual([['erp-api', 'api_token', ['a', 'b']], ['erp-api', 'odoo', ['a']]])
    expect(setup.setupNeeded).toBe(false)
    // A local profile has no account to attach from or offer.
    expect(await service.autoAttachSkills(a.id)).toEqual([])
    expect(setup.skillSlots[0].options).toEqual([])
  })

  it('writes what the skill runtime reads: the materialised file answers require_slot for the attached slot', async () => {
    const a = skillAgent([skill('erp-orders', [{ slot: 'api' }])])
    world.metadata = [metadata()]
    await login('account-b')
    expect(await service.autoAttachSkills(a.id)).toEqual([{ slot: 'api', credentialName: 'Cloud', skill: true }])
    const p = await prepare(a.id)
    expect(p.skillRuntime).toBe(true)
    // A bare folder carries no skills: its engine gets no skill runtime.
    expect((await prepare(addAgent('bare').id)).skillRuntime).toBe(false)
    const shim = join(process.cwd(), 'resources/skill-runtime')
    const out = execFileSync('python3', ['-I', '-B', '-c', `import sys; sys.path.insert(0, ${JSON.stringify(shim)})
from core.cinna_api import credentials, CredentialMissing
print(credentials.require_slot('api')['credential_data']['http_header_value'])
try:
    credentials.require_slot('other')
except CredentialMissing as e:
    print(e.reason)`], { env: { ...process.env, CINNA_CREDENTIALS_PATH: p.path! }, encoding: 'utf8' })
    expect(out.trim().split('\n')).toEqual([`Bearer ${world.token}`, 'not_linked'])
  })

  describe('what auto-attach put there, and detaching it when no skill declares its slot', () => {
    /** The stored entries of the account's group, as desktop state holds them. */
    const stored = (a: { path: string }, user: string) => desktopStateService.read(a.path, 'kit').serviceCredentials?.accounts[key(user)] ?? []
    /** Two auto-attached skill slots (erp-api, crm) and one record attached by hand. */
    async function attachedAgent(skills: ReturnType<typeof skill>[]) {
      const a = skillAgent(skills)
      world.metadata = [rec('erp-1', 'ERP', 'erp-api'), rec('crm-1', 'CRM', 'crm'), rec('notes', 'Notes', 'notes-api')]
      await login('account-b')
      expect((await service.autoAttachSkills(a.id)).map(v => v.slot)).toEqual(['erp-api', 'crm'])
      await service.attach(a.id, key('account-b'), 'notes')
      return a
    }

    it('marks what it attached with the slot, keeps the mark through later writes, and reads old state as manual', async () => {
      const a = await attachedAgent([skill('erp-orders', [{ slot: 'erp-api' }]), skill('crm-sync', [{ slot: 'crm' }])])
      expect(stored(a, 'account-b')).toEqual([{ ref: 'erp-1', auto: { slot: 'erp-api' } }, { ref: 'crm-1', auto: { slot: 'crm' } }, { ref: 'notes' }])
      // A full replacement that keeps a ref keeps its entry; the renderer's DTO is unchanged.
      await service.setAttachments(a.id, key('account-b'), ['notes', 'erp-1'])
      expect(stored(a, 'account-b')).toEqual([{ ref: 'notes' }, { ref: 'erp-1', auto: { slot: 'erp-api' } }])
      expect(service.attachments(a.id)[0]).not.toHaveProperty('auto')
      // State written before provenance existed: every entry is manual, and stays attached.
      writeFileSync(join(a.path, 'app-data', 'desktop.json'), JSON.stringify({ serviceCredentials: { local: [], accounts: { [key('account-b')]: [{ ref: 'erp-1' }, { ref: 'notes', auto: 'bogus' }] } } }))
      expect(stored(a, 'account-b')).toEqual([{ ref: 'erp-1' }, { ref: 'notes' }])
      a.skills = []
      expect(await service.detachUnusedAutoAttachments(a.id)).toEqual([])
      expect(group(a, 'account-b')).toEqual(['erp-1', 'notes'])
    })

    it('detaches only an auto entry whose slot no skill declares any more, never one attached by hand', async () => {
      const a = await attachedAgent([skill('erp-orders', [{ slot: 'erp-api' }]), skill('crm-sync', [{ slot: 'crm' }])])
      a.skills = [skill('crm-sync', [{ slot: 'crm' }])]
      expect(await service.detachUnusedAutoAttachments(a.id)).toEqual([{ group: key('account-b'), ref: 'erp-1', slot: 'erp-api' }])
      expect(group(a, 'account-b')).toEqual(['crm-1', 'notes'])
      // Nothing more to do: no write at all.
      expect(await service.detachUnusedAutoAttachments(a.id)).toEqual([])
    })

    it('keeps an auto entry another remaining skill still declares', async () => {
      const a = await attachedAgent([skill('erp-orders', [{ slot: 'erp-api' }]), skill('erp-invoices', [{ slot: 'erp-api' }]), skill('crm-sync', [{ slot: 'crm' }])])
      a.skills = [skill('erp-invoices', [{ slot: 'erp-api' }])]
      expect(await service.detachUnusedAutoAttachments(a.id)).toEqual([{ group: key('account-b'), ref: 'crm-1', slot: 'crm' }])
      expect(group(a, 'account-b')).toEqual(['erp-1', 'notes'])
    })

    it('keeps an auto entry an agent credential slot is judged by', async () => {
      const a = await attachedAgent([skill('erp-orders', [{ slot: 'erp-api' }]), skill('crm-sync', [{ slot: 'crm' }])])
      const erp = service.attachments(a.id).find(v => v.ref === 'erp-1')!.credential!
      a.credentials = [{ name: 'ERP', type: 'api_token', serviceUri: 'erp-api', optional: false, satisfied: true, envPrefix: 'ERP', expectedKeys: [], presentKeys: [], attachment: { credentialId: erp.id, state: 'ready' } }]
      a.skills = []
      expect(await service.detachUnusedAutoAttachments(a.id)).toEqual([{ group: key('account-b'), ref: 'crm-1', slot: 'crm' }])
      expect(group(a, 'account-b')).toEqual(['erp-1', 'notes'])
    })

    it('leaves everything attached while a turn holds the agent, or while a pinned skill is not on this computer', async () => {
      const a = await attachedAgent([skill('erp-orders', [{ slot: 'erp-api' }]), skill('crm-sync', [{ slot: 'crm' }])])
      a.skills = [catalog('erp-later', [])]
      expect(await service.detachUnusedAutoAttachments(a.id)).toEqual([])
      expect(group(a, 'account-b')).toEqual(['erp-1', 'crm-1', 'notes'])
      a.skills = []
      // A turn holds the agent shared; the detach does not wait for it.
      const lock = turnLock.acquireShared(a.id, 'turn')
      expect(await service.detachUnusedAutoAttachments(a.id)).toEqual([])
      expect(group(a, 'account-b')).toEqual(['erp-1', 'crm-1', 'notes'])
      lock.release(); await sleep()
      expect((await service.detachUnusedAutoAttachments(a.id)).map(v => v.ref)).toEqual(['erp-1', 'crm-1'])
      expect(group(a, 'account-b')).toEqual(['notes'])
    })
  })
})

describe('Google OAuth credentials (core-brokered)', () => {
  const run = promisify(execFile)
  const shim = join(process.cwd(), 'resources/skill-runtime')
  const g = { token: 'ya29.google-token-AAA111', expires: 0, refuse: null as null | string, scope: 'https://www.googleapis.com/auth/gmail.readonly' }
  const now = () => Math.floor(Date.now() / 1000)
  function gmail(id = 'g-1', extra: Record<string, unknown> = {}) {
    return { id, name: 'Gmail (read-only)', type: 'gmail_oauth_readonly', notes: null, service_uri: 'gmail', status: 'complete', is_placeholder: false, relation: 'owned', owner_email: null,
      local_use_allowed: true, revision: 'g1', expires_at: g.expires, oauth_status: 'ready', granted_user_email: 'me@gmail.test', ...extra }
  }
  const plain = (id = 'plain') => ({ ...metadata(), id, service_uri: id })
  const deliveredG = (id: string, meta: any) => ({ id, name: meta.name, type: meta.type, notes: null, service_uri: meta.service_uri, is_placeholder: false,
    credential_data: { access_token: g.token, token_type: 'Bearer', expires_at: g.expires, scope: g.scope, granted_user_email: 'me@gmail.test', granted_user_name: 'Me' } })
  const file = (path: string) => JSON.parse(readFileSync(path, 'utf8')) as any[]
  const acc = key('account-a')
  beforeEach(() => {
    g.token = 'ya29.google-token-AAA111'; g.expires = now() + 3600; g.refuse = null; g.scope = 'https://www.googleapis.com/auth/gmail.readonly'
    oauthFlowTiming.pollMs = 20; oauthFlowTiming.windowMs = 600_000
    world.open.mockReset(); world.oauthCreate.mockReset(); world.oauthAuthorize.mockReset(); world.accessToken.mockReset(); world.fetch.mockClear(); world.list.mockClear()
    world.fetch.mockImplementation(async (_user: string, ids: string[]) => {
      const refused = g.refuse ? ids.map(id => ({ id, reason: g.refuse })) : []
      const items = g.refuse ? [] : ids.map(id => {
        const meta = world.metadata.find(m => m.id === id)
        const entry = meta.type === 'api_token' ? { id, name: meta.name, type: meta.type, notes: null, service_uri: meta.service_uri, is_placeholder: false, credential_data: { http_header_name: 'Authorization', http_header_value: `Bearer ${world.token}` } } : deliveredG(id, meta)
        return { id, revision: meta.revision, entry, service_account_file: null, ssh_key: null }
      })
      return { items, refused, current_user: null, owner_identity: null }
    })
  })
  afterEach(async () => { oauthFlowTiming.pollMs = 2_000; oauthFlowTiming.windowMs = 600_000; tokenTiming.replyWaitMs = 2_000; tokenTiming.unavailableRetryMs = 60_000; await service.closeTokenServer() })
  async function setup(items: any[] = [gmail()], refs = ['g-1'], kind: 'kit' | 'bare' = 'kit') {
    world.metadata = items
    const a = addAgent(kind); await login('account-a')
    if (refs.length) await service.setAttachments(a.id, acc, refs)
    return a
  }
  /** Sync, then let the queued regeneration (an exclusive hold) finish. */
  async function relist(items: any[]) {
    world.metadata = items; await service.sync(); await sleep()
    for (let i = 0; i < 100 && world.agents.some(a => turnLock.isExclusivelyLocked(a.id)); i++) await sleep()
  }
  const authorized = (id: string) => ({ status: 201, ok: true, body: { credential_id: id, authorization_url: `https://accounts.google.com/o/oauth2/auth?state=fixture-state-${id}`, expires_at: now() + 600 } })
  const flowState = (id: string) => service.oauthFlow(id)?.state

  it('lists Core’s status and Google account, delivers the access token, and keeps it out of DTOs and logs', async () => {
    const a = await setup([gmail(), plain()], ['g-1', 'plain'])
    const p = await prepare(a.id)
    expect(file(p.path!).find(e => e.id === 'g-1').credential_data).toMatchObject({ access_token: g.token, expires_at: g.expires })
    const dtos = service.attachments(a.id)
    expect(dtos.map(d => [d.ref, d.state, d.credential?.oauthStatus, d.credential?.grantedUserEmail])).toEqual([['g-1', 'ready', 'ready', 'me@gmail.test'], ['plain', 'ready', null, null]])
    expect(JSON.stringify([dtos, service.list(), service.attachOptions(a.id)])).not.toContain(g.token)
    expect(redactCredentialText(`token ${g.token}`)).toBe('token ***REDACTED***')
    expect(p.prompt).toContain('Gmail (read-only) (gmail_oauth_readonly; slot gmail): ready')
  })

  it('never fetches a record Core has not authorized, and writes it token-less with the reason the helpers name', async () => {
    const a = await setup([gmail('g-1', { oauth_status: 'pending_authorization', granted_user_email: null })])
    const p = await prepare(a.id)
    expect(world.fetch.mock.calls.flatMap(([, ids]) => ids)).not.toContain('g-1')
    expect(service.attachments(a.id)[0].state).toBe('pending_authorization')
    expect(file(p.path!)).toEqual([{ id: 'g-1', name: 'Gmail (read-only)', type: 'gmail_oauth_readonly', notes: null, service_uri: 'gmail', is_placeholder: false, unavailable_reason: 'pending_authorization', credential_data: {} }])
    expect(p.prompt).toContain('unavailable — the Google account is not connected yet')
    await relist([gmail('g-1', { oauth_status: 'reauth_required', revision: 'g2' })])
    const again = await prepare(a.id)
    expect(service.attachments(a.id)[0].state).toBe('reauth_required')
    expect(file(again.path!)[0]).toMatchObject({ unavailable_reason: 'reauthorization_required', credential_data: {} })
    // An unknown status reads as not authorized.
    await relist([gmail('g-1', { oauth_status: 'something_new', revision: 'g3' })])
    expect(service.attachments(a.id)[0].state).toBe('pending_authorization')
  })

  it('keeps an entry whose access token has expired: it is refetched, never called expired', async () => {
    g.expires = now() - 60
    const a = await setup()
    world.fetch.mockClear()
    const p = await prepare(a.id)
    // Within the 600 s window, so the turn asks Core again (Core refreshes before it delivers).
    expect(world.fetch.mock.calls.flatMap(([, ids]) => ids)).toContain('g-1')
    expect(service.attachments(a.id)[0].state).toBe('ready')
    expect(file(p.path!)[0].credential_data.access_token).toBe(g.token)
  })

  it('keeps the generation across a token renewal, so the engine process is not respawned', async () => {
    g.expires = now() + 300
    const a = await setup()
    const first = await prepare(a.id)
    g.token = 'ya29.google-token-RENEWED'; g.expires = now() + 3599
    await relist([gmail('g-1', { revision: 'g2' })])
    const second = await prepare(a.id)
    expect(file(second.path!)[0].credential_data.access_token).toBe('ya29.google-token-RENEWED')
    expect(second.generation).toBe(first.generation)
    g.refuse = 'reauthorization_required'
    await relist([gmail('g-1', { revision: 'g3', oauth_status: 'reauth_required' })])
    expect((await prepare(a.id)).generation).not.toBe(first.generation)
  })

  it('maps delivery refusals: token_unavailable keeps the cached token, pending/reauth set the state until the next list', async () => {
    g.expires = now() + 300
    const a = await setup()
    const p = await prepare(a.id)
    g.refuse = 'token_unavailable'
    await prepare(a.id)
    expect(service.attachments(a.id)[0]).toMatchObject({ state: 'ready', credential: { localUseAllowed: true, oauthStatus: 'ready', hasValues: true } })
    expect(file(p.path!)[0].credential_data.access_token).toBe(g.token)
    g.refuse = 'reauthorization_required'
    await prepare(a.id)
    expect(service.attachments(a.id)[0]).toMatchObject({ state: 'reauth_required', credential: { localUseAllowed: true, oauthStatus: 'reauth_required', hasValues: false } })
    expect(file(p.path!)[0]).toMatchObject({ unavailable_reason: 'reauthorization_required' })
    g.refuse = 'pending_authorization'
    await relist([gmail()])
    expect(service.attachments(a.id)[0].state).toBe('pending_authorization')
    g.refuse = null
    await relist([gmail('g-1', { revision: 'g2' })])
    expect(service.attachments(a.id)[0].state).toBe('ready')
  })

  it('leaves a record Core could not get a token for alone for the back-off, then asks again', async () => {
    g.expires = now() + 120 // inside the 600 s window: every pass would ask
    tokenTiming.unavailableRetryMs = 300
    const a = await setup()
    await prepare(a.id)
    const asked = () => world.fetch.mock.calls.flatMap(([, ids]) => ids).filter((id: string) => id === 'g-1').length
    g.refuse = 'token_unavailable'; world.fetch.mockClear()
    await service.sync(); await sleep()
    expect(asked()).toBe(1)
    await service.sync(); await service.sync(); await sleep()
    expect(asked()).toBe(1)
    expect(service.attachments(a.id)[0]).toMatchObject({ state: 'ready', credential: { hasValues: true } })
    await new Promise(resolve => setTimeout(resolve, 320))
    await service.sync(); await sleep()
    expect(asked()).toBe(2)
  })

  it('never offers or auto-attaches a pending record a canceled connect left, unless it is attached already', async () => {
    const pending = gmail('g-pend', { oauth_status: 'pending_authorization', granted_user_email: null })
    const a = await setup([pending, plain()], []) as any
    a.credentials = [{ name: 'mail', type: 'gmail_oauth_readonly', optional: false, envPrefix: null, serviceUri: 'gmail', expectedKeys: [], presentKeys: [], satisfied: false, attachment: null }]
    a.skills = [{ name: 'inbox', description: '', version: null, source: 'authored', path: '', deliverable: true, issues: [], credentials: [{ slot: 'gmail', type: 'gmail_oauth_readonly', description: null }] }]
    const offered = () => service.attachOptions(a.id).groups.find(gr => gr.key === acc)!.items.map(i => [i.cloudId, i.attached])
    expect(offered()).toEqual([['plain', false]])
    const setupNow = service.setupState(a.id)
    expect([setupNow.slots[0].options, setupNow.skillSlots[0].options]).toEqual([[], []])
    expect(await service.autoAttach(a.id)).toEqual([])
    expect(await service.autoAttachSkills(a.id)).toEqual([])
    expect(service.attachments(a.id)).toEqual([])
    // Once ready it is offered and attached like any record.
    await relist([gmail('g-pend', { revision: 'g2' }), plain()])
    expect(offered()).toEqual([['g-pend', false], ['plain', false]])
    expect(service.setupState(a.id).slots[0].options.map(o => o.ref)).toEqual(['g-pend'])
    // Already attached (it lost its grant to pending): still listed, as attached.
    await service.setAttachments(a.id, acc, ['g-pend'])
    await relist([pending, plain()])
    expect(offered()).toEqual([['g-pend', true], ['plain', false]])
  })

  describe('during a running turn', () => {
    it('writes a renewed access token at once (keyOnlyChange), and a lost grant too', async () => {
      const a = await setup()
      const p = await prepare(a.id)
      const turn = turnLock.acquireShared(a.id, 'running-turn')
      try {
        g.token = 'ya29.google-token-BBB222'; g.expires = now() + 3599
        await relist([gmail('g-1', { revision: 'g2' })])
        await vi.waitFor(() => expect(file(p.path!)[0].credential_data).toMatchObject({ access_token: 'ya29.google-token-BBB222', expires_at: g.expires }))
        await relist([gmail('g-1', { revision: 'g3', oauth_status: 'reauth_required' })])
        await vi.waitFor(() => expect(file(p.path!)[0]).toMatchObject({ unavailable_reason: 'reauthorization_required' }))
        expect(readFileSync(p.path!, 'utf8')).not.toContain('ya29.')
      } finally { turn.release() }
    })
    it('waits for the turn when anything but the token changes', async () => {
      const a = await setup()
      const p = await prepare(a.id), bytes = readFileSync(p.path!, 'utf8')
      const turn = turnLock.acquireShared(a.id, 'running-turn')
      g.token = 'ya29.google-token-CCC333'; g.scope = 'https://www.googleapis.com/auth/gmail.modify'
      await relist([gmail('g-1', { revision: 'g2' })]); await sleep(); await sleep()
      expect(readFileSync(p.path!, 'utf8')).toBe(bytes)
      g.scope = 'https://www.googleapis.com/auth/gmail.readonly'
      await relist([gmail('g-1', { revision: 'g3', name: 'Renamed' })]); await sleep(); await sleep()
      expect(readFileSync(p.path!, 'utf8')).toBe(bytes)
      turn.release()
      await vi.waitFor(() => expect(file(p.path!)[0]).toMatchObject({ name: 'Renamed', credential_data: { access_token: 'ya29.google-token-CCC333' } }))
    })
  })

  describe('connect flow', () => {
    it('creates on Core, opens the browser, polls, and attaches the ready record beside what is attached', async () => {
      const a = await setup([plain(), gmail('g-new', { oauth_status: 'pending_authorization', granted_user_email: null })], ['plain'])
      world.oauthCreate.mockResolvedValue(authorized('g-new'))
      const flow = await service.createOAuth(a.id, acc, 'gmail_oauth_readonly')
      expect(flow).toMatchObject({ agentId: a.id, group: acc, type: 'gmail_oauth_readonly', credentialId: 'g-new', reconnect: false, state: 'waiting', error: null })
      expect(world.oauthCreate).toHaveBeenCalledWith('account-a', 'gmail_oauth_readonly', expect.anything())
      expect(world.open).toHaveBeenCalledWith('https://accounts.google.com/o/oauth2/auth?state=fixture-state-g-new')
      // The consent URL stays in main.
      expect(JSON.stringify([flow, service.oauthFlow(a.id)])).not.toContain('fixture-state')
      await sleep(); await sleep()
      expect(flowState(a.id)).toBe('waiting')
      world.metadata = [plain(), gmail('g-new', { revision: 'g2' })]
      await vi.waitFor(() => expect(flowState(a.id)).toBe('attached'), { timeout: 3000 })
      expect(service.attachments(a.id).map(d => [d.ref, d.state])).toEqual([['plain', 'ready'], ['g-new', 'ready']])
      const p = await prepare(a.id)
      expect(file(p.path!).map(e => e.id)).toEqual(['plain', 'g-new'])
      service.cancelOAuth(a.id, flow.id)
      expect(service.oauthFlow(a.id)).toBeNull()
    })

    it('polls lightly: an unchanged list announces nothing, fetches nothing and queues no regeneration', async () => {
      const a = await setup([plain(), gmail('g-new', { oauth_status: 'pending_authorization', granted_user_email: null })], ['plain'])
      world.oauthCreate.mockResolvedValue(authorized('g-new'))
      await service.createOAuth(a.id, acc, 'gmail_oauth_readonly')
      await sleep()
      const events = vi.mocked(publishEvent), locks = vi.spyOn(turnLock, 'withQueuedLock')
      try {
        events.mockClear(); world.fetch.mockClear()
        const calls = world.list.mock.calls.length
        await vi.waitFor(() => expect(world.list.mock.calls.length).toBeGreaterThanOrEqual(calls + 3), { timeout: 3000 })
        expect(events).not.toHaveBeenCalled()
        expect(locks).not.toHaveBeenCalled()
        expect(world.fetch).not.toHaveBeenCalled()
      } finally { locks.mockRestore() }
      world.metadata = [plain(), gmail('g-new', { revision: 'g2' })]
      await vi.waitFor(() => expect(flowState(a.id)).toBe('attached'), { timeout: 3000 })
      expect(events.mock.calls.some(([name]) => name === SERVICE_CREDENTIALS_CHANGED)).toBe(true)
      expect(service.attachments(a.id).map(d => [d.ref, d.state])).toEqual([['plain', 'ready'], ['g-new', 'ready']])
    })

    it('announces a replaced flow gone when the new start fails, refused or unreachable', async () => {
      const a = await setup([gmail('g-new', { oauth_status: 'pending_authorization' })], [])
      const events = vi.mocked(publishEvent)
      const announced = () => events.mock.calls.filter(([name]) => name === SERVICE_CREDENTIALS_CHANGED).length
      for (const fail of [
        () => world.oauthCreate.mockResolvedValueOnce({ status: 503, ok: false, body: { detail: { code: 'oauth_not_configured', message: 'Not configured.' } } }),
        () => world.oauthCreate.mockRejectedValueOnce(new Error('offline'))
      ]) {
        world.oauthCreate.mockResolvedValueOnce(authorized('g-new'))
        await service.createOAuth(a.id, acc, 'gmail_oauth_readonly')
        expect(flowState(a.id)).toBe('waiting')
        fail(); events.mockClear()
        await expect(service.createOAuth(a.id, acc, 'gmail_oauth_readonly')).rejects.toHaveProperty('code')
        expect(service.oauthFlow(a.id)).toBeNull()
        expect(announced()).toBe(1)
      }
    })

    it('cancel stops polling, attaches nothing and leaves the record on Core', async () => {
      const a = await setup([gmail('g-new', { oauth_status: 'pending_authorization' })], [])
      world.oauthCreate.mockResolvedValue(authorized('g-new'))
      const flow = await service.createOAuth(a.id, acc, 'gmail_oauth_readonly')
      await sleep()
      service.cancelOAuth(a.id, flow.id)
      expect(service.oauthFlow(a.id)).toBeNull()
      world.metadata = [gmail('g-new', { revision: 'g2' })]
      const calls = world.list.mock.calls.length
      await sleep(); await sleep(); await sleep()
      expect(world.list.mock.calls.length).toBe(calls)
      expect(service.attachments(a.id)).toEqual([])
      await expect(service.reopenOAuth(a.id, flow.id)).rejects.toMatchObject({ code: 'flow_not_found' })
    })

    it('fails with timeout once the window closes, and a new flow replaces an old one', async () => {
      const a = await setup([gmail('g-new', { oauth_status: 'pending_authorization' })], [])
      world.oauthCreate.mockResolvedValue(authorized('g-new'))
      oauthFlowTiming.windowMs = 80
      const first = await service.createOAuth(a.id, acc, 'gmail_oauth_readonly')
      await vi.waitFor(() => expect(service.oauthFlow(a.id)).toMatchObject({ id: first.id, state: 'failed', error: { code: 'timeout' } }), { timeout: 3000 })
      oauthFlowTiming.windowMs = 600_000
      const second = await service.createOAuth(a.id, acc, 'gmail_oauth_readonly')
      expect(service.oauthFlow(a.id)).toMatchObject({ id: second.id, state: 'waiting' })
      await service.reopenOAuth(a.id, second.id)
      expect(world.open).toHaveBeenCalledTimes(3)
      service.cancelOAuth(a.id, first.id)
      expect(service.oauthFlow(a.id)?.id).toBe(second.id)
    })

    it('returns Core’s refusal and bad input as coded errors, with no flow', async () => {
      const a = await setup([], [])
      world.oauthCreate.mockResolvedValue({ status: 503, ok: false, body: { detail: { code: 'oauth_not_configured', message: 'Google OAuth is not configured on this platform. Ask an administrator.' } } })
      await expect(service.createOAuth(a.id, acc, 'gmail_oauth')).rejects.toMatchObject({ code: 'oauth_not_configured', message: 'Google OAuth is not configured on this platform. Ask an administrator.' })
      world.oauthCreate.mockResolvedValue({ status: 429, ok: false, body: { detail: 'Too many requests' } })
      await expect(service.createOAuth(a.id, acc, 'gmail_oauth')).rejects.toMatchObject({ code: 'rate_limited' })
      world.oauthCreate.mockResolvedValue({ status: 201, ok: true, body: { credential_id: 'g-x', authorization_url: 'javascript:alert(1)', expires_at: now() + 600 } })
      await expect(service.createOAuth(a.id, acc, 'gmail_oauth')).rejects.toMatchObject({ code: 'invalid_response' })
      await expect(service.createOAuth(a.id, 'local', 'gmail_oauth')).rejects.toMatchObject({ code: 'invalid_group' })
      await expect(service.createOAuth(a.id, acc, 'api_token')).rejects.toMatchObject({ code: 'unsupported_type' })
      await expect(service.createOAuth(a.id, 'ffffffffffffffff', 'gmail_oauth')).rejects.toMatchObject({ code: 'account_unavailable' })
      expect(service.oauthFlow(a.id)).toBeNull()
      expect(world.open).not.toHaveBeenCalled()
    })

    it('reconnects an attached record and regenerates it once Core reports a new grant', async () => {
      const a = await setup([gmail('g-1', { oauth_status: 'reauth_required' })])
      world.oauthAuthorize.mockResolvedValue(authorized('g-1'))
      await expect(service.reconnectOAuth(a.id, acc, 'g-2')).rejects.toMatchObject({ code: 'not_attached' })
      const flow = await service.reconnectOAuth(a.id, acc, 'g-1')
      expect(flow).toMatchObject({ reconnect: true, credentialId: 'g-1', type: 'gmail_oauth_readonly', state: 'waiting' })
      expect(world.oauthAuthorize).toHaveBeenCalledWith('account-a', 'g-1', expect.anything())
      world.metadata = [gmail('g-1', { revision: 'g2' })]
      await vi.waitFor(() => expect(flowState(a.id)).toBe('attached'), { timeout: 3000 })
      expect(service.attachments(a.id).map(d => [d.ref, d.state])).toEqual([['g-1', 'ready']])
    })
  })

  describe('token endpoint', () => {
    const ask = (endpoint: { url: string; token: string }, id = 'g-1', bearer = endpoint.token, body: unknown = { min_ttl: 600, known_expires_at: g.expires }) =>
      fetch(`${endpoint.url}/${id}/access-token`, { method: 'POST', headers: { authorization: `Bearer ${bearer}`, 'content-type': 'application/json' }, body: JSON.stringify(body) })
    const python = (code: string, env: Record<string, string>) => run('python3', ['-I', '-B', '-c', `import sys; sys.path.insert(0, ${JSON.stringify(shim)})
from core.cinna_api import credentials, CredentialRefreshError
try:
    print(credentials.access_token(${code}))
except CredentialRefreshError as e:
    print('error', e.code, str(e))`], { env: { PATH: process.env.PATH ?? '', ...env } }).then(r => r.stdout.trim())
    async function ready(items: any[] = [gmail(), plain()], refs = ['g-1', 'plain']) {
      const a = await setup(items, refs)
      const p = await prepare(a.id)
      expect(p.tokenEndpoint?.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/credentials$/)
      return { a, p, endpoint: p.tokenEndpoint! }
    }

    it('is offered only to an agent with a Google record attached, with one bearer for the session', async () => {
      world.metadata = [gmail(), plain()]
      const other = addAgent('bare')
      const { a, endpoint } = await ready()
      await service.setAttachments(other.id, acc, ['plain'])
      expect((await prepare(other.id)).tokenEndpoint).toBeUndefined()
      expect((await prepare(a.id)).tokenEndpoint).toEqual(endpoint)
      expect(redactCredentialText(`bearer ${endpoint.token}`)).toBe('bearer ***REDACTED***')
      expect(engineCredentialEnv({ CINNA_CREDENTIALS_TOKEN: 'stale', CINNA_CREDENTIALS_TOKEN_URL: 'stale' }, { skillRuntime: false })).toEqual({})
      expect(engineCredentialEnv({}, { skillRuntime: false, tokenEndpoint: endpoint })).toEqual({ CINNA_CREDENTIALS_TOKEN_URL: endpoint.url, CINNA_CREDENTIALS_TOKEN: endpoint.token })
    })

    it('refuses a wrong bearer and an ended turn with 401, and an unattached or non-Google record with 404', async () => {
      world.metadata = [gmail(), gmail('g-2'), plain()]
      const { a, endpoint } = await ready(world.metadata, ['g-1', 'plain'])
      expect((await ask(endpoint)).status).toBe(401) // no turn holds the agent
      const turn = turnLock.acquireShared(a.id, 'running-turn')
      try {
        expect((await ask(endpoint, 'g-1', 'x'.repeat(endpoint.token.length))).status).toBe(401)
        for (const id of ['g-2', 'plain', 'unknown']) {
          const res = await ask(endpoint, id)
          expect(res.status).toBe(404)
          expect((await res.json()).detail.code).toBe('credential_not_linked')
        }
        expect(world.accessToken).not.toHaveBeenCalled()
      } finally { turn.release() }
      const editor = turnLock.acquire(a.id, 'editor')
      try { expect((await ask(endpoint)).status).toBe(401) } finally { editor.release() }
    })

    it('asks Core, rewrites the cached row and credentials.json before answering, mid-turn', async () => {
      const { a, p, endpoint } = await ready()
      const fresh = now() + 3599
      world.accessToken.mockResolvedValue({ status: 200, ok: true, body: { access_token: 'ya29.renewed-DDD444', token_type: 'Bearer', expires_at: fresh, refreshed: true } })
      const turn = turnLock.acquireShared(a.id, 'running-turn')
      try {
        const res = await ask(endpoint)
        expect(res.status).toBe(200)
        expect(res.headers.get('cache-control')).toBe('no-store')
        expect(await res.json()).toEqual({ access_token: 'ya29.renewed-DDD444', token_type: 'Bearer', expires_at: fresh, refreshed: true })
        expect(world.accessToken).toHaveBeenCalledWith('account-a', 'g-1', { min_ttl: 600, known_expires_at: g.expires }, expect.anything())
        expect(file(p.path!).find(e => e.id === 'g-1').credential_data).toMatchObject({ access_token: 'ya29.renewed-DDD444', expires_at: fresh, scope: g.scope })
        expect(service.attachments(a.id)[0].credential).toMatchObject({ expiresAt: fresh * 1000, hasValues: true })
        expect(redactCredentialText('ya29.renewed-DDD444')).toBe('***REDACTED***')
      } finally { turn.release() }
    })

    it('mirrors Core’s coded refusal, records a lost grant, and answers 503 without a code when Core is unreachable', async () => {
      const { a, p, endpoint } = await ready()
      const turn = turnLock.acquireShared(a.id, 'running-turn')
      try {
        world.accessToken.mockRejectedValue(Object.assign(new Error('offline'), { code: 'request_failed' }))
        const offline = await ask(endpoint)
        expect(offline.status).toBe(503)
        expect((await offline.json()).detail).toBe('Cinna could not be reached.')
        world.accessToken.mockResolvedValue({ status: 502, ok: false, body: { detail: { code: 'refresh_in_progress', message: 'busy' } }, retryAfter: '1' })
        const busy = await ask(endpoint)
        expect([busy.status, busy.headers.get('retry-after'), (await busy.json()).detail.code]).toEqual([502, '1', 'refresh_in_progress'])
        world.accessToken.mockResolvedValue({ status: 409, ok: false, body: { detail: { code: 'reauthorization_required', message: 'Google no longer accepts it.' } } })
        const res = await ask(endpoint)
        expect(res.status).toBe(409)
        expect(await res.json()).toEqual({ detail: { code: 'reauthorization_required', message: 'Google no longer accepts it.' } })
        expect(service.attachments(a.id)[0].state).toBe('reauth_required')
        await vi.waitFor(() => expect(file(p.path!)[0]).toMatchObject({ unavailable_reason: 'reauthorization_required' }))
      } finally { turn.release() }
    })

    it('is what the skill runtime’s access_token calls: endpoint, coded error, retry, and fallback', async () => {
      g.expires = now() + 120 // short of the default min_ttl (300), so the helper asks
      const { a, p, endpoint } = await ready()
      const env = engineCredentialEnv({}, { path: p.path!, skillRuntime: false, tokenEndpoint: endpoint })
      const turn = turnLock.acquireShared(a.id, 'running-turn')
      try {
        world.accessToken.mockResolvedValue({ status: 200, ok: true, body: { access_token: 'ya29.from-endpoint-EEE555', token_type: 'Bearer', expires_at: now() + 900, refreshed: true } })
        expect(await python("'g-1'", env)).toBe('ya29.from-endpoint-EEE555')
        // The file was rewritten before the answer: the next call needs no network.
        world.accessToken.mockClear()
        expect(await python("'g-1'", env)).toBe('ya29.from-endpoint-EEE555')
        expect(world.accessToken).not.toHaveBeenCalled()
        expect(await python("'g-1', min_ttl=1800", env)).toBe('ya29.from-endpoint-EEE555') // 900 s left: asks again
        expect(world.accessToken).toHaveBeenCalledTimes(1)
        world.accessToken.mockResolvedValueOnce({ status: 502, ok: false, body: { detail: { code: 'refresh_in_progress', message: 'busy' } } })
          .mockResolvedValueOnce({ status: 200, ok: true, body: { access_token: 'ya29.after-retry-FFF666', token_type: 'Bearer', expires_at: now() + 900, refreshed: true } })
        expect(await python("'g-1', min_ttl=1800", env)).toBe('ya29.after-retry-FFF666')
        world.accessToken.mockResolvedValue({ status: 502, ok: false, body: { detail: { code: 'provider_error', message: 'Google said no' } } })
        expect(await python("'g-1', min_ttl=1800", env)).toMatch(/^error provider_error provider_error: Google could not issue/)
        // Cinna unreachable: the synced token while it lasts.
        world.accessToken.mockRejectedValue(Object.assign(new Error('offline'), { code: 'request_failed' }))
        expect(await python("'g-1', min_ttl=1800", env)).toBe('ya29.after-retry-FFF666')
        // A refused bearer: the synced token while it has any life left (Desktop's departure from Core's helper).
        expect(await python("'g-1', min_ttl=1800", { ...env, CINNA_CREDENTIALS_TOKEN: 'wrong' })).toBe('ya29.after-retry-FFF666')
      } finally { turn.release() }
      // Without the endpoint: the synced token only while it has min_ttl left (the previous behaviour).
      expect(await python("'g-1'", { CINNA_CREDENTIALS_PATH: p.path! })).toBe('ya29.after-retry-FFF666')
      expect(await python("'g-1', min_ttl=1800", { CINNA_CREDENTIALS_PATH: p.path! })).toMatch(/^error unavailable /)
      expect(await python("'g-1', min_ttl=1800", { CINNA_CREDENTIALS_PATH: p.path!, CINNA_CREDENTIALS_TOKEN_URL: endpoint.url, CINNA_CREDENTIALS_TOKEN: endpoint.token })).toBe('ya29.after-retry-FFF666')
    }, 20_000)

    it('is called directly, never through the user\'s http_proxy', async () => {
      g.expires = now() + 120
      const { a, p, endpoint } = await ready()
      const seen: string[] = []
      const proxy = createServer((req, res) => { seen.push(`${req.method} ${req.url}`); res.writeHead(502); res.end() })
      await new Promise<void>(resolve => proxy.listen(0, '127.0.0.1', resolve))
      const via = `http://127.0.0.1:${(proxy.address() as AddressInfo).port}`
      const env = { ...engineCredentialEnv({}, { path: p.path!, skillRuntime: false, tokenEndpoint: endpoint }), http_proxy: via, HTTP_PROXY: via, all_proxy: via, ALL_PROXY: via }
      const turn = turnLock.acquireShared(a.id, 'running-turn')
      try {
        world.accessToken.mockResolvedValue({ status: 200, ok: true, body: { access_token: 'ya29.direct-GGG777', token_type: 'Bearer', expires_at: now() + 900, refreshed: true } })
        expect(await python("'g-1'", env)).toBe('ya29.direct-GGG777')
        expect(world.accessToken).toHaveBeenCalledTimes(1)
        expect(seen).toEqual([])
      } finally { turn.release(); await new Promise(resolve => proxy.close(resolve)) }
    }, 20_000)

    it('falls back to the synced token on a 401 while it has any life left, and says unauthorized once it has none', async () => {
      g.expires = now() + 120
      const { p, endpoint } = await ready()
      const env = engineCredentialEnv({}, { path: p.path!, skillRuntime: false, tokenEndpoint: endpoint })
      // No turn holds the agent (a child process outliving its turn): 401.
      expect(await python("'g-1'", env)).toBe(g.token)
      const expired = join(world.home, 'expired.json')
      writeFileSync(expired, JSON.stringify(file(p.path!).map(e => e.id === 'g-1' ? { ...e, credential_data: { ...e.credential_data, expires_at: now() - 10 } } : e)))
      expect(await python("'g-1'", { ...env, CINNA_CREDENTIALS_PATH: expired })).toMatch(/^error unauthorized unauthorized: Cinna Desktop did not accept/)
      expect(world.accessToken).not.toHaveBeenCalled()
    }, 20_000)

    it('answers within the reply wait when a turn\'s preparation holds the file, and the write lands later', async () => {
      g.expires = now() + 120 // a turn start re-fetches it, inside the chain
      tokenTiming.replyWaitMs = 100
      const { a, p, endpoint } = await ready()
      let release: (value: unknown) => void = () => {}
      world.fetch.mockImplementationOnce(() => new Promise(resolve => { release = resolve }))
      const turn = turnLock.acquireShared(a.id, 'running-turn')
      try {
        const blocked = prepare(a.id)
        await vi.waitFor(() => expect(world.fetch).toHaveBeenCalledTimes(2))
        const fresh = now() + 3599
        world.accessToken.mockResolvedValue({ status: 200, ok: true, body: { access_token: 'ya29.unblocked-HHH888', token_type: 'Bearer', expires_at: fresh, refreshed: true } })
        const answered = await Promise.race([ask(endpoint).then(res => res.json()), new Promise(resolve => setTimeout(() => resolve('stuck'), 1_500))])
        expect(answered).toMatchObject({ access_token: 'ya29.unblocked-HHH888', expires_at: fresh })
        expect(file(p.path!).find(e => e.id === 'g-1').credential_data.access_token).toBe(g.token)
        release({ items: [], refused: [{ id: 'g-1', reason: 'token_unavailable' }], current_user: null, owner_identity: null })
        await blocked
        await vi.waitFor(() => expect(file(p.path!).find(e => e.id === 'g-1').credential_data).toMatchObject({ access_token: 'ya29.unblocked-HHH888', expires_at: fresh }))
      } finally { release({ items: [], refused: [], current_user: null, owner_identity: null }); turn.release() }
    })

    it('keeps a newer token the endpoint stored over an older delivery that lands after it', async () => {
      g.expires = now() + 120
      tokenTiming.replyWaitMs = 100
      const { a, p, endpoint } = await ready()
      let release: (value: unknown) => void = () => {}
      world.fetch.mockImplementationOnce(() => new Promise(resolve => { release = resolve }))
      const turn = turnLock.acquireShared(a.id, 'running-turn')
      try {
        const blocked = prepare(a.id)
        await vi.waitFor(() => expect(world.fetch).toHaveBeenCalledTimes(2))
        const fresh = now() + 3599
        world.accessToken.mockResolvedValue({ status: 200, ok: true, body: { access_token: 'ya29.newer-JJJ000', token_type: 'Bearer', expires_at: fresh, refreshed: true } })
        await ask(endpoint)
        const meta = world.metadata.find(m => m.id === 'g-1')
        release({ items: [{ id: 'g-1', revision: meta.revision, entry: { ...deliveredG('g-1', meta), credential_data: { ...deliveredG('g-1', meta).credential_data, access_token: 'ya29.older-III999', expires_at: now() + 1800 } }, service_account_file: null, ssh_key: null }], refused: [], current_user: null, owner_identity: null })
        await blocked
        await vi.waitFor(() => expect(file(p.path!).find(e => e.id === 'g-1').credential_data).toMatchObject({ access_token: 'ya29.newer-JJJ000', expires_at: fresh }))
        expect(file((await prepare(a.id)).path!).find(e => e.id === 'g-1').credential_data.access_token).toBe('ya29.newer-JJJ000')
      } finally { release({ items: [], refused: [], current_user: null, owner_identity: null }); turn.release() }
    })
  })
})
