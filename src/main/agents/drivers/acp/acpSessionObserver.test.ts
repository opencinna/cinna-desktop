/**
 * The between-turn observer on its own: what it logs (kinds and counts, never
 * content), how often, and that a failing sink never leaves an agent blocked.
 * The routing that reaches it is `acpConnection.test.ts`'s; the lifecycle is
 * `acpDriver.test.ts`'s.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SessionNotification } from '@agentclientprotocol/sdk'
import { clearLogEntries, getLogEntries } from '../../../logger/logger'
import {
  SESSION_TRAFFIC_BURST_MS,
  createSessionObservation,
  refusingSessionTrafficSink,
  type SessionTrafficScope,
  type SessionTrafficSink
} from './acpSessionObserver'

const SCOPE: SessionTrafficScope = { agentId: 'folder:a', chatId: 'chat-1', sessionId: 'ses_1', launcherId: 'claude' }

function note(update: Record<string, unknown>): SessionNotification {
  return { sessionId: 'ses_1', update } as unknown as SessionNotification
}

const text = (t: string): SessionNotification =>
  note({ sessionUpdate: 'agent_message_chunk', messageId: 'm', content: { type: 'text', text: t } })

const PERMISSION = {
  sessionId: 'ses_1',
  toolCall: { toolCallId: 'call_1', title: 'gh pr merge' },
  options: [{ optionId: 'once', kind: 'allow_once', name: 'Allow once' }]
} as never

function burstLogs(): { message: string; data: unknown }[] {
  return getLogEntries()
    .filter((e) => e.scope === 'acp-session-observer' && e.message === 'traffic for a session between turns')
    .map((e) => ({ message: e.message, data: e.data }))
}

beforeEach(() => {
  clearLogEntries()
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('createSessionObservation', () => {
  it('logs one line per burst, with kinds and counts and no content', () => {
    const sink = { update: vi.fn(), permission: vi.fn(), elicitation: vi.fn() }
    const { observer } = createSessionObservation(SCOPE, sink)

    observer.onUpdate(text('SECRET TEXT'))
    observer.onUpdate(text('more'))
    observer.onUpdate(note({ sessionUpdate: 'tool_call', toolCallId: 't1', title: 'cat ~/.ssh/id_rsa' }))
    observer.onUpdate(note({ sessionUpdate: 'usage_update', used: 1, size: 2 }))
    observer.onExtNotification?.('_session/goal', { sessionId: 'ses_1', goal: 'hidden' })

    expect(burstLogs()).toHaveLength(0)
    vi.advanceTimersByTime(SESSION_TRAFFIC_BURST_MS)

    const logs = burstLogs()
    expect(logs).toHaveLength(1)
    expect(logs[0].data).toEqual({
      agentId: 'folder:a',
      chatId: 'chat-1',
      sessionId: 'ses_1',
      kinds: { agent_message_chunk: 2, tool_call: 1, usage_update: 1, '_session/goal': 1 },
      turnShaped: 3
    })
    const serialized = JSON.stringify(getLogEntries())
    expect(serialized).not.toContain('SECRET TEXT')
    expect(serialized).not.toContain('id_rsa')
    expect(serialized).not.toContain('hidden')
    // Every update still reaches the sink.
    expect(sink.update).toHaveBeenCalledTimes(4)

    observer.onUpdate(text('next burst'))
    vi.advanceTimersByTime(SESSION_TRAFFIC_BURST_MS)
    expect(burstLogs()).toHaveLength(2)
  })

  it('logs what it has collected when it is closed, and nothing after', () => {
    const { observer, close } = createSessionObservation(SCOPE, refusingSessionTrafficSink(SCOPE))
    observer.onUpdate(text('x'))
    close()
    expect(burstLogs()).toHaveLength(1)

    observer.onUpdate(text('y'))
    vi.advanceTimersByTime(SESSION_TRAFFIC_BURST_MS)
    close()
    expect(burstLogs()).toHaveLength(1)
  })

  it('hands nothing to the sink once closed, and refuses asks itself', async () => {
    const sink = { update: vi.fn(), permission: vi.fn(), elicitation: vi.fn() }
    const { observer, close } = createSessionObservation(SCOPE, sink)
    close()

    observer.onUpdate(text('late'))
    await expect(observer.onPermission(PERMISSION)).resolves.toEqual({ outcome: { outcome: 'cancelled' } })
    await expect(observer.onElicitation?.({ sessionId: 'ses_1' } as never)).resolves.toEqual({ action: 'cancel' })
    expect(sink.update).not.toHaveBeenCalled()
    expect(sink.permission).not.toHaveBeenCalled()
    expect(sink.elicitation).not.toHaveBeenCalled()
  })

  it('does not throw when the sink throws on an update', () => {
    const sink: SessionTrafficSink = {
      update: () => { throw new Error('boom') },
      permission: async () => ({ outcome: { outcome: 'cancelled' } }),
      elicitation: async () => ({ action: 'cancel' })
    }
    const { observer } = createSessionObservation(SCOPE, sink)
    expect(() => observer.onUpdate(text('x'))).not.toThrow()
  })

  it('hands asks to the sink and returns its answer', async () => {
    const sink: SessionTrafficSink = {
      update: () => {},
      permission: async () => ({ outcome: { outcome: 'selected', optionId: 'once' } }),
      elicitation: async () => ({ action: 'decline' })
    }
    const { observer } = createSessionObservation(SCOPE, sink)
    await expect(observer.onPermission(PERMISSION)).resolves.toEqual({ outcome: { outcome: 'selected', optionId: 'once' } })
    await expect(observer.onElicitation?.({ sessionId: 'ses_1' } as never)).resolves.toEqual({ action: 'decline' })
  })

  it('refuses an ask whose sink fails, rather than leaving the agent blocked', async () => {
    const sink: SessionTrafficSink = {
      update: () => {},
      permission: () => { throw new Error('sync boom') },
      elicitation: async () => { throw new Error('async boom') }
    }
    const { observer } = createSessionObservation(SCOPE, sink)
    await expect(observer.onPermission(PERMISSION)).resolves.toEqual({ outcome: { outcome: 'cancelled' } })
    await expect(observer.onElicitation?.({ sessionId: 'ses_1' } as never)).resolves.toEqual({ action: 'cancel' })
  })
})

describe('refusingSessionTrafficSink', () => {
  it('refuses at once, and says so in a warning', async () => {
    const sink = refusingSessionTrafficSink(SCOPE)
    await expect(sink.permission(PERMISSION)).resolves.toEqual({ outcome: { outcome: 'cancelled' } })
    await expect(sink.elicitation({ sessionId: 'ses_1' } as never)).resolves.toEqual({ action: 'cancel' })
    const warnings = getLogEntries().filter((e) => e.scope === 'acp-session-observer' && e.level === 'warn')
    expect(warnings.map((e) => e.message)).toEqual([
      'permission asked between turns; refused',
      'question asked between turns; refused'
    ])
  })
})
