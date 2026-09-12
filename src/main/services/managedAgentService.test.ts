import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createTestDatabase, type TestDatabase } from '../db/testSupport/nodeSqlite'
import type { AgentRow } from '../db/agents'
import type { ManagedAgentConfig } from '../../shared/managedAgents'

const state = vi.hoisted(() => ({ db: null as TestDatabase | null, profile: '__default__',
  handlers: new Map<string, (...args: unknown[]) => unknown>() }))
vi.mock('../db/client', () => ({ getDb: () => state.db!.db, getRawSqlite: () => state.db!.sqlite }))
vi.mock('../logger/logger', () => ({ createLogger: () => ({ debug() {}, info() {}, warn() {}, error() {} }) }))
vi.mock('../security/keystore', () => ({ decryptApiKey: (value: Buffer) => value.toString(), encryptApiKey: (value: string) => Buffer.from(value) }))
vi.mock('../auth/scope', () => ({ getProfileScopeUserId: () => state.profile, getSettingsScopeUserId: () => '__default__',
  getManagedResourceScopes: () => [...new Set(['__default__', state.profile])] }))
// Register the actual session IPC handler; unrelated handlers' services are not exercised.
vi.mock('../ipc/_wrap', () => ({ ipcHandle: (name: string, handler: (...args: unknown[]) => unknown) => state.handlers.set(name, handler) }))
vi.mock('../auth/activation', () => ({ userActivation: { requireActivated() {} } }))
vi.mock('./agentService', () => ({ agentService: {} }))
vi.mock('./a2aStreamingService', () => ({ a2aStreamingService: {} }))
vi.mock('./inboxService', () => ({ inboxService: {} }))
vi.mock('./askDelivery', () => ({ parseAnswerPayload: vi.fn() }))

const { managedAgentService } = await import('./managedAgentService')
const { managedAgentSessionRepo } = await import('../db/managedAgentSessions')
const { llmProviderRepo } = await import('../db/llmProviders')
const { agentRepo, agentSessionRepo } = await import('../db/agents')
const { registerA2AHandlers } = await import('../ipc/agent_a2a.ipc')
const OWNER = '__default__'
const KEY = 'sk-ant-api-synthetic-managed-secret'
let credentialId: string
let config: ManagedAgentConfig
let agent: AgentRow
let fetchSpy: ReturnType<typeof vi.fn>

beforeEach(() => {
  state.db = createTestDatabase(); state.profile = OWNER; state.handlers.clear()
  state.db.raw.exec("INSERT INTO users(id,username,display_name,created_at) VALUES('other','other','Other',1)")
  state.db.raw.exec("INSERT INTO chats(id,user_id,title,created_at,updated_at) VALUES('chat','__default__','Owned',1,1),('foreign-chat','other','Foreign',1,1)")
  credentialId = llmProviderRepo.upsert(OWNER, { type: 'anthropic', name: 'Managed credential', enabled: true,
    apiKeyEncrypted: Buffer.from(KEY) }).id
  config = { credentialId, agentId: 'managed-agent', environmentId: 'managed-environment', workspaceId: 'workspace', version: 1 }
  agent = agentRepo.createRuntime(OWNER, { name: 'Managed test agent', driver: 'managed', config: { ...config } })
  fetchSpy = vi.fn().mockRejectedValue(new Error('Unexpected HTTP in ownership test'))
  vi.stubGlobal('fetch', fetchSpy)
})
afterEach(() => { state.db?.close(); state.db = null; vi.unstubAllGlobals(); vi.restoreAllMocks() })
function prepare(chatId = 'chat') { return managedAgentService.prepare(OWNER, agent, chatId) }
function privateRows() { return state.db!.raw.prepare('SELECT * FROM managed_agent_sessions').all() }
function updateCredential(patch: Partial<Parameters<typeof llmProviderRepo.upsert>[1]>) {
  return llmProviderRepo.upsert(OWNER, { id: credentialId, type: 'anthropic', name: 'Managed credential', ...patch }).row
}
function expectNoPrivateRows() { expect(privateRows()).toEqual([]); expect(agentSessionRepo.getByChat('chat')).toBeUndefined() }

describe('Managed binding ownership and persistence through real SQLite', () => {
  it('refuses an edit whose remote validation completes after a newer local configuration was saved', async () => {
    let release!: (response: Response) => void
    fetchSpy.mockImplementationOnce(() => new Promise<Response>((resolve) => { release = resolve }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ id: config.environmentId })))
    const older = managedAgentService.save({ id: agent.id, name: 'Older edit', config })
    await vi.waitFor(() => expect(fetchSpy).toHaveBeenCalledTimes(1))
    agentRepo.updateRuntime(OWNER, agent.id, 'managed', { name: 'Newer edit', config: { ...config, environmentId: 'new-environment' } })
    release(new Response(JSON.stringify({ id: config.agentId, name: 'Remote' })))
    await expect(older).rejects.toThrow(/changed while/)
    expect(agentRepo.getOwned(OWNER, agent.id)).toMatchObject({ name: 'Newer edit', driverConfig: { environmentId: 'new-environment' } })
  })
  it('reuses the exact saved binding through fresh service preparation and stores every checkpoint state without new session identities', () => {
    const first = prepare()
    expect(first.checkpoint).toBeNull()
    for (const next of ['ready', 'inflight', 'uncertain', 'budget'] as const) {
      first.save({ sessionId: 'sesn_saved', state: next })
      expect(prepare().checkpoint).toEqual({ sessionId: 'sesn_saved', state: next })
      expect(privateRows()).toHaveLength(1)
      expect(agentSessionRepo.getByChatAndAgent('chat', agent.id)?.contextId).toBe('sesn_saved')
    }
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it.each(['foreign-chat', 'missing-chat'] as const)('refuses %s before returning a capability that can create orphan remote work', (chatId) => {
    expect(() => prepare(chatId)).toThrow()
    expectNoPrivateRows()
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it.each(['deleted chat', 'deleted agent', 'foreign agent owner'] as const)('refuses a held capability after %s and never writes an orphan checkpoint', (change) => {
    const held = prepare()
    if (change === 'deleted chat') state.db!.raw.prepare('DELETE FROM chats WHERE id=?').run('chat')
    if (change === 'deleted agent') agentRepo.delete(OWNER, agent.id)
    if (change === 'foreign agent owner') state.db!.raw.prepare('UPDATE agents SET user_id=? WHERE id=?').run('other', agent.id)
    expect(() => held.validate()).toThrow()
    expect(() => held.save({ sessionId: 'sesn_late', state: 'ready' })).toThrow()
    expectNoPrivateRows()
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('refuses preparation from an agent snapshot whose owned row has disappeared', () => {
    agentRepo.delete(OWNER, agent.id)
    expect(() => prepare()).toThrow()
    expectNoPrivateRows()
  })

  it.each(['replacement key', 'disable and re-enable', 'delete', 'profile switch'] as const)('invalidates a captured credential on %s even when its endpoint would still work', (change) => {
    const held = prepare()
    const revision = llmProviderRepo.getOwned(OWNER, credentialId)!.configRevision!
    if (change === 'replacement key') updateCredential({ apiKeyEncrypted: Buffer.from('sk-ant-api-new-synthetic-secret') })
    if (change === 'disable and re-enable') { updateCredential({ enabled: false }); updateCredential({ enabled: true }) }
    if (change === 'delete') llmProviderRepo.delete(OWNER, credentialId)
    if (change === 'profile switch') state.profile = 'other'
    expect(() => held.validate()).toThrow(/credential|profile/i)
    expect(() => held.save({ sessionId: 'sesn_stale', state: 'ready' })).toThrow()
    if (change === 'disable and re-enable') expect(llmProviderRepo.getOwned(OWNER, credentialId)!.configRevision).toBe(revision + 2)
    expectNoPrivateRows()
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('keeps a name-only credential edit compatible with existing continuity', () => {
    const held = prepare()
    held.save({ sessionId: 'sesn_name-stable', state: 'ready' })
    const revision = llmProviderRepo.getOwned(OWNER, credentialId)!.configRevision
    updateCredential({ name: 'A clearer credential name' })
    expect(llmProviderRepo.getOwned(OWNER, credentialId)!.configRevision).toBe(revision)
    expect(() => held.validate()).not.toThrow()
    expect(prepare().checkpoint).toEqual({ sessionId: 'sesn_name-stable', state: 'ready' })
  })

  it.each(['configuration edit', 'agent disable and re-enable'] as const)('invalidates a held agent after %s without rewriting saved continuity', (change) => {
    const held = prepare(); held.save({ sessionId: 'sesn_original', state: 'inflight' })
    const original = privateRows()
    if (change === 'configuration edit') agentRepo.updateRuntime(OWNER, agent.id, 'managed', { name: agent.name, config: { ...config, environmentId: 'another-environment' } })
    else { agentRepo.update(OWNER, agent.id, { enabled: false }); agentRepo.update(OWNER, agent.id, { enabled: true }) }
    expect(() => held.validate()).toThrow(/configuration changed/)
    expect(() => held.save({ sessionId: 'sesn_original', state: 'ready' })).toThrow()
    agent = agentRepo.getOwned(OWNER, agent.id)!
    expect(() => prepare()).toThrow(/different configuration or credential/)
    expect(privateRows()).toEqual(original)
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('requires a new chat after credential replacement instead of reusing the old remote session', () => {
    prepare().save({ sessionId: 'sesn_original', state: 'ready' })
    const original = privateRows()
    updateCredential({ apiKeyEncrypted: Buffer.from('sk-ant-api-other-synthetic-key') })
    expect(() => prepare()).toThrow(/different configuration or credential/)
    expect(privateRows()).toEqual(original)
  })

  it('rejects unsupported, disabled, foreign and CLI-login credentials without returning an HTTP capability', () => {
    updateCredential({ enabled: false }); expect(() => prepare()).toThrow(/enabled Anthropic/)
    updateCredential({ enabled: true, unsupported: true }); expect(() => prepare()).toThrow(/enabled Anthropic/)
    updateCredential({ unsupported: false, apiKeyEncrypted: Buffer.from('sk-ant-oat-synthetic-cli-login') }); expect(() => prepare()).toThrow(/not a Claude CLI login/)
    state.db!.raw.prepare('UPDATE llm_providers SET user_id=? WHERE id=?').run('other', credentialId)
    expect(() => prepare()).toThrow(/enabled Anthropic/)
    expect(fetchSpy).not.toHaveBeenCalled()
    expectNoPrivateRows()
  })

  it('rolls back the private checkpoint when writing the generic session mirror fails', () => {
    state.db!.raw.exec("CREATE TRIGGER fail_session_mirror BEFORE INSERT ON a2a_sessions BEGIN SELECT RAISE(ABORT,'mirror write failed'); END")
    expect(() => prepare().save({ sessionId: 'sesn_rollback', state: 'inflight' })).toThrow(/mirror write failed/)
    expectNoPrivateRows()
  })

  it('refuses a changed session id, changed fingerprint or unsupported saved state without rewriting the original row', () => {
    const held = prepare(); held.save({ sessionId: 'sesn_original', state: 'ready' })
    const original = privateRows()
    expect(() => held.save({ sessionId: 'sesn_replacement', state: 'ready' })).toThrow(/binding changed/)
    expect(() => managedAgentSessionRepo.save(OWNER, OWNER, 'chat', agent.id, 'different-binding', { sessionId: 'sesn_original', state: 'ready' })).toThrow(/binding changed/)
    expect(privateRows()).toEqual(original)
    state.db!.raw.exec("UPDATE managed_agent_sessions SET state='future_state'")
    expect(() => prepare()).toThrow(/unsupported saved state/)
  })

  it.each(['chat', 'agent'] as const)('cascades private continuity when its %s is deleted', (target) => {
    prepare().save({ sessionId: 'sesn_cascade', state: 'budget' })
    if (target === 'chat') state.db!.raw.prepare('DELETE FROM chats WHERE id=?').run('chat')
    else agentRepo.delete(OWNER, agent.id)
    expect(privateRows()).toEqual([])
  })

  it('exposes only the generic session DTO from actual agent:get-session IPC and refuses a foreign profile', async () => {
    prepare().save({ sessionId: 'sesn_public-context', state: 'uncertain' })
    registerA2AHandlers()
    const handler = state.handlers.get('agent:get-session')!
    const dto = await handler({}, 'chat') as Record<string, unknown>
    expect(dto).toMatchObject({ chatId: 'chat', agentId: agent.id, contextId: 'sesn_public-context', taskId: null, taskState: null })
    expect(Object.keys(dto).sort()).toEqual(['agentId', 'chatId', 'contextId', 'createdAt', 'id', 'taskId', 'taskState', 'updatedAt'])
    const privateRow = privateRows()[0]
    expect(typeof privateRow.binding).toBe('string')
    expect(JSON.stringify(dto)).not.toContain(String(privateRow.binding))
    expect(JSON.stringify(dto)).not.toContain(KEY)
    expect(JSON.stringify(dto)).not.toContain('credentialId')
    state.profile = 'other'
    expect(await handler({}, 'chat')).toBeNull()
    expect(fetchSpy).not.toHaveBeenCalled()
  })
})
