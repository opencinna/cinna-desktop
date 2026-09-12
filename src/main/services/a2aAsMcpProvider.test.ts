import { expect, it, vi } from 'vitest'
import type { AgentRow } from '../db/agents'
import type { RunInput } from '../agents/drivers/driver'
import type { RunEvent } from '../../shared/runEvents'

const driverRun = vi.hoisted(() => vi.fn())
vi.mock('../agents/drivers', () => ({ driverFor: () => ({ run: driverRun }) }))
vi.mock('../db/chatOnDemandAgent', () => ({ chatOnDemandAgentRepo: {} }))
vi.mock('../db/taskInputRequests', () => ({ taskInputRequestRepo: { listOpenForChat: () => [] } }))
vi.mock('./agentService', () => ({ agentService: {} }))
vi.mock('../logger/logger', () => ({ createLogger: () => ({ warn: vi.fn() }) }))
const { A2AAsMcpProvider } = await import('./a2aAsMcpProvider')

it('owns static attribution and frames a driver turn once with its real agent and invocation', async () => {
  const row = { id: 'agent-alpha', name: 'Analyst' } as AgentRow
  const provider = new A2AAsMcpProvider('chat-1', row, 'owner-1', 'analyst')
  const events: RunEvent[] = []
  const signal = new AbortController().signal
  driverRun.mockImplementation(async (_owner, _agent, input: RunInput) => {
    expect(input.signal).toBe(signal)
    input.onEvent?.({ type: 'delta', kind: 'text', text: 'Evidence' })
    input.onEvent?.({ type: 'done' })
    return { text: 'Completed', parts: [] }
  })
  expect(provider.attribution).toEqual({ agentId: 'agent-alpha', displayName: 'Analyst' })
  expect(await provider.callTool('analyst', { message: 'Check' }, {
    toolCallId: 'invocation-1', signal, onEvent: provider.eventSink('invocation-1', (event) => events.push(event))
  })).toEqual({ content: 'Completed', parts: [] })
  expect(events).toEqual([
    { type: 'child', agentId: 'agent-alpha', toolCallId: 'invocation-1', event: { type: 'delta', kind: 'text', text: 'Evidence' } },
    { type: 'child', agentId: 'agent-alpha', toolCallId: 'invocation-1', event: { type: 'done' } }
  ])
  expect(driverRun).toHaveBeenCalledWith('owner-1', row, expect.objectContaining({ chatId: 'chat-1', wireContent: 'Check' }))
})
