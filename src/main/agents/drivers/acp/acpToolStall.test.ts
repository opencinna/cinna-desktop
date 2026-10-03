import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SessionNotification } from '@agentclientprotocol/sdk'
import { ACP_TOOL_STALL_MESSAGE, ACP_TOOL_STALL_MS, createToolStallWatch, toolStallMessage, type StalledToolCall } from './acpToolStall'
import claudeMcpToolCall from './__fixtures__/claude/mcp_tool_call.json'

type Update = SessionNotification['update']

const call = (extra: Record<string, unknown> = {}): Update =>
  ({ sessionUpdate: 'tool_call', toolCallId: 'c1', title: 'write', kind: 'edit', status: 'pending', ...extra }) as Update
const update = (extra: Record<string, unknown>): Update =>
  ({ sessionUpdate: 'tool_call_update', toolCallId: 'c1', ...extra }) as Update

function watch(waiting = (): boolean => false): { fired: StalledToolCall[]; feed(u: Update): void; stop(): void } {
  const fired: StalledToolCall[] = []
  const w = createToolStallWatch({ ms: 1000, waiting, onStall: (c) => void fired.push(c) })
  return { fired, feed: (u) => { w.heard(); w.track(u) }, stop: w.stop }
}

describe('the tool stall watch', () => {
  beforeEach(() => { vi.useFakeTimers() })
  afterEach(() => { vi.useRealTimers() })

  it('fires once for an open call with no input, naming it', () => {
    const w = watch()
    w.feed(call())
    vi.advanceTimersByTime(999)
    expect(w.fired).toEqual([])
    vi.advanceTimersByTime(1)
    expect(w.fired).toEqual([{ toolCallId: 'c1', kind: 'edit' }])
    vi.advanceTimersByTime(5000)
    expect(w.fired).toHaveLength(1)
  })

  it('treats an absent, null or empty input alike', () => {
    for (const rawInput of [undefined, null, {}, '']) {
      const w = watch()
      w.feed(call({ rawInput }))
      vi.advanceTimersByTime(1000)
      expect(w.fired).toHaveLength(1)
    }
  })

  it('leaves a call with input, or one an update gave input, content or a status', () => {
    const cases: Update[][] = [
      [call({ rawInput: { filePath: 'a' } })],
      [call({ status: 'in_progress' })],
      [call(), update({ rawInput: { filePath: 'a' } })],
      [call(), update({ rawInput: {} })],
      [call(), update({ content: [{ type: 'content', content: { type: 'text', text: 'x' } }] })],
      [call(), update({ status: 'pending' })],
      [call(), update({ status: 'completed' })]
    ]
    for (const updates of cases) {
      const w = watch()
      for (const u of updates) w.feed(u)
      vi.advanceTimersByTime(10_000)
      expect(w.fired).toEqual([])
    }
  })

  it('does not count a title-only update as progress', () => {
    const w = watch()
    w.feed(call())
    vi.advanceTimersByTime(900)
    w.feed(update({ title: 'write notes.txt' }))
    vi.advanceTimersByTime(999)
    expect(w.fired).toEqual([])
    vi.advanceTimersByTime(1)
    expect(w.fired).toHaveLength(1)
  })

  it('waits while something else is waited for, and fires once it is not', () => {
    let waiting = true
    const w = watch(() => waiting)
    w.feed(call())
    vi.advanceTimersByTime(5000)
    expect(w.fired).toEqual([])
    waiting = false
    vi.advanceTimersByTime(1000)
    expect(w.fired).toHaveLength(1)
  })

  it('never fires after stop', () => {
    const w = watch()
    w.feed(call())
    w.stop()
    vi.advanceTimersByTime(10_000)
    expect(w.fired).toEqual([])
  })

  it('arms no timer at all for an engine without the watch', () => {
    const fired: StalledToolCall[] = []
    const w = createToolStallWatch({ ms: null, waiting: () => false, onStall: (c) => void fired.push(c) })
    w.heard()
    w.track(call())
    expect(vi.getTimerCount()).toBe(0)
    vi.advanceTimersByTime(ACP_TOOL_STALL_MS * 10)
    expect(fired).toEqual([])
  })

  it('does not fire on a recorded Claude MCP tool call with no arguments that runs a long time', () => {
    // `claude-agent-acp` opens the call with `rawInput: {}`, completes the input
    // with another `{}`, and never sends `in_progress`: the tool then runs with
    // nothing more said until its result.
    const notifications = claudeMcpToolCall.notifications as unknown as SessionNotification[]
    const w = watch()
    notifications.forEach((n, i) => {
      w.feed(n.update)
      vi.advanceTimersByTime(i === 0 ? 500 : 10_000)
    })
    expect(w.fired).toEqual([])
  })

  it('names the silence in its message', () => {
    expect(ACP_TOOL_STALL_MS).toBe(10 * 60 * 1000)
    expect(ACP_TOOL_STALL_MESSAGE).toBe(
      'The agent stopped responding while preparing a tool call (no progress for 10 minutes), so it was stopped.'
    )
    expect(toolStallMessage(60_000)).toContain('(no progress for 1 minute)')
  })
})
