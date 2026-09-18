import { describe, expect, it } from 'vitest'
import type { SessionNotification } from '@agentclientprotocol/sdk'
import { ConductorToolCorrelation } from './conductorToolCorrelation'
const frame = (id: string, name: string): SessionNotification => ({ sessionId: 's', update: { sessionUpdate: 'tool_call', toolCallId: id, title: `mcp.cinna.${name}`, status: 'in_progress', rawInput: { server: 'cinna', tool: name } } })
describe('Cinna tool correlation', () => {
  it('matches concurrent Codex calls by name and arrival order without reusing an id', () => {
    const tracker = new ConductorToolCorrelation()
    tracker.observe(frame('one', 'search'))
    tracker.observe(frame('two', 'search'))
    tracker.observe(frame('three', 'read'))
    expect(tracker.claim('read', 'fallback')).toBe('three')
    expect(tracker.claim('search', 'fallback')).toBe('one')
    expect(tracker.claim('search', 'fallback')).toBe('two')
    expect(tracker.claim('search', 'next')).toBe('next')
  })
  it('suppresses delayed ACP echoes after MCP has already assigned its own id', () => {
    const tracker = new ConductorToolCorrelation()
    expect(tracker.claim('search', 'mcp-first')).toBe('mcp-first')
    tracker.observe(frame('late-echo', 'search'))
    expect(tracker.owns('late-echo')).toBe(true)
    tracker.observe(frame('new-call', 'search'))
    expect(tracker.claim('search', 'fallback')).toBe('new-call')
  })
  it('honors Claude metadata ids and leaves native file tools alone', () => {
    const tracker = new ConductorToolCorrelation()
    expect(tracker.claim('search', 'claude-id', true)).toBe('claude-id')
    expect(tracker.owns('claude-id')).toBe(true)
    expect(tracker.observe({ sessionId: 's', update: { sessionUpdate: 'tool_call', toolCallId: 'native', title: 'Read' } })).toBe(false)
    expect(tracker.owns('native')).toBe(false)
  })
})
