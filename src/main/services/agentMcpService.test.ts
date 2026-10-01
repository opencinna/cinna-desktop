import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createTestDatabase, type TestDatabase } from '../db/testSupport/nodeSqlite'

const state = vi.hoisted(() => ({
  database: null as TestDatabase | null,
  status: {} as Record<string, string>,
  connect: vi.fn(),
  connecting: vi.fn((_id: string): Promise<unknown> | undefined => undefined),
  needsUser: vi.fn((_id: string) => false),
  refreshAgent: vi.fn(async () => {})
}))
vi.mock('../db/client', () => ({ getDb: () => state.database!.db, getRawSqlite: () => state.database!.sqlite }))
vi.mock('../logger/logger', () => ({ createLogger: () => ({ info() {}, debug() {}, warn() {}, error() {} }) }))
vi.mock('../mcp/manager', () => ({ mcpManager: {
  getConnection: (id: string) => state.status[id] ? { status: state.status[id] } : undefined,
  connect: state.connect,
  connecting: state.connecting,
  needsUser: state.needsUser
} }))
vi.mock('./conductorBridge', () => ({ conductorBridge: { refreshAgent: state.refreshAgent } }))

const { agentMcpService } = await import('./agentMcpService')
const { agentRepo } = await import('../db/agents')

const OWNER = '__default__'
const meta = { entrypoint_prompt: null, example_prompts: [], session_mode: null, ui_color_preset: null, protocol_versions: [] }

function mcp(id: string, columns: Record<string, unknown> = {}, owner = OWNER): void {
  const row = { id, user_id: owner, name: id, transport_type: 'stdio', enabled: 1, created_at: 1, ...columns }
  const keys = Object.keys(row)
  state.database!.raw.prepare(`INSERT INTO mcp_providers (${keys.join(',')}) VALUES (${keys.map(() => '?').join(',')})`)
    .run(...(Object.values(row) as (string | number | Uint8Array | null)[]))
}
const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

beforeEach(() => {
  state.database = createTestDatabase()
  state.status = {}
  state.connect.mockReset()
  state.connect.mockResolvedValue({ status: 'connected' })
  state.connecting.mockReset().mockReturnValue(undefined)
  state.needsUser.mockReset().mockReturnValue(false)
  agentMcpService.resetForTests()
  state.refreshAgent.mockClear()
  agentRepo.replaceFolderIndex(OWNER, 'r1', [
    { id: 'folder:a', name: 'Alpha', description: null, localPath: '/w/a', launcher: 'claude', remoteMetadata: meta },
    { id: 'folder:b', name: 'Beta', description: null, localPath: '/w/b', launcher: 'claude', remoteMetadata: meta }
  ])
  mcp('m1')
})
afterEach(() => { vi.useRealTimers(); state.database?.close(); state.database = null })

describe('agentMcpService', () => {
  it('attaches and detaches, refreshing the agent’s live sessions only on a change', async () => {
    agentMcpService.attach(OWNER, 'folder:a', 'm1')
    agentMcpService.attach(OWNER, 'folder:a', 'm1')
    await flush()
    expect(agentMcpService.list(OWNER, 'folder:a')).toEqual(['m1'])
    expect(state.refreshAgent).toHaveBeenCalledOnce()
    expect(state.refreshAgent).toHaveBeenCalledWith('folder:a')
    agentMcpService.detach(OWNER, 'folder:a', 'm1')
    await flush()
    expect(agentMcpService.list(OWNER, 'folder:a')).toEqual([])
    expect(state.refreshAgent).toHaveBeenCalledTimes(2)
  })

  it('refuses an agent or connector outside the owner’s scope', () => {
    mcp('theirs', {}, 'someone-else')
    expect(() => agentMcpService.attach(OWNER, 'folder:a', 'theirs')).toThrow('MCP provider not found')
    expect(() => agentMcpService.attach(OWNER, 'folder:missing', 'm1')).toThrow('Agent not found')
    expect(() => agentMcpService.attach('someone-else', 'folder:a', 'theirs')).toThrow('Agent not found')
    const remote = agentRepo.create(OWNER, { name: 'A2A', protocol: 'a2a' })
    expect(() => agentMcpService.attach(OWNER, remote.id, 'm1')).toThrow('Agent not found')
    expect(agentMcpService.list(OWNER, remote.id)).toEqual([])
  })

  it('names the agents a connector is attached to', () => {
    agentMcpService.attach(OWNER, 'folder:b', 'm1')
    agentMcpService.attach(OWNER, 'folder:a', 'm1')
    expect(agentMcpService.agentsUsing(OWNER, 'm1').map((agent) => agent.name)).toEqual(['Beta', 'Alpha'])
    expect(() => agentMcpService.agentsUsing('someone-else', 'm1')).toThrow('MCP provider not found')
  })

  it('connects only what can come up with nobody there, never interactively', async () => {
    mcp('bearer', { transport_type: 'streamable-http', url: 'https://x.test', auth_type: 'bearer', bearer_token_enc: Buffer.from('t') })
    mcp('bearer-empty', { transport_type: 'streamable-http', url: 'https://x.test', auth_type: 'bearer' })
    mcp('oauth-signed-in', { transport_type: 'streamable-http', url: 'https://x.test', auth_tokens_enc: Buffer.from('t') })
    mcp('oauth-never', { transport_type: 'streamable-http', url: 'https://x.test' })
    mcp('off', { enabled: 0 })
    mcp('up'); mcp('authorizing'); mcp('errored')
    state.status = { up: 'connected', authorizing: 'awaiting-auth', errored: 'error' }
    for (const id of ['m1', 'bearer', 'bearer-empty', 'oauth-signed-in', 'oauth-never', 'off', 'up', 'authorizing', 'errored']) {
      agentMcpService.attach(OWNER, 'folder:a', id)
    }
    await agentMcpService.ensureConnected(OWNER, 'folder:a')
    const connected = state.connect.mock.calls.map(([config]) => config.id).sort()
    expect(connected).toEqual(['bearer', 'errored', 'm1', 'oauth-signed-in'])
    for (const [, options] of state.connect.mock.calls) expect(options).toEqual({ interactive: false })
  })

  it('waits a bounded time, and shares one attempt between turns starting together', async () => {
    let finish!: () => void
    state.connect.mockReturnValue(new Promise((resolve) => { finish = () => resolve({ status: 'connected' }) }))
    agentMcpService.attach(OWNER, 'folder:a', 'm1')
    const started = Date.now()
    await Promise.all([agentMcpService.ensureConnected(OWNER, 'folder:a', { waitMs: 30 }), agentMcpService.ensureConnected(OWNER, 'folder:a', { waitMs: 30 })])
    expect(Date.now() - started).toBeLessThan(1_000)
    expect(state.connect).toHaveBeenCalledOnce()
    finish()
  })

  it('waits for a connect already in flight instead of starting another', async () => {
    let finish!: () => void
    const running = new Promise((resolve) => { finish = () => resolve({ status: 'connected' }) })
    state.connecting.mockImplementation((id: string) => id === 'm1' ? running : undefined)
    agentMcpService.attach(OWNER, 'folder:a', 'm1')
    let done = false
    const ensured = agentMcpService.ensureConnected(OWNER, 'folder:a').then(() => { done = true })
    await flush()
    expect(done).toBe(false)
    finish()
    await ensured
    expect(state.connect).not.toHaveBeenCalled()
  })

  it('waits for a connector’s first try', async () => {
    let finish!: () => void
    state.connect.mockReturnValue(new Promise((resolve) => { finish = () => resolve({ status: 'connected' }) }))
    agentMcpService.attach(OWNER, 'folder:a', 'm1')
    let done = false
    const ensured = agentMcpService.ensureConnected(OWNER, 'folder:a').then(() => { done = true })
    await flush()
    expect(done).toBe(false)
    finish()
    await ensured
    expect(state.connect).toHaveBeenCalledOnce()
  })

  it('does not count its attempt as failed when the user’s own connect replaced it', async () => {
    // The replaced attempt resolves `disconnected` while the user's is in
    // flight. Mutation: drop the replaced branch and the next turn skips the
    // connector for a minute on a backoff it never earned.
    state.connect.mockResolvedValueOnce({ status: 'disconnected' })
    state.connecting.mockReturnValueOnce(undefined).mockReturnValueOnce(Promise.resolve({ status: 'error' }))
    agentMcpService.attach(OWNER, 'folder:a', 'm1')
    await agentMcpService.ensureConnected(OWNER, 'folder:a', { waitMs: 50 })
    await flush()
    state.connect.mockResolvedValueOnce({ status: 'connected' })
    await agentMcpService.ensureConnected(OWNER, 'folder:a', { waitMs: 50 })
    expect(state.connect).toHaveBeenCalledTimes(2)
  })

  it('retries a failed connector in the background on a doubling backoff, and starts over once it connects', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    const start = Date.now()
    const at = (ms: number): void => { vi.setSystemTime(start + ms) }
    // A background retry settles after the turn has gone on.
    const turn = async (options?: { waitMs?: number }): Promise<void> => { await agentMcpService.ensureConnected(OWNER, 'folder:a', options); await flush() }
    state.connect.mockResolvedValue({ status: 'error' })
    agentMcpService.attach(OWNER, 'folder:a', 'm1')
    await turn()
    expect(state.connect).toHaveBeenCalledTimes(1)
    at(59_000)
    await turn()
    expect(state.connect).toHaveBeenCalledTimes(1)
    // Due: the retry starts, and the turn does not wait for it.
    at(61_000)
    state.connect.mockReturnValueOnce(new Promise(() => {}))
    await turn({ waitMs: 60_000 })
    expect(state.connect).toHaveBeenCalledTimes(2)
    agentMcpService.resetForTests()
    // Two failures: the next waits two minutes, and none waits past fifteen.
    await turn()
    at(122_000)
    await turn()
    expect(state.connect).toHaveBeenCalledTimes(4)
    at(122_000 + 119_000)
    await turn()
    expect(state.connect).toHaveBeenCalledTimes(4)
    at(122_000 + 121_000)
    await turn()
    expect(state.connect).toHaveBeenCalledTimes(5)
    for (let i = 0; i < 6; i++) { at(Date.now() - start + 15 * 60_000 + 1); await turn() }
    expect(state.connect).toHaveBeenCalledTimes(11)
    // Connected (from Settings, say): a later failure is a first try again, and the turn waits for it.
    state.status.m1 = 'connected'
    await agentMcpService.ensureConnected(OWNER, 'folder:a')
    state.status.m1 = 'error'
    let finish!: () => void
    state.connect.mockReturnValueOnce(new Promise((resolve) => { finish = () => resolve({ status: 'connected' }) }))
    let done = false
    const ensured = agentMcpService.ensureConnected(OWNER, 'folder:a').then(() => { done = true })
    await flush()
    expect(state.connect).toHaveBeenCalledTimes(12)
    expect(done).toBe(false)
    finish()
    await ensured
  })

  it('does not retry a connector that needs the user until its configuration or tokens change', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    mcp('oauth', { transport_type: 'streamable-http', url: 'https://x.test', auth_tokens_enc: Buffer.from('t') })
    state.connect.mockResolvedValue({ status: 'error' })
    state.needsUser.mockReturnValue(true)
    agentMcpService.attach(OWNER, 'folder:a', 'oauth')
    await agentMcpService.ensureConnected(OWNER, 'folder:a')
    vi.setSystemTime(Date.now() + 60 * 60_000)
    await agentMcpService.ensureConnected(OWNER, 'folder:a')
    expect(state.connect).toHaveBeenCalledTimes(1)
    state.database!.raw.prepare('UPDATE mcp_providers SET auth_tokens_enc = ? WHERE id = ?').run(Buffer.from('new'), 'oauth')
    await agentMcpService.ensureConnected(OWNER, 'folder:a')
    expect(state.connect).toHaveBeenCalledTimes(2)
    await agentMcpService.ensureConnected(OWNER, 'folder:a')
    expect(state.connect).toHaveBeenCalledTimes(2)
    state.database!.raw.prepare('UPDATE mcp_providers SET config_revision = config_revision + 1 WHERE id = ?').run('oauth')
    await agentMcpService.ensureConnected(OWNER, 'folder:a')
    expect(state.connect).toHaveBeenCalledTimes(3)
  })

  it('stops waiting the moment the turn is stopped', async () => {
    state.connect.mockReturnValue(new Promise(() => {}))
    agentMcpService.attach(OWNER, 'folder:a', 'm1')
    const stop = new AbortController()
    const started = Date.now()
    const ensured = agentMcpService.ensureConnected(OWNER, 'folder:a', { signal: stop.signal, waitMs: 60_000 })
    await flush()
    stop.abort()
    await ensured
    expect(Date.now() - started).toBeLessThan(1_000)
  })

  it('never throws when a connect fails', async () => {
    state.connect.mockRejectedValue(new Error('spawn failed'))
    agentMcpService.attach(OWNER, 'folder:a', 'm1')
    await expect(agentMcpService.ensureConnected(OWNER, 'folder:a')).resolves.toBeUndefined()
  })
})
