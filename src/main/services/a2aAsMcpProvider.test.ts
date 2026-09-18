import { expect, it, vi } from 'vitest'
import type { AgentRow } from '../db/agents'
import type { RunInput } from '../agents/drivers/driver'
import type { RunEvent } from '../../shared/runEvents'

const driverRun = vi.hoisted(() => vi.fn())
const attached = vi.hoisted(() => vi.fn(() => ['agent-alpha', 'conductor']))
const findAgent = vi.hoisted(() => vi.fn((_default: string, _profile: string, id: string) => ({ row: { id, name: id, source: 'local', engine: 'claude', folderPath: '/tmp/agent' }, userId: 'owner' })))
vi.mock('../agents/drivers', () => ({ driverFor: () => ({ run: driverRun }) }))
vi.mock('../agents/drivers/capabilities', () => ({ hasRunConfig: () => true }))
vi.mock('../db/chatOnDemandAgent', () => ({ chatOnDemandAgentRepo: { listAgentIds: attached } }))
vi.mock('../db/taskInputRequests', () => ({ taskInputRequestRepo: { listOpenForChat: () => [] } }))
vi.mock('./agentService', () => ({ agentService: { findAgent } }))
vi.mock('../logger/logger', () => ({ createLogger: () => ({ warn: vi.fn() }) }))
const { A2AAsMcpProvider, buildAgentToolProviders } = await import('./a2aAsMcpProvider')

it('owns static attribution and frames a driver turn once with its real agent and invocation', async () => {
  const row = { id: 'agent-alpha', name: 'Analyst' } as AgentRow
  const provider = new A2AAsMcpProvider('chat-1', row, 'owner-1', 'analyst')
  const events: RunEvent[] = []
  const signal = new AbortController().signal
  driverRun.mockImplementation(async (_owner, _agent, input: RunInput) => {
    expect(input.signal.aborted).toBe(false)
    expect(input.nested).toEqual({ toolCallId: 'invocation-1' })
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

it('never offers the conductor as its own specialist tool', () => {
  expect(buildAgentToolProviders('chat', 'default', 'profile', new Set(), 'conductor').map((provider) => provider.agentId)).toEqual(['agent-alpha'])
})
