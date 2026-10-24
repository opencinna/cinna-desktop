import { describe, it, expect, beforeEach, vi } from 'vitest'

/**
 * `mcp:upsert` passes a well-formed registry ref (the MCP registry entry a
 * new connector is made from) and drops anything else the renderer sends.
 */

const handlers = vi.hoisted(() => new Map<string, (...args: unknown[]) => unknown>())
vi.mock('./_wrap', () => ({
  ipcHandle: (channel: string, fn: (...args: unknown[]) => unknown) => {
    handlers.set(channel, fn)
  }
}))
vi.mock('../auth/activation', () => ({ userActivation: { requireActivated: () => undefined } }))
vi.mock('../auth/scope', () => ({ getSettingsScopeUserId: () => '__default__' }))
const service = vi.hoisted(() => ({ upsert: vi.fn(async (): Promise<unknown> => ({ id: 'm1' })), delete: vi.fn(async (): Promise<unknown> => ({ ok: true })) }))
vi.mock('../services/mcpService', async () => ({
  mcpService: service,
  managedRefusalOf: (await vi.importActual<typeof import('../services/mcpService')>('../services/mcpService')).managedRefusalOf
}))
vi.mock('../services/mcpRegistryService', () => ({ mcpRegistryService: {} }))
vi.mock('../services/agentMcpService', () => ({ agentMcpService: {} }))

const { registerMcpHandlers } = await import('./mcp.ipc')
registerMcpHandlers()

const upsert = (data: unknown): unknown => handlers.get('mcp:upsert')!({}, data)
const BASE = { name: 'Granola', transportType: 'streamable-http', url: 'https://g.example/mcp', enabled: true }

beforeEach(() => service.upsert.mockClear())

describe('mcp:upsert registryRef', () => {
  it('passes a well-formed ref, without extra keys', async () => {
    expect(await upsert({ ...BASE, registryRef: { source: 'mcp-registry:official', id: 'io.x/a', evil: 1 } })).toEqual({ id: 'm1', success: true })
    expect(service.upsert).toHaveBeenCalledWith('__default__', { ...BASE, registryRef: { source: 'mcp-registry:official', id: 'io.x/a' } })
  })

  it('drops a malformed one', async () => {
    for (const registryRef of [undefined, 'mcp-registry:official', { source: '', id: 'x' }, { source: 'x' }]) {
      await upsert({ ...BASE, registryRef })
      expect(service.upsert).toHaveBeenLastCalledWith('__default__', BASE)
    }
  })
})

describe('a plugin’s connector over mcp:upsert and mcp:delete', () => {
  it('answers a refused edit as data, not a throw', async () => {
    const { McpError } = await import('../errors')
    service.upsert.mockRejectedValueOnce(new McpError('managed_provider', 'This connector comes with a plugin.'))
    expect(await upsert({ ...BASE, id: 'm1' })).toEqual({ id: 'm1', ok: false, success: false, code: 'managed', message: 'This connector comes with a plugin.' })
  })

  it('answers a refused delete as data', async () => {
    service.delete.mockResolvedValueOnce({ ok: false, code: 'managed', message: 'It goes with its plugin.' })
    expect(await handlers.get('mcp:delete')!({}, 'm1')).toEqual({ ok: false, success: false, code: 'managed', message: 'It goes with its plugin.' })
    expect(await handlers.get('mcp:delete')!({}, 'm2')).toEqual({ ok: true, success: true })
  })
})
