import { describe, expect, it, vi } from 'vitest'

// credentialDto is pure; the repository's database is never touched here.
vi.mock('./client', () => ({ getRawSqlite: () => { throw new Error('no database in this test') } }))
const { credentialDto } = await import('./serviceCredentials')

const row = (metadata: Record<string, unknown>) => ({
  id: 'row-1', user_id: 'u', origin: 'cloud' as const, cloud_id: 'key-1', server_origin: 'https://core.example.test',
  metadata: JSON.stringify({ name: 'CRM API', type: 'agent_api', serviceUri: 'crm', notes: null, status: 'complete', isPlaceholder: false,
    relation: 'owned', ownerEmail: null, localUseAllowed: true, revision: 'r1', ...metadata }),
  payload_enc: null, payload_fetched_at: null, expires_at: null, created_at: 1, updated_at: 1
})

describe('credentialDto', () => {
  it('passes a blocked delivery through to the renderer and keeps the key file fields in main', () => {
    const dto = credentialDto(row({ keyStatus: 'active', keyBlocked: 'insecure_base_url', keyStub: { base_url: 'http://crm.example.test/api', producer_agent_id: 'p1' } }))
    expect(dto).toMatchObject({ keyStatus: 'active', keyBlocked: 'insecure_base_url', hasValues: false, cloudId: 'key-1' })
    expect(dto).not.toHaveProperty('keyStub')
    expect(JSON.stringify(dto)).not.toContain('crm.example.test')
  })

  it('defaults every key fact to null on metadata cached before they existed', () => {
    expect(credentialDto(row({}))).toMatchObject({ keyStatus: null, agentApi: null, keyBlocked: null })
  })
})
