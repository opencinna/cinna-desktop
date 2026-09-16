/**
 * The follow-up gate on its own: which between-turn traffic starts a turn,
 * what is held until that turn is bound, and where held traffic goes when the
 * turn is not opened or another turn takes it. The turn itself is
 * `acpDriver.test.ts`'s; opening it is `followUpTurnService.test.ts`'s.
 */
import { beforeEach, describe, expect, it } from 'vitest'
import type { SessionNotification } from '@agentclientprotocol/sdk'
import { clearLogEntries, getLogEntries } from '../../../logger/logger'
import followUpFixture from './__fixtures__/claude/followup_turn.json'
import { createFollowUpGate, deliverHeld, type FollowUpGate, type HeldTraffic } from './acpFollowUp'
import type { SessionTrafficScope, SessionTrafficSink } from './acpSessionObserver'
import type { AcpSessionHandlers } from './types'

const SCOPE: SessionTrafficScope = { agentId: 'folder:a', chatId: 'chat-1', sessionId: 'ses_1', launcherId: 'claude' }

const note = (update: Record<string, unknown>): SessionNotification =>
  ({ sessionId: 'ses_1', update }) as unknown as SessionNotification

const chunk = (text: string, messageId?: string): SessionNotification =>
  note({ sessionUpdate: 'agent_message_chunk', ...(messageId ? { messageId } : {}), content: { type: 'text', text } })

const PERMISSION = {
  sessionId: 'ses_1',
  toolCall: { toolCallId: 'call_1', title: 'gh pr merge' },
  options: [{ optionId: 'once', kind: 'allow_once', name: 'Allow once' }]
} as never

/** The recorded unprompted turn (`phase0_findings.md`, Q1). */
const FIXTURE: SessionNotification[] = (followUpFixture.notifications as { update: Record<string, unknown> }[])
  .map((frame) => note(frame.update))

interface Harness {
  gate: FollowUpGate
  opened: number
  activity: string[]
  known: Set<string>
  /** Process holds taken, and releases called (each counted, even a repeat). */
  holds: number
  releases: number
}

function harness(options: { known?: string[]; limit?: number; openThrows?: boolean } = {}): Harness {
  const h: Harness = {
    gate: undefined as unknown as FollowUpGate, opened: 0, activity: [], known: new Set(options.known ?? []), holds: 0, releases: 0
  }
  const activity: SessionTrafficSink = {
    update: (n) => { h.activity.push((n.update as { sessionUpdate: string }).sessionUpdate) },
    permission: async () => ({ outcome: { outcome: 'cancelled' } }),
    elicitation: async () => ({ action: 'cancel' })
  }
  h.gate = createFollowUpGate(SCOPE, {
    activity,
    knownToolCalls: h.known,
    open: () => {
      h.opened++
      if (options.openThrows) throw new Error('no service')
    },
    hold: () => {
      h.holds++
      return () => { h.releases++ }
    },
    ...(options.limit !== undefined ? { limit: options.limit } : {})
  })
  return h
}

/** Handlers that record what a turn was handed. */
function recorder(): { handlers: AcpSessionHandlers; seen: string[] } {
  const seen: string[] = []
  return {
    seen,
    handlers: {
      onUpdate: (n) => {
        const update = n.update as { sessionUpdate: string; content?: { text?: string } }
        seen.push(update.content?.text ? `${update.sessionUpdate}:${update.content.text}` : update.sessionUpdate)
      },
      onPermission: async () => {
        seen.push('permission')
        return { outcome: { outcome: 'selected', optionId: 'once' } }
      },
      onElicitation: async () => {
        seen.push('elicitation')
        return { action: 'accept', content: {} }
      }
    }
  }
}

function deliverAll(items: HeldTraffic[], handlers: AcpSessionHandlers): void {
  for (const item of items) deliverHeld(item, handlers)
}

beforeEach(() => clearLogEntries())

describe('the follow-up gate', () => {
  it('opens one follow-up for the recorded unprompted turn and holds all of it, in order', () => {
    const h = harness({ known: ['toolu_01Hru8BGVA8YhLTCnqJMopoR'] })
    for (const n of FIXTURE) h.gate.sink.update(n)

    // The task state updates and the first cost-less usage come before the
    // trigger: activity, not turn content.
    expect(h.activity).toEqual(['async_task_state_update', 'async_task_state_update', 'usage_update'])
    expect(h.opened).toBe(1)
    expect(h.gate.pending).toBe(true)

    const { handlers, seen } = recorder()
    deliverAll(h.gate.take(), handlers)
    expect(seen[0]).toBe('tool_call')
    expect(seen.filter((s) => s.startsWith('agent_message_chunk')).join('|'))
      .toBe('agent_message_chunk:Output|agent_message_chunk:: `|agent_message_chunk:probe-done`')
    expect(seen.at(-1)).toBe('usage_update')
    expect(h.gate.pending).toBe(false)
  })

  it.each([
    ['a tool call with a new id', note({ sessionUpdate: 'tool_call', toolCallId: 'new', title: 'Read' })],
    ['a message chunk with a message id', chunk('Merged.', 'msg_1')],
    ['a thought chunk with a message id', note({ sessionUpdate: 'agent_thought_chunk', messageId: 'm', content: { type: 'text', text: 'hm' } })],
    ['a plan', note({ sessionUpdate: 'plan', entries: [] })]
  ])('opens a follow-up on %s', (_name, n) => {
    const h = harness()
    h.gate.sink.update(n)
    expect(h.opened).toBe(1)
    expect(h.activity).toEqual([])
  })

  it('opens a follow-up on a permission ask, and the ask waits for the turn', async () => {
    const h = harness()
    let answered: unknown = null
    void h.gate.sink.permission(PERMISSION).then((a) => { answered = a })
    expect(h.opened).toBe(1)
    await Promise.resolve()
    expect(answered).toBeNull()

    const { handlers, seen } = recorder()
    deliverAll(h.gate.take(), handlers)
    await new Promise((r) => setTimeout(r, 0))
    expect(seen).toEqual(['permission'])
    expect(answered).toEqual({ outcome: { outcome: 'selected', optionId: 'once' } })
  })

  it('opens a follow-up on a question', () => {
    const h = harness()
    void h.gate.sink.elicitation({ sessionId: 'ses_1' } as never)
    expect(h.opened).toBe(1)
  })

  it.each([
    ['a late update for a saved turn’s tool call', note({ sessionUpdate: 'tool_call_update', toolCallId: 'saved', status: 'completed' })],
    ['a repeated tool call of a saved turn', note({ sessionUpdate: 'tool_call', toolCallId: 'saved', title: 'Bash' })],
    ['a text chunk with no message id (Claude’s synthetic stop notice)', chunk('**Task stopped by user:** sleep 120.')]
  ])('drops %s and opens nothing', (_name, n) => {
    const h = harness({ known: ['saved'] })
    h.gate.sink.update(n)
    expect(h.opened).toBe(0)
    expect(h.activity).toEqual([])
    expect(h.gate.take()).toEqual([])
  })

  it.each(['usage_update', 'session_info_update', 'available_commands_update', 'config_option_update', 'current_mode_update',
    'async_task_spawned', 'subagent_spawned'])('hands %s to the activity hook and opens nothing', (kind) => {
    const h = harness()
    h.gate.sink.update(note({ sessionUpdate: kind }))
    expect(h.opened).toBe(0)
    expect(h.activity).toEqual([kind])
  })

  it('opens once per episode, however much turn content follows the trigger', () => {
    const h = harness()
    h.gate.sink.update(chunk('a', 'm'))
    h.gate.sink.update(chunk('b', 'm'))
    h.gate.sink.update(note({ sessionUpdate: 'usage_update' }))
    expect(h.opened).toBe(1)
    // Held, not handed to the activity hook: it is the turn's.
    expect(h.activity).toEqual([])
    expect(h.gate.take()).toHaveLength(3)
  })

  it('counts and logs updates past the limit, and keeps every ask', async () => {
    const h = harness({ limit: 2 })
    h.gate.sink.update(chunk('1', 'm'))
    h.gate.sink.update(chunk('2', 'm'))
    h.gate.sink.update(chunk('3', 'm'))
    h.gate.sink.update(chunk('4', 'm'))
    void h.gate.sink.permission(PERMISSION)

    const items = h.gate.take()
    expect(items.map((i) => i.type)).toEqual(['update', 'update', 'permission'])
    const overflow = getLogEntries().filter((e) => e.scope === 'acp-follow-up' && e.message.includes('overflowed'))
    expect(overflow).toHaveLength(1)
    expect(overflow[0].data).toMatchObject({ kept: 2, dropped: 2, chatId: 'chat-1', sessionId: 'ses_1' })
  })

  it('refuses the held asks and drops the rest when the follow-up is abandoned, then goes idle', async () => {
    const h = harness()
    const answer = h.gate.sink.permission(PERMISSION)
    const question = h.gate.sink.elicitation({ sessionId: 'ses_1' } as never)
    h.gate.sink.update(chunk('x', 'm'))

    h.gate.abandon('the chat is in the trash')
    await expect(answer).resolves.toEqual({ outcome: { outcome: 'cancelled' } })
    await expect(question).resolves.toEqual({ action: 'cancel' })
    expect(h.gate.pending).toBe(false)
    expect(h.gate.take()).toEqual([])
  })

  it('opens the next follow-up from what the finished one left and what arrived meanwhile', () => {
    const h = harness()
    h.gate.sink.update(chunk('first', 'm1'))
    const taken = h.gate.take()
    expect(taken).toHaveLength(1)
    // Arrived while the first ran but after its binding went away.
    h.gate.sink.update(chunk('second', 'm2'))
    expect(h.opened).toBe(1)

    h.gate.release([])
    expect(h.opened).toBe(2)
    expect(h.gate.pending).toBe(true)
    const { handlers, seen } = recorder()
    deliverAll(h.gate.take(), handlers)
    expect(seen).toEqual(['agent_message_chunk:second'])
  })

  it('stays idle after a follow-up when nothing more came', () => {
    const h = harness()
    h.gate.sink.update(chunk('first', 'm1'))
    h.gate.take()
    h.gate.release([])
    expect(h.gate.pending).toBe(false)
    expect(h.opened).toBe(1)
  })

  it('hands what it holds to a turn of the same session, and opens nothing for it', async () => {
    const h = harness()
    h.gate.sink.update(chunk('Merged.', 'm'))
    const answer = h.gate.sink.permission(PERMISSION)
    const handover = h.gate.handOver()
    expect(h.gate.pending).toBe(false)

    const { handlers, seen } = recorder()
    handover.replay(handlers)
    await expect(answer).resolves.toEqual({ outcome: { outcome: 'selected', optionId: 'once' } })
    expect(seen).toEqual(['agent_message_chunk:Merged.', 'permission'])
    // Closed now: the session is the taking turn's.
    await expect(h.gate.sink.permission(PERMISSION)).resolves.toEqual({ outcome: { outcome: 'cancelled' } })
  })

  it('refuses held asks when the taking turn found the session gone', async () => {
    const h = harness()
    const answer = h.gate.sink.permission(PERMISSION)
    h.gate.handOver().refuse()
    await expect(answer).resolves.toEqual({ outcome: { outcome: 'cancelled' } })
  })

  it('tells a running follow-up when it closes, and refuses what it held', async () => {
    const h = harness()
    h.gate.sink.update(chunk('first', 'm'))
    h.gate.take()
    let closed = 0
    h.gate.onClose(() => { closed++ })
    const late = h.gate.sink.permission(PERMISSION)

    h.gate.close()
    expect(closed).toBe(1)
    await expect(late).resolves.toEqual({ outcome: { outcome: 'cancelled' } })
    h.gate.release([])
    expect(h.opened).toBe(1)
  })

  it('gives held updates back to the session once the taking turn ended without them, and refuses the asks', async () => {
    const h = harness()
    h.gate.sink.update(chunk('Merged.', 'm'))
    const answer = h.gate.sink.permission(PERMISSION)
    h.gate.sink.update(note({ sessionUpdate: 'plan', entries: [] }))
    const handover = h.gate.handOver()

    const next = harness()
    handover.giveBack(next.gate.sink)
    await expect(answer).resolves.toEqual({ outcome: { outcome: 'cancelled' } })
    // The new gate opened a follow-up for them, and holds them in order.
    expect(next.opened).toBe(1)
    const { handlers, seen } = recorder()
    deliverAll(next.gate.take(), handlers)
    expect(seen).toEqual(['agent_message_chunk:Merged.', 'plan'])
  })

  it('drops what it holds with a warning, and opens again later, when abandoned as a drop', () => {
    const h = harness()
    h.gate.sink.update(chunk('one', 'm1'))
    void h.gate.sink.permission(PERMISSION)
    h.gate.abandon('the chat stayed busy', 'warn')

    const warned = getLogEntries().filter((e) => e.scope === 'acp-follow-up' && e.level === 'warn' && e.message.includes('dropped'))
    expect(warned).toHaveLength(1)
    expect(warned[0].data).toMatchObject({ reason: 'the chat stayed busy', updates: 1, asks: 1, chatId: 'chat-1' })
    expect(h.gate.pending).toBe(false)
    h.gate.sink.update(chunk('two', 'm2'))
    expect(h.opened).toBe(2)
    expect(h.gate.pending).toBe(true)
  })
})

describe('the follow-up gate’s process hold', () => {
  it('is taken at the trigger, once per episode, and released when the follow-up takes over', () => {
    const h = harness()
    h.gate.sink.update(chunk('a', 'm'))
    h.gate.sink.update(chunk('b', 'm'))
    void h.gate.sink.permission(PERMISSION)
    expect([h.holds, h.releases]).toEqual([1, 0])

    h.gate.take()
    expect([h.holds, h.releases]).toEqual([1, 1])
    // Held for the running follow-up by the turn itself; nothing more here.
    h.gate.sink.update(chunk('c', 'm2'))
    expect([h.holds, h.releases]).toEqual([1, 1])
    // The next episode takes its own.
    h.gate.release([])
    expect([h.holds, h.releases]).toEqual([2, 1])
    h.gate.abandon('the chat is gone')
    expect([h.holds, h.releases]).toEqual([2, 2])
  })

  it('is not taken for traffic that opens nothing', () => {
    const h = harness()
    h.gate.sink.update(note({ sessionUpdate: 'usage_update', used: 1, size: 2 }))
    h.gate.sink.update(chunk('**Task stopped by user:** x'))
    expect(h.holds).toBe(0)
  })

  it.each([
    ['handed to a user turn', (g: FollowUpGate) => { g.handOver() }],
    ['abandoned', (g: FollowUpGate) => g.abandon('the chat is in the trash')],
    ['abandoned as a drop', (g: FollowUpGate) => g.abandon('the chat stayed busy', 'warn')],
    ['closed', (g: FollowUpGate) => g.close()]
  ])('is released exactly once when the pending follow-up is %s', (_label, exit) => {
    const h = harness()
    h.gate.sink.update(chunk('a', 'm'))
    exit(h.gate)
    exit(h.gate)
    h.gate.close()
    h.gate.take()
    expect([h.holds, h.releases]).toEqual([1, 1])
  })

  it('is released when the follow-up could not be asked for', () => {
    const h = harness({ openThrows: true })
    h.gate.sink.update(chunk('a', 'm'))
    expect([h.holds, h.releases]).toEqual([1, 1])
    expect(h.gate.pending).toBe(false)
  })
})
