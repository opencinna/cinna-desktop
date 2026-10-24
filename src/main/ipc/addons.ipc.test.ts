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
  remove: vi.fn(),
  mcpRequirements: vi.fn()
}))
vi.mock('../services/addonDirectory', () => ({ addonDirectory: service }))
const plugins = vi.hoisted(() => ({ status: vi.fn(), setDisabled: vi.fn(), update: vi.fn(), reveal: vi.fn() }))
vi.mock('../services/marketplacePluginService', () => ({ marketplacePluginService: plugins }))
const runtimes = vi.hoisted(() => ({ recheck: vi.fn(async () => ({ node: true, docker: false })) }))
vi.mock('../services/stdioRuntimes', () => ({ stdioRuntimes: runtimes }))
const requirements = vi.hoisted(() => ({ removeRequirementByName: vi.fn() }))
vi.mock('../services/addonDirectory/requirements', () => requirements)

const { registerAddonHandlers } = await import('./addons.ipc')
registerAddonHandlers()

const call = (channel: string, input?: unknown): unknown => handlers.get(channel)!({}, input)
const REF = { source: 'core-catalog', id: 'pkg-1' }

beforeEach(() => {
  activation.activated = true
  for (const fn of Object.values(service)) fn.mockReset()
  for (const fn of Object.values(plugins)) fn.mockReset()
  runtimes.recheck.mockClear()
  requirements.removeRequirementByName.mockReset()
})

describe('addons:remove-requirement', () => {
  it('hands the service the agent and the name, and answers a missing name as data', async () => {
    requirements.removeRequirementByName.mockResolvedValue({ ok: true, next: null })
    expect(await call('addons:remove-requirement', { agentId: 'folder:a', name: 'fs', extra: 1 })).toEqual({ ok: true, next: null })
    expect(requirements.removeRequirementByName).toHaveBeenCalledWith('__default__', 'folder:a', 'fs')
    expect(await call('addons:remove-requirement', { agentId: 'folder:a', name: 7 })).toMatchObject({ ok: false, code: 'invalid_name' })
    expect(requirements.removeRequirementByName).toHaveBeenCalledTimes(1)
    activation.activated = false
    expect(() => call('addons:remove-requirement', { agentId: 'folder:a', name: 'fs' })).toThrow('not activated')
  })
})

describe('addons IPC', () => {
  it('registers the channels', () => {
    expect([...handlers.keys()].sort()).toEqual([
      'addons:add',
      'addons:directory',
      'addons:mcp-requirements',
      'addons:plugin-status',
      'addons:recheck-runtimes',
      'addons:remove',
      'addons:remove-requirement',
      'addons:reveal-plugin',
      'addons:search',
      'addons:set-plugin-disabled',
      'addons:update-plugin'
    ])
  })

  it('hands the plugin verbs only well-typed input', async () => {
    plugins.status.mockResolvedValue({ ok: true, plugins: [] })
    await call('addons:plugin-status', { agentId: 'folder:a' })
    expect(plugins.status).toHaveBeenCalledWith('__default__', 'folder:a')
    plugins.setDisabled.mockResolvedValue({ ok: true, name: 'p', archiveSha256: 'x', next: null })
    await call('addons:set-plugin-disabled', { agentId: 'folder:a', name: 'p', disabled: { hooks: 'yes', mcpServers: ['a', 3], skills: ['s'], extra: 1 } })
    expect(plugins.setDisabled).toHaveBeenCalledWith('__default__', 'folder:a', 'p', { mcpServers: ['a'], skills: ['s'] })
    await call('addons:set-plugin-disabled', { agentId: 'folder:a', name: 'p', disabled: { hooks: true } })
    expect(plugins.setDisabled).toHaveBeenLastCalledWith('__default__', 'folder:a', 'p', { hooks: true })
    plugins.update.mockResolvedValue({ ok: true })
    await call('addons:update-plugin', { agentId: 'folder:a', name: 9 })
    expect(plugins.update).toHaveBeenCalledWith('__default__', 'folder:a', '')
    expect(await call('addons:recheck-runtimes')).toEqual({ ok: true, node: true, docker: false })
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

  it('asks the requirements of one agent by a string id, and hands the answer back as it is', async () => {
    const answer = { ok: true, items: [] }
    service.mcpRequirements.mockResolvedValue(answer)
    expect(await call('addons:mcp-requirements', { agentId: 'a1' })).toBe(answer)
    expect(service.mcpRequirements).toHaveBeenLastCalledWith('__default__', 'a1')
    await call('addons:mcp-requirements', { agentId: { evil: true } })
    expect(service.mcpRequirements).toHaveBeenLastCalledWith('__default__', '')
  })

  it('reveals a plugin by string agent id and name only, answering as data', async () => {
    plugins.reveal.mockReturnValue({ ok: true })
    expect(await call('addons:reveal-plugin', { agentId: 'a1', name: 'carbone' })).toEqual({ ok: true })
    expect(plugins.reveal).toHaveBeenLastCalledWith('__default__', 'a1', 'carbone')
    await call('addons:reveal-plugin', { agentId: 1, name: ['x'] })
    expect(plugins.reveal).toHaveBeenLastCalledWith('__default__', '', '')
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
    expect(plugins.status).not.toHaveBeenCalled()
    expect(runtimes.recheck).not.toHaveBeenCalled()
  })
})
