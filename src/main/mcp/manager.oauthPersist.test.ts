import { describe, expect, it, vi } from 'vitest'

/**
 * OAuth state the SDK hands the manager is encrypted (an async keystore call)
 * before it is written. Two saves of one connection must land in the order
 * they were made, even when the older one's encryption finishes later — or a
 * refreshed token would be overwritten by the one it replaced.
 */

const edge = vi.hoisted(() => ({
  row: { id: 'p1', userId: 'u', configRevision: 0 } as Record<string, unknown> | undefined,
  saved: [] as string[],
  /** Per plaintext: resolve the encryption now, or hold it until released. */
  held: new Map<string, () => void>(),
  hold: new Set<string>()
}))
vi.mock('electron', () => ({ shell: { openExternal: vi.fn() } }))
vi.mock('../host/runtimeHost', () => ({ runtimeHost: { getPath: () => '/unused' } }))
vi.mock('../logger/logger', () => ({ createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }) }))
vi.mock('../security/keystore', () => ({
  encryptApiKey: (text: string) => new Promise<Buffer>((resolve) => {
    const done = (): void => resolve(Buffer.from(text))
    if (edge.hold.has(text)) edge.held.set(text, done)
    else done()
  }),
  decryptApiKey: async (value: Buffer) => value.toString()
}))
vi.mock('../db/mcpProviders', () => ({ mcpProviderRepo: {
  getOwned: (userId: string, id: string) => (edge.row && edge.row.userId === userId && edge.row.id === id ? edge.row : undefined),
  saveOAuthState: (_userId: string, _id: string, _revision: number, patch: { authTokensEncrypted?: Buffer | null }) => {
    edge.saved.push(patch.authTokensEncrypted ? JSON.parse(patch.authTokensEncrypted.toString()).access_token : 'cleared')
  }
} }))

const { MCPManager } = await import('./manager')

type Patch = { tokens?: { access_token: string; token_type: string } | null }
interface Internals {
  connections: Map<string, unknown>
  generations: Map<string, number>
  persistOAuth(connection: unknown, patch: Patch): Promise<void>
}

/** A manager holding one live connection for provider `p1`, and its private persist. */
function live(): { persist: (patch: Patch) => Promise<void>; connection: unknown; internals: Internals } {
  const manager = new MCPManager() as unknown as Internals
  const connection = { config: { id: 'p1', userId: 'u', configRevision: 0 }, generation: 1, tools: [], status: 'connected' }
  manager.connections.set('p1', connection)
  manager.generations.set('p1', 1)
  return { persist: (patch) => manager.persistOAuth(connection, patch), connection, internals: manager }
}
const tokens = (access: string) => ({ tokens: { access_token: access, token_type: 'Bearer' } })
const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

describe('MCP OAuth persistence', () => {
  it('writes a connection’s saves in call order, though the older one encrypts slower', async () => {
    edge.saved = []; edge.held.clear(); edge.hold = new Set([JSON.stringify(tokens('old').tokens)])
    const { persist } = live()
    const older = persist(tokens('old'))
    const newer = persist(tokens('new'))
    await flush()
    // The newer save waits behind the older one, whose encryption is still running.
    expect(edge.saved).toEqual([])
    edge.held.get(JSON.stringify(tokens('old').tokens))!()
    await Promise.all([older, newer])
    expect(edge.saved).toEqual(['old', 'new'])
  })

  it('keeps writing after a failed save, and reports each save’s own outcome', async () => {
    edge.saved = []; edge.held.clear(); edge.hold = new Set()
    const { persist, internals } = live()
    // The first save finds its connection superseded once its encryption returns.
    edge.hold = new Set([JSON.stringify(tokens('stale').tokens)])
    const stale = persist(tokens('stale'))
    await flush()
    internals.generations.set('p1', 2)
    edge.held.get(JSON.stringify(tokens('stale').tokens))!()
    await expect(stale).rejects.toThrow(/changed/)
    internals.generations.set('p1', 1)
    await expect(persist(tokens('fresh'))).resolves.toBeUndefined()
    expect(edge.saved).toEqual(['fresh'])
  })
})
