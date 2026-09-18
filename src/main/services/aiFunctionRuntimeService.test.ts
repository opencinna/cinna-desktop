import { describe, expect, it, vi } from 'vitest'
import { createAiFunctionRuntime } from './aiFunctionRuntimeService'
import type { AcpConnection, AcpProcessPool, AcpSessionHandlers } from '../agents/drivers/acp/types'
import type { AcpLaunchPlan } from '../agents/drivers/acp/acpLaunchers'

function subject() {
  let handlers: AcpSessionHandlers | undefined
  let sessionCount = 0
  const unbind = vi.fn()
  const release = vi.fn()
  const conn = {
    alive: true, exited: new Promise(() => {}),
    newSession: vi.fn(async () => ({ sessionId: `new-${++sessionCount}` })),
    loadSession: vi.fn(),
    bindSession: vi.fn((_sessionId, received) => { handlers = received; return unbind }),
    setSessionMode: vi.fn(async () => ({})),
    setSessionConfigOption: vi.fn(async () => ({})),
    cancel: vi.fn(async () => {}),
    prompt: vi.fn(async () => {
      handlers?.onUpdate({ sessionId: `new-${sessionCount}`, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'generated output' } } })
      return { stopReason: 'end_turn' }
    })
  } as unknown as AcpConnection
  const pool = { acquire: vi.fn(async () => conn), peek: vi.fn(() => conn), hold: vi.fn(() => release) } as unknown as AcpProcessPool
  const plan: AcpLaunchPlan = {
    spec: { command: 'fake', args: [], cwd: '/synthetic', env: {}, key: 'key' },
    init: { protocolVersion: 1, clientCapabilities: {} }, session: { mcpServers: [] },
    setup: { modeId: 'default' }
  }
  const prepare = vi.fn(async () => ({ poolKey: 'utility', plan, cwd: '/synthetic' }))
  const run = createAiFunctionRuntime({ pool, prepare })
  const input = { userId: 'user', systemPrompt: 'Function', userText: 'Input', warmOnly: false, signal: new AbortController().signal, maxOutputChars: 9 }
  return { run, input, conn, pool, prepare, unbind, release, handlers: () => handlers! }
}

describe('one-shot runtime sessions', () => {
  it('creates fresh sessions on the pooled process, caps text, denies asks and never loads old sessions', async () => {
    const s = subject()
    expect(await s.run(s.input)).toBe('generated')
    expect(await s.run(s.input)).toBe('generated')
    expect(s.conn.newSession).toHaveBeenCalledTimes(2)
    expect(s.conn.newSession).toHaveBeenCalledWith({ cwd: '/synthetic', mcpServers: [] })
    expect(s.conn.loadSession).not.toHaveBeenCalled()
    expect(s.conn.prompt).toHaveBeenLastCalledWith({ sessionId: 'new-2', prompt: [{ type: 'text', text: 'Input' }] })
    expect(await s.handlers().onPermission({} as never)).toEqual({ outcome: { outcome: 'cancelled' } })
    expect(await s.handlers().onElicitation?.({} as never)).toEqual({ action: 'cancel' })
    expect(s.conn.cancel).toHaveBeenCalledWith('new-1')
    expect(s.conn.cancel).toHaveBeenCalledWith('new-2')
    expect(s.unbind).toHaveBeenCalledTimes(2)
    expect(s.release).toHaveBeenCalledTimes(2)
  })
  it('warm-only work never acquires a cold/replaced process', async () => {
    const s = subject()
    vi.mocked(s.pool.peek!).mockReturnValue(undefined)
    await expect(s.run({ ...s.input, warmOnly: true })).rejects.toThrow('deferred')
    expect(s.pool.acquire).not.toHaveBeenCalled()
    expect(s.conn.newSession).not.toHaveBeenCalled()
    vi.mocked(s.pool.peek!).mockReturnValue(s.conn)
    expect(await s.run({ ...s.input, warmOnly: true })).toBe('generated')
    expect(s.pool.acquire).not.toHaveBeenCalled()
  })
  it('cancels a hanging prompt and releases its binding without waiting for the engine', async () => {
    const s = subject()
    vi.mocked(s.conn.prompt).mockImplementation(() => new Promise(() => {}))
    const cancellation = new AbortController()
    const result = s.run({ ...s.input, signal: cancellation.signal })
    const rejected = expect(result).rejects.toThrow('stopped')
    await vi.waitFor(() => expect(s.conn.prompt).toHaveBeenCalledOnce())
    cancellation.abort(new Error('stopped'))
    await rejected
    expect(s.conn.cancel).toHaveBeenCalledWith('new-1')
    expect(s.release).toHaveBeenCalledOnce()
    expect(s.unbind).toHaveBeenCalledOnce()
  })
  it('cancels a session/new result that arrives after the request was aborted without starting its prompt', async () => {
    const s = subject()
    let finish: (session: { sessionId: string }) => void = () => {}
    vi.mocked(s.conn.newSession).mockImplementation(() => new Promise((resolve) => { finish = resolve }))
    const cancellation = new AbortController()
    const result = s.run({ ...s.input, signal: cancellation.signal })
    const rejected = expect(result).rejects.toThrow('stopped')
    await vi.waitFor(() => expect(s.conn.newSession).toHaveBeenCalledOnce())
    cancellation.abort(new Error('stopped'))
    await rejected
    finish({ sessionId: 'late-session' })
    await vi.waitFor(() => expect(s.conn.cancel).toHaveBeenCalledWith('late-session'))
    expect(s.conn.prompt).not.toHaveBeenCalled()
    expect(s.conn.bindSession).not.toHaveBeenCalled()
  })
})
