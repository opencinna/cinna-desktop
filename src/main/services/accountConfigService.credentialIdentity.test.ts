import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { randomUUID } from 'node:crypto'
import { createTestDatabase, type TestDatabase } from '../db/testSupport/nodeSqlite'

const state = vi.hoisted(() => ({ db: null as TestDatabase | null, key: 'sk-ant-api-test-only' }))
vi.mock('../db/client', () => ({ getDb: () => state.db!.db }))
vi.mock('../logger/logger', () => ({ createLogger: () => ({ info() {}, warn() {}, error() {}, debug() {} }) }))
vi.mock('../security/keystore', () => ({
  encryptApiKey: (key: string) => Buffer.from(`${randomUUID()}|${key}`),
  decryptApiKey: (envelope: Buffer) => envelope.toString().split('|')[1]
}))
vi.mock('../db/users', () => ({ userRepo: { get: () => ({ type: 'cinna_user', cinnaServerUrl: 'https://account.invalid' }) } }))
vi.mock('../auth/cinna-tokens', () => ({ getCinnaAccessToken: async () => 'synthetic-token' }))
vi.mock('../auth/scope', () => ({ getProfileScopeUserId: () => '__default__', getSettingsScopeUserId: () => '__default__', getManagedResourceScopes: () => ['__default__'] }))
vi.mock('../llm/factory', () => ({ createAdapter: () => null }))
vi.mock('../llm/registry', () => ({ registerAdapter() {}, unregisterAdapter() {} }))
vi.mock('electron', () => ({ net: { fetch: async () => new Response(JSON.stringify({ providers: [{
  credential_id: 'account-key', provider_type: 'anthropic', display_name: 'Claude', descriptor_slug: 'claude',
  base_url: null, model: null, api_key: state.key, is_default: false, is_admin_managed: false,
  default_chat_mode_label: 'Claude', suggested_models: []
}], default_provider_credential_id: null })) } }))

const { accountConfigService } = await import('./accountConfigService')
const { managedAgentService } = await import('./managedAgentService')
const { llmProviderRepo } = await import('../db/llmProviders')
const { agentRepo } = await import('../db/agents')
beforeEach(() => {
  state.db = createTestDatabase(); state.key = 'sk-ant-api-test-only'
  state.db.raw.exec("INSERT INTO chats(id,user_id,title,created_at,updated_at) VALUES('chat','__default__','Managed',1,1)")
})
afterEach(() => { state.db?.close(); state.db = null })

it('preserves an existing Managed session through routine account sync with randomized encryption, but invalidates a replaced key', async () => {
  expect((await accountConfigService.syncAccountConfig('__default__')).failed).toBe(0)
  const first = llmProviderRepo.getOwned('__default__', 'managed:account-key')!
  const agent = agentRepo.createRuntime('__default__', { name: 'Managed', driver: 'managed', config: {
    credentialId: first.id, agentId: 'agent', environmentId: 'environment'
  } })
  const held = managedAgentService.prepare('__default__', agent, 'chat')
  held.save({ sessionId: 'session', state: 'ready' })
  expect((await accountConfigService.syncAccountConfig('__default__')).failed).toBe(0)
  const repeated = llmProviderRepo.getOwned('__default__', first.id)!
  expect(repeated.apiKeyEncrypted).toEqual(first.apiKeyEncrypted)
  expect(repeated.configRevision).toBe(first.configRevision)
  expect(() => held.validate()).not.toThrow()
  expect(managedAgentService.prepare('__default__', agent, 'chat').checkpoint).toEqual({ sessionId: 'session', state: 'ready' })
  state.key = 'sk-ant-api-replacement'
  expect((await accountConfigService.syncAccountConfig('__default__')).failed).toBe(0)
  expect(llmProviderRepo.getOwned('__default__', first.id)!.configRevision).toBe(first.configRevision! + 1)
  expect(() => held.validate()).toThrow(/credential/)
  expect(() => managedAgentService.prepare('__default__', agent, 'chat')).toThrow(/different configuration or credential/)
})
