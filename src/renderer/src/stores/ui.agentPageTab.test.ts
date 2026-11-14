import { describe, expect, it, vi } from 'vitest'

vi.hoisted(() => {
  window.matchMedia = vi.fn(() => ({
    matches: false,
    addEventListener: () => {},
    removeEventListener: () => {}
  })) as unknown as typeof window.matchMedia
  window.api = { app: { setTheme: vi.fn().mockResolvedValue({ success: true }) } } as unknown as typeof window.api
})

import { normalizeAgentPageTab, useUIStore } from './ui.store'

/**
 * The Permissions tab became Security when Agent Vault moved into it (D9).
 * A caller written before the rename — or an old deep link — still asks for
 * `permissions`, and must land on the same tab rather than on Overview.
 */
describe('agent page tab requests', () => {
  it('maps the old Permissions name to Security', () => {
    expect(normalizeAgentPageTab('permissions')).toBe('security')
    expect(normalizeAgentPageTab('security')).toBe('security')
    expect(normalizeAgentPageTab('credentials')).toBe('credentials')
  })

  it('stores a permissions request as security, and clears with null', () => {
    useUIStore.getState().setAgentPageTabRequest('permissions')
    expect(useUIStore.getState().agentPageTabRequest).toBe('security')
    useUIStore.getState().setAgentPageTabRequest('tasks')
    expect(useUIStore.getState().agentPageTabRequest).toBe('tasks')
    useUIStore.getState().setAgentPageTabRequest(null)
    expect(useUIStore.getState().agentPageTabRequest).toBeNull()
  })
})
