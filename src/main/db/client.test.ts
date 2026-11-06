import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createTestDatabase, type TestDatabase } from './testSupport/nodeSqlite'

/**
 * The boot step that encrypts MCP client registrations stored in the clear.
 * The keystore is async, so it runs in the background; a registration the
 * MCP manager writes while one is being encrypted must survive it.
 */

const keystore = vi.hoisted(() => ({ pending: [] as Array<() => void> }))
vi.mock('../security/keystore', () => ({
  // Resolves only when the test releases it: the window a real keystore await opens.
  encryptApiKey: (plaintext: string) => new Promise<Buffer>((resolve) => {
    keystore.pending.push(() => resolve(Buffer.from(`sealed:${plaintext}`)))
  })
}))
vi.mock('../host/runtimeHost', () => ({ runtimeHost: { getPath: () => '/unused' } }))

const { encryptMcpClientRegistrations } = await import('./client')

let fixture: TestDatabase
const PLAIN = JSON.stringify({ client_id: 'legacy-client' })

function insert(id: string, clientInfo: string): void {
  fixture.raw.prepare("INSERT INTO mcp_providers (id, user_id, name, transport_type, client_info, created_at) VALUES (?, '__default__', ?, 'streamable-http', ?, 1)").run(id, id, clientInfo)
}
function clientInfo(id: string): string {
  return (fixture.raw.prepare('SELECT client_info FROM mcp_providers WHERE id = ?').get(id) as { client_info: string }).client_info
}
/** Release every pending encryption, including ones queued while releasing. */
async function releaseAll(): Promise<void> {
  for (let round = 0; round < 10; round++) {
    await new Promise((resolve) => setTimeout(resolve, 0))
    const batch = keystore.pending.splice(0)
    if (batch.length === 0) return
    for (const release of batch) release()
  }
}

beforeEach(() => {
  fixture = createTestDatabase()
  keystore.pending.length = 0
})
afterEach(() => fixture.close())

describe('encrypt-mcp-client-registrations', () => {
  it('encrypts a registration stored in the clear and leaves an encrypted one alone', async () => {
    const already = JSON.stringify({ encrypted: 'c2VhbGVk' })
    insert('legacy', PLAIN)
    insert('current', already)
    const done = encryptMcpClientRegistrations(fixture.sqlite)
    await releaseAll()
    await done
    expect(JSON.parse(clientInfo('legacy'))).toEqual({ encrypted: Buffer.from(`sealed:${PLAIN}`).toString('base64') })
    expect(clientInfo('current')).toBe(already)
  })

  it('never overwrites a registration written while the old one was being encrypted', async () => {
    insert('legacy', PLAIN)
    const done = encryptMcpClientRegistrations(fixture.sqlite)
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(keystore.pending).toHaveLength(1)
    // The MCP manager saves a fresh registration meanwhile (a new DCR, already encrypted).
    const fresh = JSON.stringify({ encrypted: Buffer.from('sealed:fresh-registration').toString('base64') })
    fixture.raw.prepare('UPDATE mcp_providers SET client_info = ? WHERE id = ?').run(fresh, 'legacy')
    await releaseAll()
    await done
    expect(clientInfo('legacy')).toBe(fresh)
  })
})
