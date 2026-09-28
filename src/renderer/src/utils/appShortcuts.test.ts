import { describe, it, expect } from 'vitest'
import { resolveShortcutAgent, startableAgent, truncateName, type ShortcutScreen } from './appShortcuts'

/**
 * ⇧⌘N carries over the agent of the chat or agent page on screen, and only an
 * agent a new chat can actually be started with.
 */

const agents = [
  { id: 'alpha', name: 'Alpha', enabled: true },
  { id: 'off', name: 'Off', enabled: false },
  { id: 'conductor', name: 'Conductor', enabled: true, conductor: true },
  { id: 'folder:beta', name: 'Beta', enabled: true }
]

function screen(over: Partial<ShortcutScreen>): ShortcutScreen {
  return { activeView: 'chat', chat: null, activeExternalAgentId: null, activeLocalAgentId: null, ...over }
}

describe('resolveShortcutAgent', () => {
  it('takes the agent of a direct chat', () => {
    expect(resolveShortcutAgent(screen({ chat: { router: 'direct', agentId: 'alpha' } }), agents)).toBe('alpha')
  })

  it('has no agent for a direct chat with the model', () => {
    expect(resolveShortcutAgent(screen({ chat: { router: 'direct', agentId: null } }), agents)).toBeNull()
  })

  it('has no agent for a coordinator or a human-routed chat', () => {
    expect(resolveShortcutAgent(screen({ chat: { router: 'coordinator', agentId: 'alpha' } }), agents)).toBeNull()
    expect(resolveShortcutAgent(screen({ chat: { router: 'human', agentId: 'alpha' } }), agents)).toBeNull()
  })

  it('has no agent on the new-chat screen', () => {
    expect(resolveShortcutAgent(screen({ chat: null }), agents)).toBeNull()
  })

  it('takes the page agent on an agent page', () => {
    expect(resolveShortcutAgent(screen({ activeView: 'external-agent', activeExternalAgentId: 'alpha' }), agents)).toBe('alpha')
    expect(resolveShortcutAgent(screen({ activeView: 'local-agent', activeLocalAgentId: 'folder:beta' }), agents)).toBe('folder:beta')
  })

  it('ignores the chat and page ids on any other screen', () => {
    expect(
      resolveShortcutAgent(
        screen({ activeView: 'settings', chat: { router: 'direct', agentId: 'alpha' }, activeExternalAgentId: 'alpha' }),
        agents
      )
    ).toBeNull()
  })

  it('refuses a disabled, internal or unlisted agent', () => {
    expect(resolveShortcutAgent(screen({ chat: { router: 'direct', agentId: 'off' } }), agents)).toBeNull()
    expect(resolveShortcutAgent(screen({ chat: { router: 'direct', agentId: 'conductor' } }), agents)).toBeNull()
    expect(resolveShortcutAgent(screen({ activeView: 'external-agent', activeExternalAgentId: 'gone' }), agents)).toBeNull()
  })
})

describe('startableAgent', () => {
  it('returns the row only when it is listed, enabled and not a conductor', () => {
    expect(startableAgent(agents, 'alpha')?.name).toBe('Alpha')
    expect(startableAgent(agents, 'off')).toBeNull()
    expect(startableAgent(agents, null)).toBeNull()
  })
})

describe('truncateName', () => {
  it('keeps a short name and shortens a long one to the limit', () => {
    expect(truncateName('Alpha')).toBe('Alpha')
    const long = truncateName('A very long agent name that goes on')
    expect(long.length).toBeLessThanOrEqual(24)
    expect(long.endsWith('…')).toBe(true)
  })
})
