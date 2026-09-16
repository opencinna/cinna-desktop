import { afterEach, describe, expect, it, vi } from 'vitest'
import { startAcpConnection } from './acpConnection'
import { createCustomLauncher } from './customLauncher'
import { isRefusal } from './acpLaunchers'
import { fakeRemoteAcp } from './testSupport/fakeRemoteAcp'
import type { AcpConnection } from './types'
import type { SessionNotification } from '@agentclientprotocol/sdk'

const peers: Awaited<ReturnType<typeof fakeRemoteAcp>>[] = []
const connections: AcpConnection[] = []
afterEach(async () => { for (const connection of connections.splice(0)) await connection.dispose(); for (const peer of peers.splice(0)) await peer.close() })
async function start(options: Parameters<typeof fakeRemoteAcp>[0] = {}, client: { token?: string; signal?: AbortSignal; timeout?: number } = {}) {
  const peer = await fakeRemoteAcp(options); peers.push(peer)
  const launcher = createCustomLauncher({ childEnv: async () => { throw new Error('Remote connections must not read the shell environment') }, defaultLocalCwd: () => { throw new Error('No local directory') } })
  const plan = await launcher.plan({ userId: 'owner', agentId: 'remote', custom: { launcher: 'custom', transport: 'websocket', url: peer.url, cwd: '/app/workspace' }, accessToken: client.token })
  if (isRefusal(plan)) throw new Error(plan.error)
  const pending = startAcpConnection(plan.spec, plan.init, { startTimeoutMs: client.timeout ?? 2000, signal: client.signal })
  return { peer, pending: pending.then((connection) => { connections.push(connection); return connection }) }
}
const handlers = (updates: SessionNotification[] = []) => ({ onUpdate: (value: SessionNotification) => { updates.push(value) }, onPermission: async () => ({ outcome: { outcome: 'selected' as const, optionId: 'once' } }) })

describe('remote ACP over a real WebSocket', () => {
  it('authenticates by header, initializes only, then streams and loads the hosted session after reconnect', async () => {
    const { peer, pending } = await start({ token: 'acp_fixture_secret' }, { token: 'acp_fixture_secret' })
    const connection = await pending
    expect(peer.headers).toEqual([{ authorization: 'Bearer acp_fixture_secret', url: '/acp/fixture-connector', origin: undefined }])
    expect(peer.frames.map((frame) => frame.method)).toEqual(['initialize'])
    // The AIR extension reaches the remote peer as the launcher wrote it.
    expect((peer.frames[0].params as { clientCapabilities?: unknown }).clientCapabilities).toMatchObject({
      elicitation: { form: {} },
      _meta: { jetbrains: { air: { version: 1, capabilities: ['asyncTasks'] } } }
    })
    expect(connection.initialized.agentInfo?.name).toBe('cinna-core')
    expect(connection.pid).toBeUndefined()
    const session = await connection.newSession({ cwd: '/app/workspace', mcpServers: [] })
    const updates: SessionNotification[] = []
    connection.bindSession(session.sessionId, handlers(updates))
    expect(await connection.prompt({ sessionId: session.sessionId, prompt: [{ type: 'text', text: 'Hello 🌍\nsecond line' }] })).toEqual({ stopReason: 'end_turn' })
    expect(updates.some((value) => value.update.sessionUpdate === 'agent_message_chunk')).toBe(true)
    await connection.dispose()
    const second = await startAcpConnection({ command: '', args: [], cwd: '', env: {}, key: 'new', remote: { launcher: 'custom', transport: 'websocket', url: peer.url, cwd: '/app/workspace', accessToken: 'acp_fixture_secret' } }, { protocolVersion: 1, clientCapabilities: {} })
    connections.push(second)
    second.bindSession(session.sessionId, handlers())
    await second.loadSession({ sessionId: session.sessionId, cwd: '/app/workspace', mcpServers: [] })
    await second.prompt({ sessionId: session.sessionId, prompt: [{ type: 'text', text: 'Continue' }] })
    expect(peer.received('session/new')).toHaveLength(1)
    expect(peer.received('session/load')).toHaveLength(1)
  })
  it('round-trips a permission request on the open prompt', async () => {
    const { peer, pending } = await start({ permission: true })
    const connection = await pending
    const { sessionId } = await connection.newSession({ cwd: '/app/workspace', mcpServers: [] })
    connection.bindSession(sessionId, handlers())
    await connection.prompt({ sessionId, prompt: [{ type: 'text', text: 'Edit' }] })
    expect(peer.frames.find((frame) => frame.id === 'permission-1')?.result).toEqual({ outcome: { outcome: 'selected', optionId: 'once' } })
  })
  it('cancels with a notification and settles the pending prompt', async () => {
    const { peer, pending } = await start({ hangPrompt: true })
    const connection = await pending
    const { sessionId } = await connection.newSession({ cwd: '/app/workspace', mcpServers: [] })
    connection.bindSession(sessionId, handlers())
    const prompted = connection.prompt({ sessionId, prompt: [{ type: 'text', text: 'Wait' }] })
    await vi.waitFor(() => expect(peer.received('session/prompt')).toHaveLength(1))
    await connection.cancel(sessionId)
    expect(await prompted).toEqual({ stopReason: 'cancelled' })
    expect(peer.received('session/cancel')[0]).not.toHaveProperty('id')
  })
  it('reports failed authentication without echoing the token', async () => {
    const { pending } = await start({ token: 'expected' }, { token: 'acp_wrong_secret' })
    await expect(pending).rejects.toThrow(/endpoint, access token/)
  })
  it('rejects an unsupported negotiated protocol', async () => {
    const { pending } = await start({ version: 99 })
    await expect(pending).rejects.toThrow(/Unsupported ACP protocol version: 99/)
  })
  it('times out and closes a server that never initializes', async () => {
    const { peer, pending } = await start({ hangInitialize: true }, { timeout: 50 })
    await expect(pending).rejects.toThrow(/initialization in time/)
    await vi.waitFor(() => expect(peer.server.clients.size).toBe(0))
  })
  it('aborts initialization and closes the socket', async () => {
    const controller = new AbortController()
    const { peer, pending } = await start({ hangInitialize: true }, { signal: controller.signal })
    const rejected = expect(pending).rejects.toThrow(/canceled/)
    await vi.waitFor(() => expect(peer.received('initialize')).toHaveLength(1))
    controller.abort(); await rejected
    await vi.waitFor(() => expect(peer.server.clients.size).toBe(0))
  })
  it.each(['binary', 'malformed', 'batch', 'oversized'])('closes on %s server traffic', async (kind) => {
    const { peer, pending } = await start()
    const connection = await pending
    const socket = [...peer.server.clients][0]
    socket.send(kind === 'binary' ? Buffer.from('{}') : kind === 'malformed' ? '{' : kind === 'batch' ? '[]' : ' '.repeat(1024 * 1024 + 1))
    await connection.exited
    expect(connection.alive).toBe(false)
    await expect(connection.newSession({ cwd: '/app/workspace', mcpServers: [] })).rejects.toThrow()
  })
})
