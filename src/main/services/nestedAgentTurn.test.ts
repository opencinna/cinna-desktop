import { describe, expect, it } from 'vitest'
import type { AgentDriver, RunInput, RunResult } from '../agents/drivers/driver'
import type { AgentRow } from '../db/agents'
import type { RunEvent } from '../../shared/runEvents'
import { nestedAgentTurns, runNestedAgentTurn, SPECIALIST_WAITING } from './nestedAgentTurn'

const agent = { id: 'specialist' } as AgentRow
const result: RunResult = { text: 'done', parts: [], notices: [] }
const question: Extract<RunEvent, { type: 'needs_input' }> = { type: 'needs_input', requestId: 'question-1', resume: 'reply', request: { kind: 'question', questions: [{ question: 'Which branch?', header: 'Branch', options: [], multiSelect: false }] } }
const input = (controller = new AbortController()): RunInput & { nested: { toolCallId: string } } => ({ chatId: 'chat', wireContent: 'check', signal: controller.signal, nested: { toolCallId: 'call' } })
const driver = (run: AgentDriver['run']): AgentDriver => ({ run } as AgentDriver)

describe('nested agent turn', () => {
  it('runs one agent\'s delegations in one chat one at a time, and other chats beside them', async () => {
    let active = 0, peak = 0
    const gates: Array<() => void> = []
    const run: AgentDriver['run'] = async () => {
      active++; peak = Math.max(peak, active)
      await new Promise<void>((resolve) => gates.push(resolve))
      active--
      return result
    }
    const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))
    const first = runNestedAgentTurn(driver(run), 'owner', agent, input())
    const second = runNestedAgentTurn(driver(run), 'owner', agent, { ...input(), nested: { toolCallId: 'call-2' } })
    await tick()
    expect(active).toBe(1)
    const elsewhere = runNestedAgentTurn(driver(run), 'owner', agent, { ...input(), chatId: 'other' })
    await tick()
    expect(active).toBe(2)
    gates.shift()!(); gates.shift()!()
    await tick()
    expect(active).toBe(1)
    gates.shift()!()
    await Promise.all([first, second, elsewhere])
    expect(peak).toBe(2)
  })

  it('a delegation stopped while waiting leaves the queue in order', async () => {
    const gates: Array<() => void> = []
    let started = 0
    const run: AgentDriver['run'] = async () => { started++; await new Promise<void>((resolve) => gates.push(resolve)); return result }
    const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))
    const first = runNestedAgentTurn(driver(run), 'owner', agent, input())
    const stopped = new AbortController()
    const second = runNestedAgentTurn(driver(run), 'owner', agent, { ...input(stopped), nested: { toolCallId: 'call-2' } })
    const third = runNestedAgentTurn(driver(run), 'owner', agent, { ...input(), nested: { toolCallId: 'call-3' } })
    await tick()
    stopped.abort()
    expect(await second).toMatchObject({ stopReason: 'canceled', taskState: 'canceled' })
    expect(started).toBe(1)
    gates.shift()!()
    await first
    await tick()
    expect(started).toBe(2)
    gates.shift()!()
    await third
  })

  it('a Stop reaches a delegation still waiting its place', async () => {
    const gates: Array<() => void> = []
    let started = 0
    const run: AgentDriver['run'] = async () => { started++; await new Promise<void>((resolve) => gates.push(resolve)); return result }
    const first = runNestedAgentTurn(driver(run), 'owner', agent, input())
    const queued = runNestedAgentTurn(driver(run), 'owner', agent, { ...input(), nested: { toolCallId: 'call-2' } })
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(nestedAgentTurns.chatFor('nested:["chat","call-2"]')).toBe('chat')
    nestedAgentTurns.cancel('nested:["chat","call-2"]')
    expect(await queued).toMatchObject({ stopReason: 'canceled' })
    expect(nestedAgentTurns.chatFor('nested:["chat","call-2"]')).toBeUndefined()
    gates.shift()!()
    await first
    expect(started).toBe(1)
  })

  it('publishes a durable question before aborting the live park and suppresses its cancellation', async () => {
    const events: RunEvent[] = []
    const parent = new AbortController()
    const output = await runNestedAgentTurn(driver(async (_owner, _agent, turn) => {
      turn.signal.addEventListener('abort', () => expect(events[0]).toEqual({ ...question, resume: 'next_message' }))
      turn.onEvent?.(question)
      expect(turn.signal.aborted).toBe(true)
      turn.onEvent?.({ type: 'input_resolved', requestId: 'question-1', resolution: { kind: 'rejected' } })
      turn.onEvent?.({ type: 'done', stopReason: 'canceled' })
      return { ...result, stopReason: 'canceled', taskState: 'canceled', error: { message: 'aborted', raw: '' } }
    }), 'owner', agent, { ...input(parent), onEvent: (event) => events.push(event) })
    expect(events).toEqual([{ ...question, resume: 'next_message' }, { type: 'delta', kind: 'tool_result', toolId: 'question-1', text: 'Waiting for your answer in the Inbox.' }])
    expect(output).toMatchObject({ text: SPECIALIST_WAITING, stopReason: 'end_turn', taskState: 'input-required', needsInput: true, error: undefined })
    expect(parent.signal.aborted).toBe(false)
  })

  it('leaves a remote next-message task waiting without sending cancellation', async () => {
    await runNestedAgentTurn(driver(async (_owner, _agent, turn) => {
      turn.onEvent?.({ ...question, resume: 'next_message' })
      expect(turn.signal.aborted).toBe(false)
      return result
    }), 'owner', agent, input())
  })

  it('keeps permission requests live and answerable by their original id', async () => {
    const events: RunEvent[] = []
    const permission: RunEvent = { type: 'needs_input', requestId: 'permission-1', resume: 'reply', request: { kind: 'permission', action: 'bash', resources: ['pwd'] } }
    const resolved: RunEvent = { type: 'input_resolved', requestId: 'permission-1', resolution: { kind: 'permission', reply: 'once' } }
    await runNestedAgentTurn(driver(async (_owner, _agent, turn) => {
      turn.onEvent?.(permission)
      expect(turn.signal.aborted).toBe(false)
      turn.onEvent?.(resolved)
      return result
    }), 'owner', agent, { ...input(), onEvent: (event) => events.push(event) })
    expect(events).toEqual([permission, resolved])
  })

  it('stops one parallel specialist without stopping the conductor or its sibling', async () => {
    const parent = new AbortController()
    const signals: AbortSignal[] = []
    const turnDriver = driver(async (_owner, _agent, turn) => {
      signals.push(turn.signal)
      await new Promise<void>((resolve) => turn.signal.addEventListener('abort', () => resolve(), { once: true }))
      return { ...result, stopReason: 'canceled' }
    })
    const one = runNestedAgentTurn(turnDriver, 'owner', agent, input(parent))
    // A different specialist: one agent's delegations in one chat take turns.
    const two = runNestedAgentTurn(turnDriver, 'owner', { id: 'sibling' } as AgentRow, { ...input(parent), nested: { toolCallId: 'second' } })
    await new Promise((resolve) => setTimeout(resolve, 0))
    nestedAgentTurns.cancel('nested:["chat","call"]')
    expect(signals.map((signal) => signal.aborted)).toEqual([true, false])
    expect(parent.signal.aborted).toBe(false)
    expect((await one).stopReason).toBe('canceled')
    parent.abort()
    expect((await two).stopReason).toBe('canceled')
    expect(nestedAgentTurns.chatFor('nested:["chat","call"]')).toBeUndefined()
  })

  it('keeps parent cancellation distinct from a durable pause', async () => {
    const parent = new AbortController()
    const output = await runNestedAgentTurn(driver(async (_owner, _agent, turn) => {
      turn.onEvent?.(question)
      parent.abort()
      return { ...result, stopReason: 'canceled' }
    }), 'owner', agent, input(parent))
    expect(output.stopReason).toBe('canceled')
    expect(output).not.toHaveProperty('needsInput')
  })
})
