import { describe, expect, it } from 'vitest'
import { nextAgentAfterHiding, sidebarAgentOrder } from './agentNavigation'

const local = {
  roots: [{ id: 'home', isDefault: true, createdAt: 0 }, { id: 'other', isDefault: false, createdAt: 1 }],
  agents: [{ id: 'folder:z', rootId: 'home', name: 'Z' }, { id: 'folder:a', rootId: 'home', name: 'A' }, { id: 'folder:other', rootId: 'other', name: 'Other' }]
}
const remote = (id: string, enabled = true) => ({ id, source: 'remote', enabled })

describe('navigation after hiding an agent', () => {
  it('uses the sidebar order and skips agents already hidden', () => {
    const order = sidebarAgentOrder([remote('first'), remote('hidden', false), remote('second'), { id: 'a2a', source: 'local', protocol: 'a2a', enabled: true }] as never, local as never)
    expect(order.map((agent) => agent.id)).toEqual(['folder:a', 'folder:z', 'first', 'second', 'folder:other', 'a2a'])
    expect(nextAgentAfterHiding(order, 'second')?.id).toBe('first')
    expect(nextAgentAfterHiding(order, 'first')?.id).toBe('folder:z')
    expect(nextAgentAfterHiding(order, 'a2a')?.id).toBe('folder:other')
  })
  it('selects the next available agent when the first one is hidden', () => {
    expect(nextAgentAfterHiding([remote('first'), remote('second')], 'first')?.id).toBe('second')
  })
  it('returns the starting screen when the last agent is hidden', () => {
    expect(nextAgentAfterHiding([remote('only')], 'only')).toBeNull()
    expect(nextAgentAfterHiding([], 'missing')).toBeNull()
  })
})
