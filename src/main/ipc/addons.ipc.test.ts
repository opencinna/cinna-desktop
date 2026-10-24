import { describe, it, expect, beforeEach, vi } from 'vitest'

/**
 * The addon directory adapter: the activation gate, the settings scope, only
 * strings and a well-formed ref reaching the service — whatever the renderer
 * sends — and every answer handed back as data.
 */

const handlers = vi.hoisted(() => new Map<string, (...args: unknown[]) => unknown>())
vi.mock('./_wrap', () => ({
  ipcHandle: (channel: string, fn: (...args: unknown[]) => unknown) => {
    handlers.set(channel, fn)
  }
}))
const activation = vi.hoisted(() => ({ activated: true }))
vi.mock('../auth/activation', () => ({
  userActivation: {
    requireActivated: () => {
      if (!activation.activated) throw new Error('not activated')
    }
  }
}))
vi.mock('../auth/scope', () => ({ getSettingsScopeUserId: () => '__default__' }))

const service = vi.hoisted(() => ({
  list: vi.fn(),
  search: vi.fn(),
  add: vi.fn(),
  remove: vi.fn()
}))
vi.mock('../services/addonDirectory', () => ({ addonDirectory: service }))

const { registerAddonHandlers } = await import('./addons.ipc')
registerAddonHandlers()

const call = (channel: string, input?: unknown): unknown => handlers.get(channel)!({}, input)
const REF = { source: 'core-catalog', id: 'pkg-1' }

beforeEach(() => {
  activation.activated = true
  for (const fn of Object.values(service)) fn.mockReset()
})

describe('addons IPC', () => {
  it('registers the four channels', () => {
    expect([...handlers.keys()].sort()).toEqual(['addons:add', 'addons:directory', 'addons:remove', 'addons:search'])
  })

  it('passes the settings scope and only strings, and hands the answer back as it is', async () => {
    const refusal = { ok: false, code: 'not_found', message: 'gone' }
    service.list.mockResolvedValue(refusal)
    expect(await call('addons:directory', { agentId: 'folder:a' })).toBe(refusal)
    expect(service.list).toHaveBeenCalledWith('__default__', 'folder:a', { refresh: false })
    await call('addons:directory', { agentId: 'folder:a', refresh: true })
    expect(service.list).toHaveBeenLastCalledWith('__default__', 'folder:a', { refresh: true })
    await call('addons:directory', { agentId: 'folder:a', refresh: 'yes' })
    expect(service.list).toHaveBeenLastCalledWith('__default__', 'folder:a', { refresh: false })

    service.search.mockResolvedValue({ ok: true, entries: [], sources: [] })
    await call('addons:search', { agentId: 7, query: { evil: true } })
    expect(service.search).toHaveBeenCalledWith('__default__', '', '')

    service.add.mockResolvedValue({ ok: true, next: 'oauth', mcpProviderId: 'm1' })
    expect(await call('addons:add', { agentId: 'folder:a', ref: { ...REF, extra: 'dropped' } })).toEqual({ ok: true, next: 'oauth', mcpProviderId: 'm1' })
    expect(service.add).toHaveBeenCalledWith('__default__', 'folder:a', REF)

    service.remove.mockResolvedValue({ ok: true, next: null })
    await call('addons:remove', { agentId: 'folder:a', ref: REF })
    expect(service.remove).toHaveBeenCalledWith('__default__', 'folder:a', REF)
  })

  it('refuses a malformed ref as data without asking the service', async () => {
    for (const channel of ['addons:add', 'addons:remove']) {
      for (const ref of [undefined, 'core-catalog', { source: 'core-catalog' }, { source: '', id: 'x' }, { source: 1, id: 'x' }]) {
        expect(await call(channel, { agentId: 'folder:a', ref })).toMatchObject({ ok: false, code: 'invalid_ref' })
      }
    }
    expect(service.add).not.toHaveBeenCalled()
    expect(service.remove).not.toHaveBeenCalled()
  })

  it('caps the query', async () => {
    service.search.mockResolvedValue({ ok: true, entries: [], sources: [] })
    await call('addons:search', { agentId: 'folder:a', query: 'x'.repeat(500) })
    expect(service.search.mock.calls[0][2]).toHaveLength(200)
  })

  it('is gated on activation', async () => {
    activation.activated = false
    for (const channel of handlers.keys()) {
      await expect(async () => call(channel, { agentId: 'folder:a', ref: REF })).rejects.toThrow('not activated')
    }
    expect(service.list).not.toHaveBeenCalled()
  })
})
