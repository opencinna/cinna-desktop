import { afterEach, describe, expect, it, vi } from 'vitest'
import { createAcpDriver } from './acpDriver'
import { createAcpProcessPool } from './acpProcessPool'
import { startAcpConnection } from './acpConnection'
import { createCustomLauncher } from './customLauncher'
import { fakeRemoteAcp } from './testSupport/fakeRemoteAcp'
import { goldenRow } from '../__golden__/driverWorld'
import { pendingRequests } from '../pendingRequests'
import type { RunEvent } from '../../../../shared/runEvents'

const cleanups: (() => Promise<void>)[] = []
afterEach(async () => { pendingRequests.clear(); for (const cleanup of cleanups.splice(0)) await cleanup() })
async function world(options: Parameters<typeof fakeRemoteAcp>[0] = {}) {
  const peer = await fakeRemoteAcp({ token: 'acp_fixture', ...options })
  const config = { launcher: 'custom' as const, transport: 'websocket' as const, url: peer.url, cwd: '/app/workspace' }
  const row = goldenRow({ id: 'remote-acp-test', name: 'Remote ACP', source: 'local', driver: 'acp', driverConfig: { ...config }, accessTokenEncrypted: Buffer.from('encrypted') })
  const launcher = createCustomLauncher({ childEnv: async () => { throw new Error('Must not launch a child') }, defaultLocalCwd: () => '/unused' })
  const pool = createAcpProcessPool({ start: startAcpConnection })
  const sessions = new Map<string, string>()
  const events: RunEvent[] = []
  const driver = createAcpDriver({ pool, launcher: () => launcher, withLock: (_id, _owner, fn) => fn(),
    registerRequest: (input) => pendingRequests.register(input), resolveRequest: (id, resolution) => pendingRequests.resolve(id, resolution) !== null,
    readRuntime: () => ({ type: 'external', config, accessToken: 'acp_fixture', binding: 'binding', name: 'Remote', enabled: true,
      validate() {}, readSession: (chat) => sessions.get(chat) ?? null, saveSession: (chat, id) => { sessions.set(chat, id) },
      readiness: async () => null, isGranted: () => false, rememberGrant: () => false }), cancelGraceMs: 100
  })
  cleanups.push(async () => { await pool.shutdown(); await peer.close() })
  const run = (signal = new AbortController().signal) => driver.run('owner', row, { chatId: 'chat', wireContent: 'Hello', signal, onEvent: (event) => events.push(event) })
  const disconnect = async () => { pool.retire(row.id); await vi.waitFor(() => expect(peer.server.clients.size).toBe(0)) }
  return { peer, driver, row, sessions, events, run, disconnect }
}

describe('remote ACP runtime integration', () => {
  it('streams, persists continuity, reuses a live session, and suppresses replay on reconnect', async () => {
    const w = await world()
    expect(w.driver.capabilities(w.row)).toMatchObject({ cwd: false, attachments: 'none', auth: 'token', inputResume: 'reply' })
    expect(await w.run()).toMatchObject({ text: 'Remote partial. Remote answer.' })
    const id = w.sessions.get('chat')
    expect(id).toBeTruthy()
    expect(await w.run()).toMatchObject({ text: 'Remote partial. Remote answer.', contextId: id })
    expect(w.peer.received('session/new')).toHaveLength(1)
    expect(w.peer.received('session/load')).toHaveLength(0)
    await w.disconnect()
    expect(await w.run()).toMatchObject({ text: 'Remote partial. Remote answer.', contextId: id })
    expect(w.peer.received('session/load')).toHaveLength(1)
    expect(w.peer.received('session/new')).toHaveLength(1)
    expect(w.peer.received('session/new')[0].params).toEqual({ cwd: '/app/workspace', mcpServers: [] })
  })
  it('keeps partial output on an unexpected disconnect and does not retry the prompt', async () => {
    const w = await world({ disconnectPrompt: true })
    const result = await w.run()
    expect(result.text).toContain('Remote partial.')
    expect(result.error?.message).toBeTruthy()
    expect(w.peer.received('session/prompt')).toHaveLength(1)
  })
  it('delivers an in-session permission answer', async () => {
    const w = await world({ permission: true })
    const running = w.run()
    await vi.waitFor(() => expect(w.events.some((event) => event.type === 'needs_input')).toBe(true))
    const ask = w.events.find((event) => event.type === 'needs_input')!
    if (ask.type !== 'needs_input') throw new Error('No ask')
    const owner = pendingRequests.owner(ask.requestId)!
    expect(w.driver.respond({ requestId: ask.requestId, ...owner }, { kind: 'permission', reply: 'once' })).toEqual({ delivered: true })
    expect((await running).error).toBeUndefined()
    const next = w.run()
    await vi.waitFor(() => expect(w.events.filter((event) => event.type === 'needs_input')).toHaveLength(2))
    const secondAsk = w.events.filter((event) => event.type === 'needs_input')[1]
    const secondOwner = pendingRequests.owner(secondAsk.requestId)!
    expect(w.driver.respond({ requestId: secondAsk.requestId, ...secondOwner }, { kind: 'permission', reply: 'once' })).toEqual({ delivered: true })
    expect((await next).error).toBeUndefined()
    expect(w.peer.frames.find((frame) => frame.id === 'permission-1')?.result).toEqual({ outcome: { outcome: 'selected', optionId: 'once' } })
  })
  it('stops the actual remote prompt on abort', async () => {
    const w = await world({ hangPrompt: true })
    const controller = new AbortController()
    const running = w.run(controller.signal)
    await vi.waitFor(() => expect(w.peer.received('session/prompt')).toHaveLength(1))
    controller.abort()
    expect(await running).toMatchObject({ taskState: 'canceled' })
    expect(w.peer.received('session/cancel')).toHaveLength(1)
  })
  it('surfaces a denied load without silently creating another session', async () => {
    const w = await world({ refuseLoad: true })
    await w.run(); await w.disconnect()
    expect((await w.run()).error?.message).toBeTruthy()
    expect(w.peer.received('session/new')).toHaveLength(1)
    expect(w.peer.received('session/prompt')).toHaveLength(1)
  })
  it('supports servers without loadSession while connected and explains loss on disconnect', async () => {
    const w = await world({ loadSession: false })
    await w.run(); await w.run()
    expect(w.peer.received('session/new')).toHaveLength(1)
    await w.disconnect()
    expect((await w.run()).error?.message).toContain('cannot reload sessions')
    expect(w.peer.received('session/new')).toHaveLength(1)
  })
})
