import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { adaptDatabase, createTestDatabase, type TestDatabase } from './testSupport/nodeSqlite'
import { runAllMigrations } from './migrations'

/** `mcp_providers.registry_ref`: the column, its insert-only write and the lookup, on the real migration chain. */

const holder = vi.hoisted(() => ({ current: null as TestDatabase | null }))

vi.mock('./client', () => ({
  getDb: () => holder.current!.db,
  getRawSqlite: () => holder.current!.sqlite
}))

const { mcpProviderRepo } = await import('./mcpProviders')

const USER = '__default__'
const REF = { source: 'mcp-registry:cinna-official', id: 'granola' }

beforeEach(() => {
  holder.current = createTestDatabase()
})
afterEach(() => {
  holder.current?.close()
  holder.current = null
})

describe('registry_ref migration', () => {
  it('adds a nullable column to an install that predates it, keeps its rows, and replays as a no-op', () => {
    const raw = new DatabaseSync(':memory:')
    raw.exec(`CREATE TABLE mcp_providers (id TEXT PRIMARY KEY, name TEXT NOT NULL, transport_type TEXT NOT NULL,
      command TEXT, args TEXT, url TEXT, env TEXT, enabled INTEGER NOT NULL DEFAULT 1, created_at INTEGER NOT NULL);
      INSERT INTO mcp_providers (id, name, transport_type, created_at) VALUES ('old', 'Old', 'stdio', 1);`)
    raw.exec('PRAGMA foreign_keys = OFF')
    runAllMigrations(adaptDatabase(raw))
    runAllMigrations(adaptDatabase(raw))
    const cols = raw.prepare("PRAGMA table_info('mcp_providers')").all() as Array<{ name: string; notnull: number }>
    expect(cols.find((c) => c.name === 'registry_ref')).toMatchObject({ notnull: 0 })
    expect(raw.prepare("SELECT id, registry_ref FROM mcp_providers WHERE id = 'old'").get()).toEqual({ id: 'old', registry_ref: null })
    raw.close()
  })
})

describe('mcpProviderRepo registryRef', () => {
  it('writes the ref on insert and finds the provider by it, in this scope only', () => {
    const { id } = mcpProviderRepo.upsert(USER, { name: 'Granola', transportType: 'streamable-http', url: 'https://g.example/mcp', registryRef: REF })
    mcpProviderRepo.upsert('someone-else', { name: 'Granola', transportType: 'streamable-http', url: 'https://g.example/mcp', registryRef: REF })
    expect(mcpProviderRepo.getOwned(USER, id)?.registryRef).toEqual(REF)
    expect(mcpProviderRepo.findByRegistryRef(USER, REF)?.id).toBe(id)
    expect(mcpProviderRepo.findByRegistryRef(USER, { ...REF, id: 'other' })).toBeUndefined()
    expect(mcpProviderRepo.findByRegistryRef('nobody', REF)).toBeUndefined()
  })

  it('never moves the ref on an update, and leaves it null for a hand-made provider', () => {
    const { id } = mcpProviderRepo.upsert(USER, { name: 'Granola', transportType: 'streamable-http', url: 'https://g.example/mcp', registryRef: REF })
    mcpProviderRepo.upsert(USER, { id, name: 'Renamed', transportType: 'streamable-http', url: 'https://g.example/mcp', registryRef: null })
    expect(mcpProviderRepo.getOwned(USER, id)?.registryRef).toEqual(REF)
    const own = mcpProviderRepo.upsert(USER, { name: 'Mine', transportType: 'stdio', command: 'node' })
    expect(own.row.registryRef).toBeNull()
  })
})
