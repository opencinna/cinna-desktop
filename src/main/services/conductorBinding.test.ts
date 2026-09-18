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
const { conductorBridge } = await import('./conductorBridge')
const agent = { id: 'root', driver: 'acp' } as Parameters<typeof conductorBridge.prepare>[1]
function input(extra: Partial<RunInput> = {}): RunInput {
  return { chatId: 'chat', messageId: 'message', wireContent: 'hello', signal: new AbortController().signal, runScope: { settingsUserId: 'settings', profileUserId: 'profile' }, ...extra }
}
function plan(): AcpLaunchPlan { return { spec: {}, session: { mcpServers: [] } } as unknown as AcpLaunchPlan }
const provider = { providerType: 'mcp' as const, displayName: 'connector', getTools: () => [], callTool: vi.fn(async () => ({ content: 'answer' })) }
async function call() {
  const context = { signal: new AbortController().signal, toolCallId: 'call', name: 'lookup', requestId: 1 }
  await state.options!.beforeCall!(context)
  return state.options!.executeTool!(provider, 'lookup', {}, { signal: context.signal, toolCallId: context.toolCallId }, context)
}
beforeEach(() => { vi.clearAllMocks() })
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
})
