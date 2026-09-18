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
    const two = runNestedAgentTurn(turnDriver, 'owner', agent, { ...input(parent), nested: { toolCallId: 'second' } })
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
