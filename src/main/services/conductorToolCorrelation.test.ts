import { describe, expect, it, vi } from 'vitest'
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
  it('holds a call that outran its ACP tool_call until the notice arrives', async () => {
    const tracker = new ConductorToolCorrelation()
    const id = tracker.claim('search', 'mcp-first')
    let released = false
    const waiting = tracker.sighted(id, 60_000).then(() => { released = true })
    await Promise.resolve()
    expect(released).toBe(false)
    tracker.observe(frame('late-echo', 'search'))
    await waiting
    expect(released).toBe(true)
  })
  it('does not hold a call whose ACP tool_call came first, and holds a Claude id until its own notice', async () => {
    const tracker = new ConductorToolCorrelation()
    tracker.observe(frame('seen', 'search'))
    await tracker.sighted(tracker.claim('search', 'fallback'), 60_000)
    let released = false
    const waiting = tracker.sighted(tracker.claim('read', 'claude-id', true), 60_000).then(() => { released = true })
    tracker.observe(frame('other', 'read'))
    await Promise.resolve()
    expect(released).toBe(false)
    tracker.observe(frame('claude-id', 'read'))
    await waiting
    expect(released).toBe(true)
  })
  it('gives up waiting at the cap and on abort, so an engine without notices is only delayed', async () => {
    vi.useFakeTimers()
    try {
      const tracker = new ConductorToolCorrelation()
      const capped = tracker.sighted(tracker.claim('search', 'never'), 1_000)
      await vi.advanceTimersByTimeAsync(1_000)
      await capped
      await tracker.sighted('never', 1_000)
      const controller = new AbortController()
      const aborted = tracker.sighted(tracker.claim('search', 'stopped'), 1_000, controller.signal)
      controller.abort()
      await aborted
    } finally { vi.useRealTimers() }
  })
  it('forgets a call whose notice never came, so the next call of that name is released by its own notice', async () => {
    vi.useFakeTimers()
    try {
      const tracker = new ConductorToolCorrelation()
      const lost = tracker.sighted(tracker.claim('search', 'lost'), 1_000)
      await vi.advanceTimersByTimeAsync(1_000)
      await lost
      let released = false
      const next = tracker.sighted(tracker.claim('search', 'next'), 1_000).then(() => { released = true })
      tracker.observe(frame('acp-next', 'search'))
      await vi.advanceTimersByTimeAsync(0)
      expect(released).toBe(true)
      await next
    } finally { vi.useRealTimers() }
  })
})
