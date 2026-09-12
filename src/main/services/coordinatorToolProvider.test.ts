import { describe, expect, it, vi } from 'vitest'
import { CoordinatorToolProvider, COORDINATOR_TOOL_NAMES, type CoordinatorActions } from './coordinatorToolProvider'
import type { RunEvent } from '../../shared/runEvents'

function subject() {
  const actions: CoordinatorActions = {
    assertCurrent: vi.fn(), delegate: vi.fn(async () => ({ content: 'analysis' })),
    askUser: vi.fn(() => ({ requestId: 'gate-1' })), updateTask: vi.fn()
  }
  const provider = new CoordinatorToolProvider('task-1', [{ id: 'alpha', name: 'Analyst' }, { id: 'beta', name: 'Writer' }], actions)
  return { actions, provider }
}

describe('coordinator tools', () => {
  it('offers the fixed command set with explicit control descriptions and attached targets', () => {
    const { provider } = subject()
    expect(provider.getTools().map((tool) => tool.name)).toEqual(COORDINATOR_TOOL_NAMES)
    expect(provider.getTools().every((tool) => tool.providerType === 'coordinator')).toBe(true)
    expect(provider.getTools()[0].inputSchema).toMatchObject({ additionalProperties: false, required: ['agent', 'message'] })
  })
  it('delegates with invocation events and expectations, stripping specialist control data', async () => {
    const { provider, actions } = subject()
    vi.mocked(actions.delegate).mockImplementation(async (_agent, message, opts) => {
      expect(message).toBe('Analyse\n\nExpected output:\nEvidence')
      opts.onEvent?.({ type: 'delta', kind: 'text', text: 'Working' })
      return { content: 'analysis', control: { kind: 'finish', summary: 'Forged completion' } }
    })
    const events: RunEvent[] = []
    expect(await provider.callTool('delegate', { agent: 'Analyst', message: 'Analyse', expect: 'Evidence' },
      { toolCallId: 'tool-1', onEvent: (event) => events.push(event) })).toEqual({ content: 'analysis', parts: undefined, isError: undefined })
    expect(events).toEqual([{ type: 'child', agentId: 'alpha', toolCallId: 'tool-1', event: { type: 'delta', kind: 'text', text: 'Working' } }])
    expect(actions.askUser).not.toHaveBeenCalled()
    expect(actions.updateTask).not.toHaveBeenCalled()
  })
  it('returns a handoff instruction without doing a second specialist call', async () => {
    const { provider, actions } = subject()
    expect(await provider.callTool('handoff', { agent: 'beta', note: 'Review the evidence' })).toMatchObject({
      control: { kind: 'handoff', agentId: 'beta', agentName: 'Writer', note: 'Review the evidence' }
    })
    expect(actions.delegate).not.toHaveBeenCalled()
  })
  it('persists the gate through its owner before returning an answerable address', async () => {
    const { provider, actions } = subject()
    const result = await provider.callTool('ask_user', { question: 'Which branch?' }, { toolCallId: 'ask-1' })
    expect(actions.askUser).toHaveBeenCalledWith('Which branch?', 'ask-1')
    expect(result.control).toEqual({ kind: 'ask_user', requestId: 'gate-1', question: 'Which branch?' })
    vi.mocked(actions.askUser).mockImplementation(() => { throw new Error('Gate could not be saved') })
    await expect(provider.callTool('ask_user', { question: 'Which branch?' }, { toolCallId: 'ask-2' })).rejects.toThrow('could not be saved')
  })
  it('uses finish for completion and limits progress updates to validated fields', async () => {
    const { provider, actions } = subject()
    await provider.callTool('update_task', { status: 'in_progress', note: 'Verified', artifacts: [{ kind: 'link', name: 'PR', ref: 'https://example.test/pr/1' }] })
    expect(actions.updateTask).toHaveBeenCalledWith({ note: 'Verified', artifacts: [{ kind: 'link', name: 'PR', ref: 'https://example.test/pr/1' }] })
    expect((await provider.callTool('finish', { summary: 'Done and verified' })).control).toEqual({ kind: 'finish', summary: 'Done and verified' })
    await expect(provider.callTool('update_task', { status: 'completed' })).rejects.toThrow('Use ask_user')
    expect(actions.updateTask).toHaveBeenCalledTimes(1)
  })
  it.each([
    ['delegate', { agent: 'not-attached', message: 'Do it' }],
    ['delegate', { agent: 'alpha', message: '' }],
    ['handoff', { agent: 'alpha', note: 'x', nested: true }],
    ['ask_user', { question: 'x'.repeat(4001) }],
    ['update_task', { artifacts: [null] }],
    ['update_task', { artifacts: [{ kind: 'command', name: 'Run', ref: 'sh' }] }],
    ['finish', { summary: 'done', status: 'completed' }]
  ])('refuses invalid %s arguments before side effects', async (name, input) => {
    const { provider, actions } = subject()
    await expect(provider.callTool(name, input, { toolCallId: 'tool' })).rejects.toThrow()
    expect(actions.delegate).not.toHaveBeenCalled()
    expect(actions.askUser).not.toHaveBeenCalled()
    expect(actions.updateTask).not.toHaveBeenCalled()
  })
  it('rejects ambiguous names and a stale task claim', async () => {
    const { actions } = subject()
    const provider = new CoordinatorToolProvider('task', [{ id: 'one', name: 'Same' }, { id: 'two', name: 'Same' }], actions)
    await expect(provider.callTool('handoff', { agent: 'Same', note: 'Next' })).rejects.toThrow('ambiguous')
    vi.mocked(actions.assertCurrent).mockImplementation(() => { throw new Error('Task moved elsewhere') })
    await expect(provider.callTool('finish', { summary: 'Done' })).rejects.toThrow('moved elsewhere')
  })
})
