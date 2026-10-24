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
const service = vi.hoisted(() => ({ upsert: vi.fn(async () => ({ id: 'm1' })) }))
vi.mock('../services/mcpService', () => ({ mcpService: service }))
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
