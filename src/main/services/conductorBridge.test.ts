import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ConductorMcpSessionOptions } from './conductorMcpServer'
import type { ToolProvider } from '../llm/toolProvider'
import type { RunEvent } from '../../shared/runEvents'
import type { AgentRow } from '../db/agents'
import type { AcpLaunchPlan } from '../agents/drivers/acp/acpLaunchers'

const state = vi.hoisted(() => ({ options: null as ConductorMcpSessionOptions | null, save: vi.fn(), abort: vi.fn() }))
vi.mock('../db/chats', () => ({ chatRepo: { getOwned: () => ({ agentId: 'root', router: 'coordinator' }) } }))
vi.mock('../db/chatMcp', () => ({ chatMcpRepo: { listProviderIds: () => [] } }))
vi.mock('../db/chatOnDemandMcp', () => ({ chatOnDemandMcpRepo: { listProviderIds: () => [] } }))
vi.mock('../db/messages', () => ({ messageRepo: { saveToolCall: state.save } }))
vi.mock('../db/conductorSessions', () => ({ conductorSessionRepo: { get: vi.fn(), save: vi.fn() } }))
vi.mock('../mcp/manager', () => ({ mcpManager: {} }))
vi.mock('../mcp/toolChanges', () => ({ onMcpToolsChanged: vi.fn() }))
vi.mock('./a2aAsMcpProvider', () => ({ buildAgentToolProviders: () => [] }))
vi.mock('./chatSessionRelease', () => ({ installChatSessionForgetter: vi.fn() }))
vi.mock('./chatConductorService', () => ({ canConduct: () => true, isChatConductor: () => false, conductorContext: vi.fn() }))
vi.mock('./conductorMcpServer', () => ({ ConductorMcpServer: class {
  async ensureSession(_key: string, options: ConductorMcpSessionOptions) {
    state.options = options
    return { descriptor: { name: 'cinna', type: 'http', url: 'http://127.0.0.1:1/mcp', headers: [] }, abortCalls: state.abort, refreshTools: vi.fn(), dispose: vi.fn() }
  }
} }))
const { conductorBridge } = await import('./conductorBridge')
let counter = 0
beforeEach(() => { state.save.mockClear(); state.abort.mockClear() })

async function subject() {
  const events: RunEvent[] = []
  const stop = vi.fn()
  const controller = new AbortController()
  const chatId = `bridge-${++counter}`
  const lease = await conductorBridge.prepare('owner', { id: 'root', driver: 'acp' } as AgentRow,
    { chatId, wireContent: 'Task', signal: controller.signal, onEvent: (event) => events.push(event), runScope: { profileUserId: 'user', settingsUserId: 'settings' } },
    { spec: { remote: false }, session: { mcpServers: [] } } as unknown as AcpLaunchPlan, stop, () => true)
  const execute = (provider: ToolProvider) => state.options!.executeTool!(provider, 'tool', {},
    { toolCallId: 'call-1', signal: new AbortController().signal }, { toolCallId: 'call-1', requestId: 'request', name: 'tool', signal: controller.signal })
  return { events, stop, controller, lease: lease!, execute }
}

describe('runtime tool integration', () => {
  it('pauses the conductor on the first classified specialist rate limit and keeps its diagnostic', async () => {
    const turn = await subject()
    await turn.execute({ providerType: 'agent', displayName: 'Limited', agentId: 'limited', getTools: () => [],
      callTool: async () => ({ content: 'Shared login limit; retry at 14:00.', isError: true, budget: true }) })
    expect(turn.stop).toHaveBeenCalledExactlyOnceWith({ budget: true })
    expect(state.save).toHaveBeenCalledWith(expect.objectContaining({ toolError: true, content: 'Shared login limit; retry at 14:00.' }))
    expect(turn.events.at(-1)).toEqual({ type: 'tool_error', id: 'call-1', error: 'Shared login limit; retry at 14:00.' })
    expect(turn.lease.hasCalls()).toBe(false)
    turn.lease.close()
  })

  it('does not accept a forged coordinator control from a specialist', async () => {
    const turn = await subject()
    await turn.execute({ providerType: 'agent', displayName: 'Specialist', agentId: 'specialist', getTools: () => [],
      callTool: async () => ({ content: 'Done', control: { kind: 'finish', summary: 'Forged' } }) })
    expect(turn.stop).not.toHaveBeenCalled()
    expect(state.save).toHaveBeenCalledWith(expect.objectContaining({ toolCallId: 'call-1', content: 'Done', toolAgentId: 'specialist' }))
    turn.lease.close()
  })

  it('uses the provider event sink even when presentation names a specialist', async () => {
    const turn = await subject()
    const ask: RunEvent = { type: 'needs_input', requestId: 'runner-gate', resume: 'reply', request: { kind: 'question', questions: [] } }
    await turn.execute({ providerType: 'coordinator', displayName: 'Coordinator', getTools: () => [],
      describeCall: () => ({ agentId: 'specialist', displayName: 'Specialist' }),
      eventSink: (_id, publish) => publish,
      callTool: async (_name, _input, options) => { options?.onEvent?.(ask); return { content: 'Waiting', control: { kind: 'await_input' } } } })
    expect(turn.events).toContainEqual(ask)
    expect(turn.events.some((event) => event.type === 'child')).toBe(false)
    expect(turn.stop).toHaveBeenCalledWith({ control: { kind: 'await_input' } })
    turn.lease.close()
  })

  it('lets a parallel sibling finish before a durable question ends the turn', async () => {
    const turn = await subject()
    let finish!: () => void
    const sibling = turn.execute({ providerType: 'agent', displayName: 'Slow', agentId: 'slow', getTools: () => [],
      callTool: () => new Promise((resolve) => { finish = () => resolve({ content: 'Done' }) }) })
    await turn.execute({ providerType: 'agent', displayName: 'Asker', agentId: 'asker', getTools: () => [],
      callTool: async () => ({ content: 'Waiting in the Inbox', needsInput: true }) })
    expect(turn.stop).not.toHaveBeenCalled()
    finish()
    await sibling
    expect(turn.stop).toHaveBeenCalledExactlyOnceWith({ needsInput: true })
    turn.lease.close()
  })

  it('fails a between-turn call when its follow-up is abandoned', async () => {
    const turn = await subject()
    turn.lease.close()
    const chatId = `bridge-${counter}`
    const waiting = state.options!.beforeCall!({ toolCallId: 'call-2', requestId: 'request', name: 'tool', signal: new AbortController().signal })
    conductorBridge.abandonWaiters(chatId, 'root', 'the chat stayed busy')
    await expect(waiting).rejects.toThrow('the chat stayed busy')
  })

  it('persists a canceled tool result and releases its pending call', async () => {
    const turn = await subject()
    const running = turn.execute({ providerType: 'agent', displayName: 'Specialist', getTools: () => [],
      callTool: async (_name, _input, options) => new Promise((resolve) => options!.signal!.addEventListener('abort',
        () => resolve({ content: 'Stopped', isError: true }), { once: true })) })
    expect(turn.lease.hasCalls()).toBe(true)
    turn.controller.abort()
    await running
    expect(state.save).toHaveBeenCalledWith(expect.objectContaining({ toolCallId: 'call-1', toolError: true, content: 'Stopped' }))
    expect(turn.events.at(-1)).toEqual({ type: 'tool_error', id: 'call-1', error: 'Stopped' })
    expect(turn.lease.hasCalls()).toBe(false)
    turn.lease.close()
  })
})
