import { describe, it, expect, vi, beforeEach } from 'vitest'

/**
 * `mcpService.upsert` and the directory ref: a connector created from an MCP
 * registry entry in Settings → MCP records that entry (`registry_ref`), so
 * the agent's addon picker shows it once; an update never passes one, so the
 * ref a provider was made from never moves.
 */

const upserted = (_userId: string, input: { id?: string }) => ({
  id: input.id ?? 'new',
  created: !input.id,
  row: { id: input.id ?? 'new', userId: 'u', name: 'n', transportType: 'streamable-http', enabled: false, authType: 'oauth' }
})
const repo = vi.hoisted(() => ({ upsert: vi.fn() }))
vi.mock('../db/mcpProviders', () => ({ mcpProviderRepo: repo }))
vi.mock('../db/chatModes', () => ({ chatModeRepo: { stripMcpProviderId: vi.fn() } }))
vi.mock('../mcp/manager', () => ({
  mcpManager: { getConnection: () => undefined, connect: vi.fn(), disconnect: vi.fn(async () => undefined), needsUser: () => false }
}))
vi.mock('../mcp/config', () => ({ mcpRowToConfig: (row: unknown) => row }))
vi.mock('../security/keystore', () => ({ encryptApiKey: (value: string) => Buffer.from(value) }))

const { mcpService } = await import('./mcpService')

const REF = { source: 'mcp-registry:cinna-official', id: 'granola' }
const BASE = { name: 'Granola', transportType: 'streamable-http', url: 'https://g.example/mcp', enabled: false }

beforeEach(() => {
  repo.upsert.mockReset()
  repo.upsert.mockImplementation(upserted)
})

describe('mcpService.upsert registryRef', () => {
  it('writes the registry ref of a new connector', async () => {
    await mcpService.upsert('u', { ...BASE, registryRef: REF })
    expect(repo.upsert).toHaveBeenCalledWith('u', expect.objectContaining({ registryRef: REF }))
  })

  it('never passes one on an update, nor for a hand-made connector', async () => {
    await mcpService.upsert('u', { ...BASE, id: 'm1', registryRef: REF })
    expect(repo.upsert.mock.calls[0][1]).not.toHaveProperty('registryRef')
    await mcpService.upsert('u', BASE)
    expect(repo.upsert.mock.calls[1][1]).not.toHaveProperty('registryRef')
  })
})
