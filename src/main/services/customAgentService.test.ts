import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createTestDatabase, type TestDatabase } from '../db/testSupport/nodeSqlite'
import { createFakeAcp, type FakeAcp, type FakeAcpScript } from '../agents/drivers/acp/testSupport/fakeAcp'
import { fakeRemoteAcp } from '../agents/drivers/acp/testSupport/fakeRemoteAcp'
import type { CustomAgentConfig } from '../../shared/customAgents'

const state = vi.hoisted(() => ({ db: null as TestDatabase | null, profile: '__default__', root: '' }))
vi.mock('../db/client', () => ({ getDb: () => state.db!.db, getRawSqlite: () => state.db!.sqlite }))
vi.mock('../logger/logger', () => ({ createLogger: () => ({ debug() {}, info() {}, warn() {}, error() {} }) }))
vi.mock('electron', () => ({ app: { getPath: () => state.root }, safeStorage: { isEncryptionAvailable: () => true, encryptString: (value: string) => Buffer.from(value.split('').reverse().join('')), decryptString: (value: Buffer) => value.toString().split('').reverse().join('') } }))
vi.mock('../auth/scope', () => ({ getProfileScopeUserId: () => state.profile, getSettingsScopeUserId: () => '__default__' }))
vi.mock('../shell/env', async () => ({ ...(await import('../shell/envMerge')), getShellEnv: async () => ({ PATH: '/usr/bin:/bin', HOME: state.root, SSH_AUTH_SOCK: '/tmp/fixture-agent.sock', ANTHROPIC_API_KEY: 'must-not-inherit' }) }))
vi.mock('./agentReadinessService', () => ({ agentReadinessService: { forget: vi.fn() } }))
const { customAgentService } = await import('./customAgentService')
const { agentRepo, agentSessionRepo } = await import('../db/agents')
const { desktopStateService, externalRuntimeStatePath } = await import('./localAgents/desktopStateService')
const { turnLock } = await import('./localAgents/turnLock')
const { acpProcessPool } = await import('../agents/drivers/acp/acpPool')
const fakes: FakeAcp[] = []
const OWNER = '__default__'
const ask = { action: 'bash', resources: ['printf exact'], savable: [] }
const quote = (value: string): string => `'${value.replace(/'/g, "'\\''")}'`
function fixture(script: FakeAcpScript = {}): { fake: FakeAcp; config: CustomAgentConfig } {
  const fake = createFakeAcp(script); fakes.push(fake)
  const exports = Object.entries(fake.spec.env).map(([key, value]) => `export ${key}=${quote(value)}`).join('; ')
  return { fake, config: { launcher: 'custom', command: ['/bin/sh', '-c', `${exports}; exec "$@"`, 'fixture', fake.spec.command, ...fake.spec.args], cwd: '/remote/not-on-this-machine', localCwd: fake.spec.cwd } }
}
beforeEach(() => {
  state.root = mkdtempSync(join(tmpdir(), 'custom-service-')); state.profile = OWNER; state.db = createTestDatabase()
  state.db.raw.exec("INSERT INTO users(id,username,display_name,created_at) VALUES('other','other','Other',1)")
  state.db.raw.exec("INSERT INTO chats(id,user_id,title,created_at,updated_at) VALUES('chat','__default__','Owned',1,1),('new-chat','__default__','New',1,1),('foreign-chat','other','Foreign',1,1)")
})
afterEach(async () => {
  await acpProcessPool.shutdown(); turnLock.releaseAll()
  for (const fake of fakes.splice(0)) fake.cleanup()
  state.db?.close(); state.db = null; rmSync(state.root, { recursive: true, force: true }); vi.restoreAllMocks()
})
function row(config: CustomAgentConfig) { return agentRepo.createRuntime(OWNER, { name: 'Command', driver: 'acp', config: { ...config } }) }

describe('custom command state with real SQLite and external files', () => {
  it.each(['folder', 'remote'] as const)('rejects %s rows with cached custom configuration before execution or management', async (source) => {
    const { fake, config } = fixture(), agent = row(config)
    const captured = customAgentService.runtime(OWNER, agent)
    state.db!.raw.prepare('UPDATE agents SET source = ? WHERE id = ?').run(source, agent.id)
    expect(() => customAgentService.configuration(agent.id)).toThrow(/not found/)
    expect(() => customAgentService.revokeGrant(agent.id, 'exact')).toThrow(/not found/)
    expect(() => customAgentService.runtime(OWNER, agent)).toThrow(/not found/)
    expect(() => captured.saveSession('chat', 'stale')).toThrow(/changed/)
    await expect(customAgentService.test({ id: agent.id, config })).rejects.toThrow(/not found/)
    expect(fake.received('initialize')).toHaveLength(0)
  })
  it('stores and resumes only the captured revision, preserving a repairable generic mirror', () => {
    const { config } = fixture(); const agent = row(config)
    const runtime = customAgentService.runtime(OWNER, agent)
    expect(runtime.readSession('chat')).toBeNull()
    runtime.saveSession('chat', 'session-one'); runtime.rememberGrant(ask)
    expect(customAgentService.runtime(OWNER, agent).readSession('chat')).toBe('session-one')
    expect(runtime.isGranted(ask)).toBe(true)
    expect(agentSessionRepo.getByChatAndAgent('chat', agent.id)?.contextId).toBe('session-one')
    const path = externalRuntimeStatePath(customAgentService.stateKey(OWNER, agent))
    expect(path).toContain(join(state.root, 'external-agents', 'runtime-'))
    expect(JSON.parse(readFileSync(path, 'utf8')).sessions.chat.sessionId).toBe('session-one')
    const newer = agentRepo.updateRuntime(OWNER, agent.id, 'acp', { name: 'Changed', config: { ...config, cwd: '/remote/new' } })
    const next = customAgentService.runtime(OWNER, newer)
    expect(() => next.readSession('chat')).toThrow(/earlier ACP configuration/)
    expect(next.readSession('new-chat')).toBeNull(); expect(next.isGranted(ask)).toBe(false)
    expect(() => runtime.saveSession('chat', 'late-old')).toThrow(/changed/)
    expect(() => runtime.rememberGrant(ask)).toThrow(/changed/)
    expect(agentSessionRepo.getByChatAndAgent('chat', agent.id)?.contextId).toBe('session-one')
  })
  it.each(['profile', 'chat', 'agent', 'disabled', 'disable-enable'] as const)('rejects late session and grant authority after %s changes', (change) => {
    const agent = row(fixture().config), runtime = customAgentService.runtime(OWNER, agent)
    if (change === 'profile') state.profile = 'other'
    if (change === 'chat') state.db!.raw.exec("DELETE FROM chats WHERE id='chat'")
    if (change === 'agent') agentRepo.delete(OWNER, agent.id)
    if (change === 'disabled' || change === 'disable-enable') agentRepo.update(OWNER, agent.id, { enabled: false })
    if (change === 'disable-enable') agentRepo.update(OWNER, agent.id, { enabled: true })
    expect(() => runtime.saveSession('chat', 'late')).toThrow()
    if (change !== 'chat') expect(() => runtime.rememberGrant(ask)).toThrow()
    expect(agentSessionRepo.getByChatAndAgent('chat', agent.id)).toBeUndefined()
  })
  it('rejects foreign/missing chat reads before returning continuity', () => {
    const agent = row(fixture().config), runtime = customAgentService.runtime(OWNER, agent)
    expect(() => runtime.readSession('foreign-chat')).toThrow(/conversation/)
    expect(() => runtime.readSession('missing')).toThrow(/conversation/)
  })
  it('opens disabled configurations and revokes their current saved grants', () => {
    const agent = row(fixture().config)
    const disabled = agentRepo.update(OWNER, agent.id, { enabled: false })!
    const key = customAgentService.stateKey(OWNER, disabled)
    desktopStateService.patchExternal(key, { permissionGrants: { exact: { action: 'bash', pattern: 'printf exact', scope: 'exact', decidedAt: 1 } } })
    expect(customAgentService.configuration(agent.id).grants).toHaveLength(1)
    customAgentService.revokeGrant(agent.id, 'exact')
    expect(customAgentService.configuration(agent.id).grants).toEqual([])
  })
  it('does not write a generic session when external state cannot be written', () => {
    const agent = row(fixture().config), runtime = customAgentService.runtime(OWNER, agent)
    vi.spyOn(desktopStateService, 'patchExternal').mockImplementation(() => { throw new Error('disk full') })
    expect(() => runtime.saveSession('chat', 'unbound')).toThrow('disk full')
    expect(agentSessionRepo.getByChatAndAgent('chat', agent.id)).toBeUndefined()
  })
})

describe('real initialize-only test receipts', () => {
  it('initializes, disposes and saves once without prompting, then never probes on a list read', async () => {
    const { fake, config } = fixture({ initialize: { response: { agentInfo: { name: 'Peer', version: '1' }, authMethods: [{ id: 'login', name: 'CLI login' }] } } })
    const tested = await customAgentService.test({ config })
    expect(tested).toMatchObject({ name: 'Peer', authMethods: [{ id: 'login', name: 'CLI login' }] })
    expect(fake.received('initialize')).toHaveLength(1)
    expect(fake.received('session/new')).toHaveLength(0); expect(fake.received('session/prompt')).toHaveLength(0)
    const start = fake.log().find((entry) => entry.dir === 'start')!
    expect(start.env?.ANTHROPIC_API_KEY).toBeUndefined()
    expect(start.env?.SSH_AUTH_SOCK).toBe('/tmp/fixture-agent.sock')
    expect(() => process.kill(start.pid!, 0)).toThrow()
    const saved = customAgentService.save({ config, testToken: tested.token })
    expect(() => customAgentService.save({ config, testToken: tested.token })).toThrow(/Test this exact/)
    const runtime = customAgentService.runtime(OWNER, agentRepo.getOwned(OWNER, saved.id)!)
    if (runtime.type !== 'external') throw new Error('Wrong runtime')
    expect(await runtime.readiness()).toEqual({ state: 'ok', reason: null })
    expect(fake.received('initialize')).toHaveLength(1)
  })
  it('retains the latest failed explicit probe across ordinary list readiness reads', async () => {
    const { fake, config } = fixture(), agent = row(config)
    await customAgentService.test({ id: agent.id, config })
    const runtime = customAgentService.runtime(OWNER, agent)
    if (runtime.type !== 'external') throw new Error('Wrong runtime')
    expect(await runtime.readiness()).toEqual({ state: 'ok', reason: null })
    writeFileSync(fake.spec.env.FAKE_ACP_SCRIPT, JSON.stringify({ initialize: { error: { code: -32000, message: 'Peer intentionally unavailable' } } }))
    await expect(customAgentService.test({ id: agent.id, config })).rejects.toThrow(/intentionally unavailable/)
    for (let i = 0; i < 3; i++) expect(await runtime.readiness()).toMatchObject({ state: 'unreachable', reason: expect.stringContaining('intentionally unavailable') })
    expect(fake.received('initialize')).toHaveLength(2)
  })
  it.each(['delete', 'replace'] as const)('disposes a pending probe after the saved command is changed: %s', async (change) => {
    const { fake, config } = fixture({ initialize: { hang: true } }), agent = row(config)
    const tested = customAgentService.test({ id: agent.id, config })
    const rejected = expect(tested).rejects.toThrow(/canceled|changed/)
    await vi.waitFor(() => expect(fake.received('initialize')).toHaveLength(1))
    const start = fake.log().find((entry) => entry.dir === 'start')!
    if (change === 'delete') agentRepo.delete(OWNER, agent.id)
    else agentRepo.updateRuntime(OWNER, agent.id, 'acp', { name: 'Newer', config: { ...config, cwd: '/new' } })
    await rejected
    expect(() => process.kill(start.pid!, 0)).toThrow()
  })
  it('refuses a test receipt for a different config, profile or stale edited row', async () => {
    const { config } = fixture(), agent = row(config)
    const tested = await customAgentService.test({ id: agent.id, config })
    expect(() => customAgentService.save({ id: agent.id, config: { ...config, cwd: '/changed' }, testToken: tested.token })).toThrow(/Test this exact/)
    state.profile = 'other'
    expect(() => customAgentService.save({ id: agent.id, config, testToken: tested.token })).toThrow(/Test this exact/)
    state.profile = OWNER
    agentRepo.updateRuntime(OWNER, agent.id, 'acp', { name: 'Newer', config: { ...config } })
    expect(() => customAgentService.save({ id: agent.id, config, testToken: tested.token })).toThrow(/changed after/)
  })
  it('refuses busy Test and Save while preserving the saved configuration', async () => {
    const { config } = fixture(), agent = row(config)
    const tested = await customAgentService.test({ id: agent.id, config })
    const lock = turnLock.acquire(agent.id, 'turn')
    await expect(customAgentService.test({ id: agent.id, config })).rejects.toThrow(/busy/)
    expect(() => customAgentService.save({ id: agent.id, config, testToken: tested.token })).toThrow(/busy/)
    lock.release()
    expect(customAgentService.save({ id: agent.id, config, testToken: tested.token }).id).toBe(agent.id)
  })
  it('aborts and reaps a silent test when the active profile changes', async () => {
    const { fake, config } = fixture({ initialize: { hang: true } })
    const tested = customAgentService.test({ config })
    const rejected = expect(tested).rejects.toThrow(/canceled|superseded|profile/)
    await vi.waitFor(() => expect(fake.received('initialize')).toHaveLength(1))
    const start = fake.log().find((entry) => entry.dir === 'start')!
    state.profile = 'other'
    await rejected
    expect(() => process.kill(start.pid!, 0)).toThrow()
  })
})


describe('remote ACP credentials and saved state', () => {
  it('tests without creating a session, stores a private token, and binds continuity to its revision', async () => {
    const peer = await fakeRemoteAcp({ token: 'acp_fixture_secret' })
    try {
      const config = { launcher: 'custom' as const, transport: 'websocket' as const, url: peer.url, cwd: '/app/workspace' }
      const tested = await customAgentService.test({ config, accessToken: 'acp_fixture_secret' })
      expect(peer.received('session/new')).toHaveLength(0)
      expect(() => customAgentService.save({ config, accessToken: 'changed', testToken: tested.token })).toThrow(/token changed/)
      const { id } = customAgentService.save({ config, accessToken: 'acp_fixture_secret', testToken: tested.token })
      const row = agentRepo.getOwned(OWNER, id)!
      expect(JSON.stringify(row.driverConfig)).not.toContain('acp_fixture_secret')
      expect(row.accessTokenEncrypted!.toString()).not.toContain('acp_fixture_secret')
      expect(customAgentService.configuration(id)).toMatchObject({ config, hasAccessToken: true })
      expect(JSON.stringify(customAgentService.configuration(id))).not.toContain('acp_fixture_secret')
      const runtime = customAgentService.runtime(OWNER, row)
      runtime.saveSession('chat', 'remote-session')
      runtime.rememberGrant(ask)
      expect(runtime.readSession('chat')).toBe('remote-session')
      await expect(customAgentService.test({ id, config, accessToken: 'wrong-replacement' })).rejects.toThrow()
      if (runtime.type !== 'external') throw new Error('Wrong runtime')
      expect(await runtime.readiness()).toEqual({ state: 'ok', reason: null })
      // Routine readiness reads do not open a network connection.
      const calls = peer.headers.length
      if (runtime.type !== 'external') throw new Error('Wrong runtime')
      await runtime.readiness()
      expect(peer.headers).toHaveLength(calls)
      // Retaining the token works without reading it back through IPC.
      const retest = await customAgentService.test({ id, config })
      customAgentService.save({ id, config, testToken: retest.token })
      expect(() => runtime.saveSession('chat', 'stale')).toThrow(/changed/)
      const next = customAgentService.runtime(OWNER, agentRepo.getOwned(OWNER, id)!)
      expect(() => next.readSession('chat')).toThrow(/earlier ACP configuration/)
      expect(next.isGranted(ask)).toBe(false)
      await expect(customAgentService.test({ id, config: { ...config, url: peer.url + '-other' } })).rejects.toThrow(/endpoint changed/)
      expect(peer.headers).toHaveLength(calls + 1)
    } finally { await peer.close() }
  })
  it('clears a saved token only after the anonymous configuration passes a new test', async () => {
    const peer = await fakeRemoteAcp()
    try {
      const config = { launcher: 'custom' as const, transport: 'websocket' as const, url: peer.url, cwd: '/app/workspace' }
      const tested = await customAgentService.test({ config, accessToken: 'old-token' })
      const { id } = customAgentService.save({ config, accessToken: 'old-token', testToken: tested.token })
      const cleared = await customAgentService.test({ id, config, accessToken: '' })
      expect(() => customAgentService.save({ id, config, testToken: cleared.token })).toThrow(/token changed/)
      customAgentService.save({ id, config, accessToken: '', testToken: cleared.token })
      expect(agentRepo.getOwned(OWNER, id)!.accessTokenEncrypted).toBeNull()
      expect(peer.headers.at(-1)?.authorization).toBeUndefined()
    } finally { await peer.close() }
  })
})
