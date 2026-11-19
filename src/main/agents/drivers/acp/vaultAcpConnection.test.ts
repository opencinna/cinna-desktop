import { describe, expect, it, vi } from 'vitest'
import type { VaultdNotification } from '../../../../shared/vault/protocol'
import { startVaultAcpConnection, type VaultEngineClient } from './vaultAcpConnection'
import { VaultdError } from '../../../vault/vaultdClient'
import { ACP_PROTOCOL_VERSION } from './types'

vi.mock('../../../logger/logger', () => ({
  createLogger: () => ({ debug: () => {}, info: () => {}, warn: () => {}, error: () => {} }),
  setLogValueRedactor: () => {}
}))

const INIT = { protocolVersion: ACP_PROTOCOL_VERSION, clientCapabilities: {}, clientInfo: { name: 'test', version: '1' } }
const LAUNCH = { agentId: 'folder:a', vaultId: 'v1', engine: 'claude' as const, extraEnv: {} }

/**
 * A vaultd control client and one attached engine stream, in memory. The
 * engine answers `initialize` (unless `silent`) and `session/new`, and stays
 * quiet otherwise: what a paused VM looks like from main.
 */
function fakeVault(options: { silent?: boolean; authenticate?: 'ok' | 'reject' | 'hang'; providerErrors?: (params: unknown) => unknown } = {}) {
  const engineMethods: string[] = []
  const listeners = new Set<(n: VaultdNotification) => void>()
  const calls: { method: string; params: unknown }[] = []
  const toEngine = new TransformStream<Uint8Array, Uint8Array>()
  const fromEngine = new TransformStream<Uint8Array, Uint8Array>()
  const engineOut = fromEngine.writable.getWriter()
  let channelClosed = false
  const encoder = new TextEncoder()
  const send = (message: unknown): Promise<void> => engineOut.write(encoder.encode(JSON.stringify({ jsonrpc: '2.0', ...(message as object) }) + '\n'))
  void (async () => {
    const reader = toEngine.readable.getReader()
    const decoder = new TextDecoder()
    let buffered = ''
    for (;;) {
      const { value, done } = await reader.read().catch(() => ({ value: undefined, done: true as const }))
      if (done) return
      buffered += decoder.decode(value, { stream: true })
      let nl: number
      while ((nl = buffered.indexOf('\n')) >= 0) {
        const msg = JSON.parse(buffered.slice(0, nl)) as { id?: number; method: string }
        buffered = buffered.slice(nl + 1)
        if (msg.id === undefined) continue
        engineMethods.push(msg.method)
        if (msg.method === 'authenticate' && options.authenticate !== 'hang') await send(options.authenticate === 'reject'
          ? { id: msg.id, error: { code: -32000, message: 'Authentication required', data: { message: 'API key not valid. Please pass a valid API key.' } } }
          : { id: msg.id, result: {} })
        if (msg.method === 'initialize' && !options.silent) await send({ id: msg.id, result: { protocolVersion: ACP_PROTOCOL_VERSION, agentCapabilities: {} } })
        if (msg.method === 'session/new') await send({ id: msg.id, result: { sessionId: 's-1' } })
      }
    }
  })()
  const client: VaultEngineClient = {
    request: (async (method: string, params: unknown) => {
      calls.push({ method, params })
      if (method === 'engine.spawn') return { stream: 'stream-1', pid: 7 }
      if (method === 'engine.providerErrors' && options.providerErrors) return options.providerErrors(params)
      return {}
    }) as VaultEngineClient['request'],
    attach: async () => ({
      readable: fromEngine.readable,
      writable: toEngine.writable,
      close: () => {
        channelClosed = true
        void engineOut.close().catch(() => {})
      }
    }),
    onNotification: (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    }
  }
  return {
    client,
    calls,
    engineMethods,
    get channelClosed() { return channelClosed },
    exit: (code: number | null, stderrTail: string) => {
      for (const listener of listeners) listener({ method: 'engine.exit', params: { stream: 'stream-1', code, signal: null, stderrTail } })
    },
    endStream: () => engineOut.close(),
    listeners
  }
}

describe('VaultAcpConnection', () => {
  it('spawns the engine in the vault, completes initialize over the attached stream, and settles exited on engine.exit', async () => {
    const vault = fakeVault()
    const connection = await startVaultAcpConnection(LAUNCH, INIT, { client: async () => vault.client })
    expect(vault.calls[0]).toEqual({ method: 'engine.spawn', params: { engine: 'claude', options: { extraEnv: {} } } })
    expect(connection.pid).toBeUndefined()
    expect(connection.alive).toBe(true)
    expect(await connection.newSession({ cwd: '/vault/agent', mcpServers: [] })).toEqual({ sessionId: 's-1' })
    // Another stream's exit is not this one's.
    for (const listener of vault.listeners) listener({ method: 'engine.exit', params: { stream: 'other', code: 0, signal: null, stderrTail: '' } })
    expect(connection.alive).toBe(true)
    vault.exit(3, 'adapter crashed')
    expect(await connection.exited).toEqual({ code: 3, signal: null, stderrTail: 'adapter crashed' })
    expect(connection.alive).toBe(false)
    expect(connection.stderrTail()).toBe('adapter crashed')
  })

  it('rejects with the stderr tail when the engine exits before answering initialize, and kills nothing twice', async () => {
    const vault = fakeVault({ silent: true })
    const starting = startVaultAcpConnection(LAUNCH, INIT, { client: async () => vault.client })
    await vi.waitFor(() => expect(vault.listeners.size).toBe(1))
    await vi.waitFor(() => expect(vault.calls.some((c) => c.method === 'engine.spawn')).toBe(true))
    vault.exit(1, 'Cannot find module claude-agent-acp')
    await expect(starting).rejects.toThrow(/exited \(code 1\) before answering initialize[\s\S]*Cannot find module/)
    expect(vault.channelClosed).toBe(true)
    // It had exited: no engine.kill for a dead engine.
    expect(vault.calls.map((c) => c.method)).toEqual(['engine.spawn'])
    expect(vault.listeners.size).toBe(0)
  })

  it('times out an engine that never answers initialize, killing it', async () => {
    const vault = fakeVault({ silent: true })
    await expect(startVaultAcpConnection(LAUNCH, INIT, { client: async () => vault.client, startTimeoutMs: 50 })).rejects.toThrow(/did not answer initialize within 50 ms/)
    expect(vault.calls.map((c) => c.method)).toEqual(['engine.spawn', 'engine.kill'])
    expect(vault.channelClosed).toBe(true)
  })

  it('dispose kills the engine in the vault, closes the stream and settles exited', async () => {
    const vault = fakeVault()
    const connection = await startVaultAcpConnection(LAUNCH, INIT, { client: async () => vault.client })
    await connection.dispose()
    expect(vault.calls.find((c) => c.method === 'engine.kill')).toEqual({ method: 'engine.kill', params: { stream: 'stream-1' } })
    expect(vault.channelClosed).toBe(true)
    expect(connection.alive).toBe(false)
    await expect(connection.exited).resolves.toMatchObject({ code: null })
  })

  it('treats a silent stream as a stall, not an exit (a locked vault pauses its VM)', async () => {
    const vault = fakeVault()
    const connection = await startVaultAcpConnection(LAUNCH, INIT, { client: async () => vault.client, exitGraceMs: 20 })
    let exited = false
    void connection.exited.then(() => { exited = true })
    await new Promise((resolve) => setTimeout(resolve, 150))
    expect(exited).toBe(false)
    expect(connection.alive).toBe(true)
    // Still answers after the stall.
    expect(await connection.newSession({ cwd: '/vault/agent', mcpServers: [] })).toEqual({ sessionId: 's-1' })
  })

  it('settles exited when the stream ends without an engine.exit (after a short grace)', async () => {
    const vault = fakeVault()
    const connection = await startVaultAcpConnection(LAUNCH, INIT, { client: async () => vault.client, exitGraceMs: 20 })
    await vault.endStream()
    expect(await connection.exited).toEqual({ code: null, signal: null, stderrTail: '' })
    expect(connection.alive).toBe(false)
  })

  it('signs in with the launch\'s ACP method right after initialize, before any session', async () => {
    const vault = fakeVault({ authenticate: 'ok' })
    const connection = await startVaultAcpConnection({ ...LAUNCH, engine: 'antigravity', authMethod: 'gemini-api-key' }, INIT, { client: async () => vault.client })
    await connection.newSession({ cwd: '/vault/agent', mcpServers: [] })
    expect(vault.engineMethods).toEqual(['initialize', 'authenticate', 'session/new'])
    await connection.dispose()
    // Without a method, nothing is sent.
    const plain = fakeVault()
    const other = await startVaultAcpConnection(LAUNCH, INIT, { client: async () => plain.client })
    expect(plain.engineMethods).toEqual(['initialize'])
    await other.dispose()
  })

  it('gives up a sign-in the engine never answers: on the start deadline, on its exit, and on cancel', async () => {
    const launch = { ...LAUNCH, engine: 'antigravity' as const, authMethod: 'gemini-api-key' }
    const timedOut = fakeVault({ authenticate: 'hang' })
    await expect(startVaultAcpConnection(launch, INIT, { client: async () => timedOut.client, startTimeoutMs: 100 }))
      .rejects.toThrow(/did not answer authenticate within 100 ms/)
    expect(timedOut.calls.map((c) => c.method)).toEqual(['engine.spawn', 'engine.kill'])
    expect(timedOut.channelClosed).toBe(true)

    const died = fakeVault({ authenticate: 'hang' })
    const starting = startVaultAcpConnection(launch, INIT, { client: async () => died.client })
    await vi.waitFor(() => expect(died.engineMethods).toContain('authenticate'))
    died.exit(1, 'agy: bad key')
    await expect(starting).rejects.toThrow(/exited \(code 1\) before answering authenticate[\s\S]*agy: bad key/)

    const canceled = fakeVault({ authenticate: 'hang' })
    const controller = new AbortController()
    const pending = startVaultAcpConnection(launch, INIT, { client: async () => canceled.client, signal: controller.signal })
    await vi.waitFor(() => expect(canceled.engineMethods).toContain('authenticate'))
    controller.abort()
    await expect(pending).rejects.toThrow(/start was canceled/)
    expect(canceled.calls.map((c) => c.method)).toContain('engine.kill')
  })

  it('fails the start in words when the engine refuses the sign-in, and stops the engine', async () => {
    const vault = fakeVault({ authenticate: 'reject' })
    await expect(startVaultAcpConnection({ ...LAUNCH, engine: 'antigravity', authMethod: 'gemini-api-key' }, INIT, { client: async () => vault.client }))
      .rejects.toThrow("The vault's antigravity engine could not sign in (gemini-api-key): API key not valid. Please pass a valid API key.")
    expect(vault.calls.map((c) => c.method)).toContain('engine.kill')
    expect(vault.channelClosed).toBe(true)
  })

  it('asks vaultd for a vault Antigravity engine’s provider errors on its own stream, as a span since the prompt', async () => {
    let answer: () => unknown = () => ({ errors: [] })
    const vault = fakeVault({ authenticate: 'ok', providerErrors: () => answer() })
    const connection = await startVaultAcpConnection({ ...LAUNCH, engine: 'antigravity', authMethod: 'gemini-api-key' }, INIT, { client: async () => vault.client })
    const since = Date.now() - 7_000
    expect(await connection.providerErrors!('s-1', since)).toEqual({ errors: [] })
    const sent = vault.calls.at(-1) as { method: string; params: { stream: string; sessionId: string; sinceAgoMs: number } }
    expect(sent.method).toBe('engine.providerErrors')
    expect(sent.params).toMatchObject({ stream: 'stream-1', sessionId: 's-1' })
    // Mutation: send the host's date → a drifted guest clock compares it with its own.
    expect(sent.params.sinceAgoMs).toBeGreaterThanOrEqual(7_000)
    expect(sent.params.sinceAgoMs).toBeLessThan(8_000)
    expect(Object.keys(sent.params)).not.toContain('since')
    // A prompt "in the future" (a clock step back on the host): never negative.
    await connection.providerErrors!('s-1', Date.now() + 60_000)
    expect((vault.calls.at(-1)!.params as { sinceAgoMs: number }).sinceAgoMs).toBe(0)

    // Any failure but "Method not found" is a quiet empty poll, and the next poll asks again.
    answer = () => { throw new VaultdError('timeout', 'cinna-vaultd did not answer engine.providerErrors in time.') }
    expect(await connection.providerErrors!('s-1', since)).toEqual({ errors: [] })
    answer = () => { throw new VaultdError('invalid', 'Not a running Antigravity engine.', -32000) }
    expect(await connection.providerErrors!('s-1', since)).toEqual({ errors: [] })
    answer = () => ({ errors: [] })
    expect(await connection.providerErrors!('s-1', since)).toEqual({ errors: [] })
    expect(vault.calls.filter((c) => c.method === 'engine.providerErrors')).toHaveLength(5)
    await connection.dispose()
  })

  it('stops asking an older guest at its "Method not found"', async () => {
    // As VaultdClient rejects a JSON-RPC -32601: code `internal`, the RPC code carried.
    const vault = fakeVault({ authenticate: 'ok', providerErrors: () => { throw new VaultdError('internal', 'Method not found', -32601) } })
    const connection = await startVaultAcpConnection({ ...LAUNCH, engine: 'antigravity', authMethod: 'gemini-api-key' }, INIT, { client: async () => vault.client })
    // Mutation: drop the `providerErrorsUnsupported` mark → every poll asks the old guest again.
    expect(await connection.providerErrors!('s-1', 42)).toBeNull()
    expect(await connection.providerErrors!('s-1', 42)).toBeNull()
    expect(vault.calls.filter((c) => c.method === 'engine.providerErrors')).toHaveLength(1)
    await connection.dispose()
  })

  it('offers no provider-error read for another engine', async () => {
    const vault = fakeVault()
    const connection = await startVaultAcpConnection(LAUNCH, INIT, { client: async () => vault.client })
    expect(connection.providerErrors).toBeUndefined()
    await connection.dispose()
  })
})
