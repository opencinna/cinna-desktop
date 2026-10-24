import { describe, it, expect, beforeEach, vi } from 'vitest'

/**
 * The marketplace skills adapter: the activation gate, the settings scope for
 * the folder agent, and only strings reaching the service — whatever the
 * renderer sends. Every answer comes back as the service gave it, a refusal
 * included, because a thrown code would not survive IPC.
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
  discover: vi.fn(),
  addToAgent: vi.fn(),
  update: vi.fn(),
  remove: vi.fn(),
  ensurePinned: vi.fn(),
  status: vi.fn()
}))
vi.mock('../services/marketplaceSkillService', () => ({ marketplaceSkillService: service }))

const { registerMarketplaceSkillHandlers } = await import('./marketplaceSkills.ipc')
registerMarketplaceSkillHandlers()

const call = (channel: string, input?: unknown): unknown => handlers.get(channel)!({}, input)

beforeEach(() => {
  activation.activated = true
  for (const fn of Object.values(service)) fn.mockReset()
})

describe('marketplace skills IPC', () => {
  it('registers the four channels (listing and adding go through the addon directory)', () => {
    expect([...handlers.keys()].sort()).toEqual([
      'marketplace-skills:ensure',
      'marketplace-skills:remove',
      'marketplace-skills:status',
      'marketplace-skills:update'
    ])
  })

  it('passes the settings scope and only strings, and hands the service’s answer back as it is', async () => {
    const refusal = { ok: false, code: 'snapshot_missing', message: 'gone' }
    service.update.mockResolvedValue(refusal)
    expect(await call('marketplace-skills:update', { agentId: 'folder:a', name: 'pdf-report' })).toBe(refusal)
    await call('marketplace-skills:update', { agentId: 42, name: { evil: true } })
    expect(service.update).toHaveBeenLastCalledWith('__default__', '', '')

    await call('marketplace-skills:update', { agentId: 'folder:a', name: 'pdf-report' })
    expect(service.update).toHaveBeenCalledWith('__default__', 'folder:a', 'pdf-report')
    await call('marketplace-skills:remove', { agentId: 'folder:a', name: 'pdf-report' })
    expect(service.remove).toHaveBeenCalledWith('__default__', 'folder:a', 'pdf-report')
    await call('marketplace-skills:ensure', { agentId: 'folder:a' })
    expect(service.ensurePinned).toHaveBeenCalledWith('__default__', 'folder:a')
    const status = { ok: true, pins: [{ name: 'pdf-report', entryUuid: 'e-1', state: 'unavailable' }] }
    service.status.mockResolvedValue(status)
    expect(await call('marketplace-skills:status', undefined)).toBe(status)
    expect(service.status).toHaveBeenCalledWith('__default__', '')
  })

  it('refuses before activation, reaching no service', () => {
    activation.activated = false
    expect(() => call('marketplace-skills:status', { agentId: 'a' })).toThrow()
    expect(() => call('marketplace-skills:update', { agentId: 'a', name: 'e' })).toThrow()
    expect(service.status).not.toHaveBeenCalled()
    expect(service.update).not.toHaveBeenCalled()
  })
})
