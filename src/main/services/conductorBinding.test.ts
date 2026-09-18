import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ConductorMcpSessionOptions } from './conductorMcpServer'
import type { RunInput } from '../agents/drivers/driver'
import type { AcpLaunchPlan } from '../agents/drivers/acp/acpLaunchers'
import { notifyMcpToolsChanged } from '../mcp/toolChanges'
const state = vi.hoisted(() => ({ options: null as ConductorMcpSessionOptions | null, refresh: vi.fn(async () => {}), saved: vi.fn() }))
vi.mock('./conductorMcpServer', () => ({ ConductorMcpServer: class {
  async ensureSession(_key: string, options: ConductorMcpSessionOptions) {
    state.options = options
    return { descriptor: { type: 'http', name: 'cinna', url: 'http://127.0.0.1/test', headers: [] }, refreshTools: state.refresh, abortCalls: vi.fn(), dispose: vi.fn() }
  }
  async dispose() {}
} }))
vi.mock('../db/conductorSessions', () => ({ conductorSessionRepo: { get: () => 'old', save: vi.fn() } }))
vi.mock('../db/chats', () => ({ chatRepo: { getOwned: () => ({ agentId: 'root', router: 'coordinator' }) } }))
vi.mock('../db/chatMcp', () => ({ chatMcpRepo: { listProviderIds: () => ['connector'] } }))
vi.mock('../db/chatOnDemandMcp', () => ({ chatOnDemandMcpRepo: { listProviderIds: () => [] } }))
vi.mock('../db/messages', () => ({ messageRepo: { saveToolCall: state.saved } }))
vi.mock('../mcp/manager', () => ({ mcpManager: { getConnection: () => undefined } }))
vi.mock('../llm/toolProvider', () => ({ McpToolProvider: class {} }))
vi.mock('./a2aAsMcpProvider', () => ({ buildAgentToolProviders: () => [] }))
vi.mock('./chatConductorService', () => ({ canConduct: () => true, isChatConductor: () => false, conductorContext: () => ({}) }))
vi.mock('./chatSessionRelease', () => ({ installChatSessionForgetter: vi.fn() }))
const runtimes = vi.hoisted(() => new Map<string, import('../tasks/runtimeTypes').TaskRuntimeCheckpoint>())
vi.mock('../db/taskRuntimes', () => ({ taskRuntimeRepo: {
  get: (userId: string, taskId: string) => runtimes.get(`${userId}/${taskId}`) ?? null,
  save: (userId: string, taskId: string, value: import('../tasks/runtimeTypes').TaskRuntimeCheckpoint) => { runtimes.set(`${userId}/${taskId}`, value) }
} }))
const { conductorBridge } = await import('./conductorBridge')
const { taskRunnersByChat } = await import('./taskRunnerState')
const agent = { id: 'root', driver: 'acp' } as Parameters<typeof conductorBridge.prepare>[1]
function input(extra: Partial<RunInput> = {}): RunInput {
  return { chatId: 'chat', messageId: 'message', wireContent: 'hello', signal: new AbortController().signal, runScope: { settingsUserId: 'settings', profileUserId: 'profile' }, ...extra }
}
function plan(): AcpLaunchPlan { return { spec: {}, session: { mcpServers: [] } } as unknown as AcpLaunchPlan }
const provider = { providerType: 'mcp' as const, displayName: 'connector', getTools: () => [], callTool: vi.fn(async () => ({ content: 'answer' })) }
async function call(target: Parameters<ConductorMcpSessionOptions['executeTool'] & object>[0] = provider, name = 'lookup') {
  const context = { signal: new AbortController().signal, toolCallId: 'call', name, requestId: 1 }
  await state.options!.beforeCall!(context)
  return state.options!.executeTool!(target, name, {}, { signal: context.signal, toolCallId: context.toolCallId }, context)
}
const coordinator = { providerType: 'coordinator' as const, displayName: 'Task runner', getTools: () => [], budgetExempt: (name: string) => ['update_task', 'finish'].includes(name), callTool: vi.fn(async (name: string) => ({ content: `${name} ok` })) }
beforeEach(() => { vi.clearAllMocks(); runtimes.clear(); taskRunnersByChat.clear() })
afterEach(async () => { await conductorBridge.shutdown() })
describe('conductor turn binding', () => {
  it('waits for the native follow-up owner to bind when MCP arrives between turns', async () => {
    const wake = vi.fn(() => true)
    const first = await conductorBridge.prepare('profile', agent, input(), plan(), vi.fn(), wake)
    first!.close()
    const pending = call()
    await vi.waitFor(() => expect(wake).toHaveBeenCalledOnce())
    expect(provider.callTool).not.toHaveBeenCalled()
    const followup = await conductorBridge.prepare('profile', agent, input(), plan(), vi.fn(), wake)
    await pending
    expect(provider.callTool).toHaveBeenCalledOnce()
    followup!.close()
  })
  it('uses the persisted budget exactly and flushes narration before tools', async () => {
    let remaining = 3
    const order: string[] = []
    const stop = vi.fn()
    state.saved.mockImplementation(() => order.push('save'))
    const lease = await conductorBridge.prepare('profile', agent, input({ flush: () => order.push('flush'), toolCallBudget: { get remaining() { return remaining }, consume: () => { remaining-- } } }), plan(), stop, () => true)
    await call(); await call(); await call()
    expect(provider.callTool).toHaveBeenCalledTimes(3)
    expect(remaining).toBe(0)
    expect(order).toEqual(['flush', 'save', 'flush', 'save', 'flush', 'save'])
    await call()
    expect(provider.callTool).toHaveBeenCalledTimes(3)
    expect(stop).toHaveBeenCalledWith({ budget: true })
    lease!.close()
  })
  it('stops immediately if durable budget consumption rejects a stale snapshot', async () => {
    const stop = vi.fn()
    await conductorBridge.prepare('profile', agent, input({ toolCallBudget: { remaining: 1, consume: () => { throw new Error('tool-call limit') } } }), plan(), stop, () => true)
    expect(await call()).toMatchObject({ budget: true, isError: true })
    expect(stop).toHaveBeenCalledWith({ budget: true })
    expect(provider.callTool).not.toHaveBeenCalled()
  })
  it('refreshes an attached connector after connection/catalogue changes only', async () => {
    await conductorBridge.prepare('profile', agent, input(), plan(), vi.fn(), () => true)
    notifyMcpToolsChanged('unrelated')
    expect(state.refresh).not.toHaveBeenCalled()
    notifyMcpToolsChanged('connector')
    expect(state.refresh).toHaveBeenCalledOnce()
  })
  it('keeps finish and update_task callable at the task cap while every other tool is refused', async () => {
    const stop = vi.fn()
    const consume = vi.fn()
    const lease = await conductorBridge.prepare('profile', agent, input({ toolCallBudget: { remaining: 0, consume } }), plan(), stop, () => true)
    expect(await call(coordinator, 'update_task')).toMatchObject({ content: 'update_task ok' })
    expect(await call(coordinator, 'finish')).toMatchObject({ content: 'finish ok' })
    expect(coordinator.callTool.mock.calls.map(([name]) => name)).toEqual(['update_task', 'finish'])
    expect(consume).not.toHaveBeenCalled()
    expect(stop).not.toHaveBeenCalledWith({ budget: true })
    // An agent call through the runner, and a connector tool that merely shares the name, still count.
    expect(await call(coordinator, 'delegate')).toMatchObject({ isError: true })
    expect(await call(provider, 'finish')).toMatchObject({ isError: true })
    expect(coordinator.callTool).toHaveBeenCalledTimes(2)
    expect(provider.callTool).not.toHaveBeenCalled()
    expect(stop).toHaveBeenCalledWith({ budget: true })
    lease!.close()
  })
  it('caps a follow-up opened between turns with the task checkpoint budget', async () => {
    taskRunnersByChat.set('chat', { userId: 'profile', taskId: 'task', id: 'attempt', working: true, cancel: vi.fn() })
    runtimes.set('profile/task', { budget: { maxRounds: 2, maxMinutes: 60 }, toolCalls: 1, owner: { kind: 'coordinator' },
      coordinator: { agentId: 'root', providerId: null, modelId: null, modeId: null } } as unknown as import('../tasks/runtimeTypes').TaskRuntimeCheckpoint)
    const stop = vi.fn()
    const followup = await conductorBridge.prepare('profile', agent, input(), plan(), stop, () => true)
    await call()
    expect(provider.callTool).toHaveBeenCalledOnce()
    expect(runtimes.get('profile/task')?.toolCalls).toBe(2)
    expect(await call()).toMatchObject({ isError: true })
    expect(provider.callTool).toHaveBeenCalledOnce()
    expect(stop).toHaveBeenCalledWith({ budget: true })
    followup!.close()
  })
  it('leaves a follow-up unbudgeted by the task when another agent owns the task turn', async () => {
    taskRunnersByChat.set('chat', { userId: 'profile', taskId: 'task', id: 'attempt', working: true, cancel: vi.fn() })
    runtimes.set('profile/task', { budget: { maxRounds: 1, maxMinutes: 60 }, toolCalls: 1, owner: { kind: 'agent', agentId: 'analyst', name: 'Analyst', note: '' },
      coordinator: { agentId: 'root', providerId: null, modelId: null, modeId: null } } as unknown as import('../tasks/runtimeTypes').TaskRuntimeCheckpoint)
    const lease = await conductorBridge.prepare('profile', agent, input(), plan(), vi.fn(), () => true)
    await call()
    expect(provider.callTool).toHaveBeenCalledOnce()
    expect(runtimes.get('profile/task')?.toolCalls).toBe(1)
    lease!.close()
  })
})
