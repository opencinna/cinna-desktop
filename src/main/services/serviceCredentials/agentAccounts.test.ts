import { describe, expect, it, vi } from 'vitest'
import { createAgentAccounts, unresolvedAiReference, type AgentAccountsDeps } from './agentAccounts'
import type { ProviderDto } from '../providerService'
import type { UnavailableCredentialAccount } from '../../../shared/serviceCredentials'

const provider = (id: string, name: string, over: Partial<ProviderDto> = {}): ProviderDto =>
  ({ id, type: 'anthropic', name, enabled: true, defaultModelId: null, hasApiKey: true, baseUrl: null, managed: false, adminManaged: false, unsupported: false, createdAt: new Date(0), ...over })
const settings = (over: Partial<ReturnType<AgentAccountsDeps['settings']>> = {}) =>
  ({ localAgentsDefaultCredentialId: '', claudeAuthMode: 'subscription', claudeApiCredentialId: '', ...over })
const none = () => null

describe('the AI credential reference that resolves to nothing here', () => {
  const mine = [provider('own', 'My key')]
  it('OpenCode: the declared reference, by id or name as the engine resolves it', () => {
    expect(unresolvedAiReference({ credential: 'managed:9' }, 'opencode', mine, none, settings())).toEqual({ reference: 'managed:9', byId: false })
    expect(unresolvedAiReference({ credential: 'my key' }, 'opencode', mine, none, settings())).toBeNull()
    expect(unresolvedAiReference({ credential: 'own' }, 'opencode', mine, none, settings())).toBeNull()
  })
  it('OpenCode without its own: the machine pin, only when the default chat mode resolves nothing either', () => {
    expect(unresolvedAiReference(null, 'opencode', mine, none, settings({ localAgentsDefaultCredentialId: 'managed:9' }))).toEqual({ reference: 'managed:9', byId: true })
    expect(unresolvedAiReference(null, 'opencode', mine, () => 'own', settings({ localAgentsDefaultCredentialId: 'managed:9' }))).toBeNull()
    expect(unresolvedAiReference(null, 'opencode', mine, none, settings({ localAgentsDefaultCredentialId: 'own' }))).toBeNull()
    expect(unresolvedAiReference(null, 'opencode', mine, none, settings())).toBeNull()
  })
  it('Claude: only in API Token mode, the chosen credential, else a gone pin when nothing qualifies', () => {
    expect(unresolvedAiReference(null, 'claude', mine, none, settings({ claudeApiCredentialId: 'managed:9' }))).toBeNull()
    expect(unresolvedAiReference(null, 'claude', mine, none, settings({ claudeAuthMode: 'api_key', claudeApiCredentialId: 'managed:9' }))).toEqual({ reference: 'managed:9', byId: true })
    // Present but switched off is not an account's to explain.
    expect(unresolvedAiReference(null, 'claude', [provider('managed:9', 'x', { enabled: false })], none, settings({ claudeAuthMode: 'api_key', claudeApiCredentialId: 'managed:9' }))).toBeNull()
    expect(unresolvedAiReference(null, 'claude', [], none, settings({ claudeAuthMode: 'api_key', localAgentsDefaultCredentialId: 'managed:9' }))).toEqual({ reference: 'managed:9', byId: true })
    expect(unresolvedAiReference(null, 'claude', mine, none, settings({ claudeAuthMode: 'api_key', localAgentsDefaultCredentialId: 'managed:9' }))).toBeNull()
  })
  it('Codex and Antigravity spend none of this app’s credentials', () => {
    expect(unresolvedAiReference({ credential: 'managed:9' }, 'codex', mine, none, settings())).toBeNull()
    expect(unresolvedAiReference(null, 'antigravity', mine, none, settings({ localAgentsDefaultCredentialId: 'managed:9' }))).toBeNull()
  })
})

describe('one answer per agent', () => {
  const alice: UnavailableCredentialAccount = { key: 'k1', userId: 'alice', name: 'Alice', email: 'alice@corp.com', host: 'core.corp.com', reason: 'signed_out', current: false, credentials: 2, aiCredential: false }
  const deps = (over: Partial<AgentAccountsDeps> = {}): AgentAccountsDeps => ({
    isVault: () => false,
    agent: () => ({ runtime: { engine: 'opencode', credential: 'Team key' } }),
    credentialAccounts: () => [alice],
    profileAccount: vi.fn((userId: string) => ({ ...alice, key: `user:${userId}`, userId, name: userId, credentials: 0, aiCredential: true, reason: 'other_profile' as const })),
    defaultEngine: () => 'opencode',
    providers: () => [],
    fallbackCredentialId: none,
    settings: () => settings(),
    otherManagedRows: () => [{ userId: 'bob', id: 'managed:9', name: 'Team key', managed: true }],
    ...over
  })
  it('lists the credential accounts and the profile whose managed credential the agent names', () => {
    expect(createAgentAccounts(deps()).unavailable('a').accounts).toEqual([alice, expect.objectContaining({ userId: 'bob', aiCredential: true, credentials: 0, reason: 'other_profile' })])
  })
  it('folds the AI credential into the same profile’s row', () => {
    const d = deps({ otherManagedRows: () => [{ userId: 'alice', id: 'managed:9', name: 'Team key', managed: true }] })
    expect(createAgentAccounts(d).unavailable('a').accounts).toEqual([{ ...alice, aiCredential: true }])
  })
  it('says nothing about an AI credential that resolves, or that no other profile holds', () => {
    expect(createAgentAccounts(deps({ providers: () => [provider('p', 'Team key')] })).unavailable('a').accounts).toEqual([alice])
    expect(createAgentAccounts(deps({ otherManagedRows: () => [] })).unavailable('a').accounts).toEqual([alice])
  })
  it('answers no accounts for a vault agent', () => {
    const d = deps({ isVault: () => true, agent: () => { throw new Error('no folder') } })
    expect(createAgentAccounts(d).unavailable('a')).toEqual({ accounts: [] })
  })
})
