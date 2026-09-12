import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createTestDatabase, type TestDatabase } from '../db/testSupport/nodeSqlite'
import { runAllMigrations } from '../db/migrations'
import type { OAuthDiscoveryState, StoredOAuthTokens } from '@modelcontextprotocol/client'

const edge = vi.hoisted(() => ({ db: undefined as unknown, open: vi.fn() }))
vi.mock('../db/client', () => ({ getDb: () => edge.db }))
vi.mock('electron', () => ({ shell: { openExternal: edge.open } }))
import { mcpProviderRepo } from '../db/mcpProviders'
import { ElectronOAuthProvider, type OAuthStoredState } from './oauth-provider'

let fixture: TestDatabase
const original = { name: 'OAuth', transportType: 'streamable-http' as const, url: 'https://mcp.test/mcp', authType: 'oauth' as const }
const tokens: StoredOAuthTokens = { access_token: 'synthetic-access', token_type: 'Bearer', refresh_token: 'synthetic-refresh', expires_in: 3600 }
const discovery = { authorizationServerUrl: 'https://issuer.test' } satisfies OAuthDiscoveryState
beforeEach(() => {
  fixture = createTestDatabase(); edge.db = fixture.db; edge.open.mockClear()
  fixture.raw.exec("INSERT INTO users (id,type,username,display_name,created_at) VALUES ('owner','local_user','owner','Owner',1), ('other','local_user','other','Other',1)")
})
afterEach(() => fixture.close())

function provider(id: string, revision: number, stored: OAuthStoredState = {}) {
  return new ElectronOAuthProvider(stored, {
    assertCurrent: () => {
      if (mcpProviderRepo.getOwned('owner', id)?.configRevision !== revision) throw new Error('Configuration changed')
    },
    save: (patch) => mcpProviderRepo.saveOAuthState('owner', id, revision, {
      ...('tokens' in patch ? { authTokensEncrypted: patch.tokens ? Buffer.from(JSON.stringify(patch.tokens)) : null } : {}),
      ...('clientInfo' in patch ? { clientInfo: patch.clientInfo } : {}),
      ...('discovery' in patch ? { oauthDiscoveryState: patch.discovery } : {})
    })
  })
}

describe('MCP OAuth durable ownership', () => {
  it('roundtrips complete SDK state and invalidates only the requested credential scope', () => {
    const { id } = mcpProviderRepo.upsert('owner', original)
    const current = provider(id, 0)
    const stamped = { ...tokens, issuer: 'https://issuer.test', extra: 'preserved' }
    current.saveTokens(stamped)
    current.saveClientInformation({ client_id: 'public-native', issuer: 'https://issuer.test' })
    current.saveDiscoveryState(discovery)
    current.saveCodeVerifier('verifier')
    const saved = mcpProviderRepo.getOwned('owner', id)!
    expect(JSON.parse(Buffer.from(saved.authTokensEncrypted!).toString())).toEqual(stamped)
    expect(saved.clientInfo).toEqual(current.clientInformation())
    expect(saved.oauthDiscoveryState).toEqual(discovery)
    current.invalidateCredentials('verifier')
    expect(() => current.codeVerifier()).toThrow()
    expect(current.tokens()).toEqual(stamped)
    current.invalidateCredentials('tokens')
    expect(current.tokens()).toBeUndefined()
    expect(mcpProviderRepo.getOwned('owner', id)?.authTokensEncrypted).toBeNull()
    expect(current.clientInformation()?.client_id).toBe('public-native')
    current.invalidateCredentials('discovery')
    expect(mcpProviderRepo.getOwned('owner', id)?.oauthDiscoveryState).toBeNull()
    current.invalidateCredentials('all')
    expect(mcpProviderRepo.getOwned('owner', id)?.clientInfo).toBeNull()
    expect(current.clientMetadata).toMatchObject({ application_type: 'native', token_endpoint_auth_method: 'none' })
  })

  it('preserves credentials for a rename and clears them for endpoint/auth changes with monotonic revisions', () => {
    const { id } = mcpProviderRepo.upsert('owner', original)
    provider(id, 0).saveTokens(tokens)
    mcpProviderRepo.upsert('owner', { ...original, id, name: 'Renamed' })
    expect(mcpProviderRepo.getOwned('owner', id)).toMatchObject({ configRevision: 0, authTokensEncrypted: expect.anything() })
    mcpProviderRepo.upsert('owner', { ...original, id, url: 'https://new.test/mcp' })
    expect(mcpProviderRepo.getOwned('owner', id)).toMatchObject({ configRevision: 1, authTokensEncrypted: null, clientInfo: null, oauthDiscoveryState: null })
    mcpProviderRepo.upsert('owner', { ...original, id })
    expect(mcpProviderRepo.getOwned('owner', id)?.configRevision).toBe(2)
    expect(() => mcpProviderRepo.saveOAuthState('owner', id, 0, { clientInfo: { client_id: 'stale' } })).toThrow(/changed/)
    expect(() => mcpProviderRepo.saveOAuthState('other', id, 2, { clientInfo: {} })).toThrow(/changed/)
    mcpProviderRepo.upsert('owner', { ...original, id, authType: 'bearer' })
    expect(mcpProviderRepo.getOwned('owner', id)?.configRevision).toBe(3)
  })

  it('rejects a stale provider after configuration replacement or deletion', () => {
    const { id } = mcpProviderRepo.upsert('owner', original)
    const current = provider(id, 0)
    mcpProviderRepo.upsert('owner', { ...original, id, enabled: false })
    expect(() => current.saveTokens(tokens)).toThrow(/changed/)
    expect(mcpProviderRepo.getOwned('owner', id)?.authTokensEncrypted).toBeNull()
    mcpProviderRepo.delete('owner', id)
    expect(() => current.saveDiscoveryState(discovery)).toThrow(/changed/)
  })

  it('latches persistence failure without changing in-memory or durable rotated tokens', async () => {
    const stored = { tokens }
    const failure = new Error('disk write failed')
    const current = new ElectronOAuthProvider(stored, { assertCurrent: () => {}, save: () => { throw failure } })
    expect(() => current.saveTokens({ ...tokens, refresh_token: 'rotated' })).toThrow(failure)
    expect(stored.tokens).toEqual(tokens)
    expect(() => current.state()).toThrow(failure)
    expect(() => current.tokens()).toThrow(failure)
    await expect(current.redirectToAuthorization(new URL('https://issuer.test/authorize'))).rejects.toBe(failure)
    expect(edge.open).not.toHaveBeenCalled()
  })

  it('adds v2 columns to a populated database and preserves existing credentials on repeated migration', () => {
    const { id } = mcpProviderRepo.upsert('owner', original)
    provider(id, 0).saveTokens(tokens)
    fixture.raw.exec('ALTER TABLE mcp_providers DROP COLUMN oauth_discovery_state; ALTER TABLE mcp_providers DROP COLUMN config_revision')
    runAllMigrations(fixture.sqlite); runAllMigrations(fixture.sqlite)
    const saved = mcpProviderRepo.getOwned('owner', id)!
    expect(saved.configRevision).toBe(0)
    expect(saved.oauthDiscoveryState).toBeNull()
    expect(JSON.parse(Buffer.from(saved.authTokensEncrypted!).toString())).toEqual(tokens)
  })
})

it('reuses the redirect URI retained with a client registration', async () => {
  const { id } = mcpProviderRepo.upsert('owner', original)
  const first = provider(id, 0)
  let second: ElectronOAuthProvider | undefined
  try {
    await first.prepareForAuth()
    const redirect = first.redirectUrl
    first.saveClientInformation({ client_id: 'registered-client' })
    const registration = first.clientInformation()
    first.cleanup()
    second = provider(id, 0, { clientInfo: registration })
    await second.prepareForAuth()
    expect(second.redirectUrl).toBe(redirect)
    expect(second.clientInformation()?.client_id).toBe('registered-client')
  } finally { first.cleanup(); second?.cleanup() }
})
