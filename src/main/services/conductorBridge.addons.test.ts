import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ConductorMcpSessionOptions } from './conductorMcpServer'
import type { ToolProvider } from '../llm/toolProvider'
import type { AgentRow } from '../db/agents'
import type { AcpLaunchPlan } from '../agents/drivers/acp/acpLaunchers'
import type { RunInput } from '../agents/drivers/driver'

/**
 * A folder agent's MCP addons through the conductor bridge: offered in every
 * session of the agent, alone in a nested run, refreshed when attached.
 */

const state = vi.hoisted(() => ({
  chat: { agentId: 'alpha', router: 'direct' } as { agentId: string | null; router: string; deletedAt?: Date | null },
  chatMcps: [] as string[],
  addons: {} as Record<string, string[]>,
  connected: new Set<string>(),
  sessions: new Map<string, { options: ConductorMcpSessionOptions; refreshTools: ReturnType<typeof vi.fn> }>(),
  ensureConnected: vi.fn(async () => {}),
  saveToolCall: vi.fn(),
  conductor: false,
  toolsChanged: null as ((providerId: string) => void) | null
}))
vi.mock('../auth/chatScope', () => ({ visibleChat: () => state.chat }))
vi.mock('../db/chatMcp', () => ({ chatMcpRepo: { listProviderIds: () => state.chatMcps } }))
vi.mock('../db/chatOnDemandMcp', () => ({ chatOnDemandMcpRepo: { listProviderIds: () => [] } }))
vi.mock('./agentMcpService', () => ({ agentMcpService: {
  providerIds: (owner: string, agentId: string) => owner === 'settings' ? state.addons[agentId] ?? [] : [],
  ensureConnected: state.ensureConnected
} }))
vi.mock('../db/messages', () => ({ messageRepo: { saveToolCall: state.saveToolCall } }))
vi.mock('../db/conductorSessions', () => ({ conductorSessionRepo: { get: vi.fn(), save: vi.fn() } }))
vi.mock('../db/tasks', () => ({ taskRepo: { getByChatId: () => undefined } }))
vi.mock('../db/delegations', () => ({ delegationRepo: { byTaskId: () => undefined } }))
vi.mock('./delegationToolProvider', () => ({ DelegationToolProvider: class {
  providerType = 'handover'; displayName = 'Handovers'
  getTools() { return [{ name: 'handover_list' }] }
} }))
vi.mock('../tasks/toolCallBudget', () => ({ taskToolCallBudgetForChat: () => null }))
vi.mock('../mcp/manager', () => ({ mcpManager: {
  getConnection: (id: string) => ({ status: state.connected.has(id) ? 'connected' : 'disconnected', config: { name: id.toUpperCase() } }),
  getToolsForProviders: (ids: string[]) => ids.map((id) => ({ name: `${id}_tool` }))
} }))
vi.mock('../mcp/toolChanges', () => ({ onMcpToolsChanged: (listener: (providerId: string) => void) => { state.toolsChanged = listener } }))
vi.mock('./a2aAsMcpProvider', () => ({ buildAgentToolProviders: () => [{ providerType: 'agent', displayName: 'Agents', getTools: () => [{ name: 'ask_beta' }] }] }))
vi.mock('./chatSessionRelease', () => ({ installChatSessionForgetter: vi.fn() }))
vi.mock('../agents/drivers/acp/conductorToolPolicy', () => ({ applyConductorToolPolicy: () => ({}) }))
vi.mock('./chatConductorService', () => ({
  canConduct: () => true,
  isChatConductor: () => state.conductor,
  conductorContext: () => ({ toolPolicy: 'none', engine: 'claude' })
}))
vi.mock('./conductorMcpServer', () => ({ ConductorMcpServer: class {
  async ensureSession(key: string, options: ConductorMcpSessionOptions) {
    const existing = state.sessions.get(key)
    const refreshTools = existing?.refreshTools ?? vi.fn(async () => {})
    state.sessions.set(key, { options, refreshTools })
    return { descriptor: { name: 'cinna', type: 'http', url: `http://127.0.0.1:1/${key}`, headers: [] }, abortCalls: vi.fn(), refreshTools, dispose: vi.fn(),
      offers: () => false }
  }
} }))
const { conductorBridge } = await import('./conductorBridge')

const alpha = { id: 'alpha', source: 'folder', localPath: '/tmp/alpha', driver: 'acp' } as AgentRow
const scope = { profileUserId: 'user', settingsUserId: 'settings' }
let counter = 0

beforeEach(() => {
  state.chat = { agentId: 'alpha', router: 'direct' }
  state.chatMcps = []
  state.addons = {}
  state.connected = new Set()
  state.ensureConnected.mockClear()
  state.saveToolCall.mockClear()
  state.conductor = false
})

async function prepare(agent: AgentRow, extra: Partial<RunInput> = {}, chatId = `chat-${++counter}`, sessionToolsFixed = false) {
  const plan = { spec: { remote: false }, session: { mcpServers: [] }, ...(sessionToolsFixed ? { sessionToolsFixed } : {}) } as unknown as AcpLaunchPlan
  const lease = await conductorBridge.prepare('settings', agent,
    { chatId, wireContent: 'Work', signal: new AbortController().signal, runScope: scope, ...extra }, plan, vi.fn(), () => true)
  return { lease, plan, chatId }
}
async function tools(key: string): Promise<string[]> {
  const providers = await state.sessions.get(key)!.options.getProviders()
  return providers.flatMap((provider: ToolProvider) => provider.getTools().map((tool) => tool.name))
}

describe('agent MCP addons', () => {
  it('offers the addons beside the chat MCPs in the agent’s own chat, once each', async () => {
    state.addons.alpha = ['gh', 'shared']
    state.chatMcps = ['shared', 'mode']
    state.connected = new Set(['gh', 'shared', 'mode'])
    const { lease, chatId } = await prepare(alpha)
    const names = await tools(JSON.stringify([chatId, 'alpha']))
    expect(names).toEqual(expect.arrayContaining(['gh_tool', 'shared_tool', 'mode_tool', 'handover_list']))
    expect(names.filter((name) => name === 'shared_tool')).toHaveLength(1)
    lease?.close()
  })

  it('offers only the addons in a chat bound to another agent', async () => {
    state.chat = { agentId: 'root', router: 'coordinator' }
    state.addons.alpha = ['gh']
    state.chatMcps = ['mode']
    state.connected = new Set(['gh', 'mode'])
    const { lease, chatId } = await prepare(alpha)
    expect(await tools(JSON.stringify([chatId, 'alpha']))).toEqual(['gh_tool'])
    lease?.close()
  })

  it('leaves out an addon that is not connected, after trying to connect it', async () => {
    state.addons.alpha = ['gh', 'down']
    state.connected = new Set(['gh'])
    const { lease, chatId } = await prepare(alpha)
    expect(state.ensureConnected).toHaveBeenCalledWith('settings', 'alpha', { signal: expect.any(AbortSignal) })
    const names = await tools(JSON.stringify([chatId, 'alpha']))
    expect(names).toContain('gh_tool')
    expect(names).not.toContain('down_tool')
    lease?.close()
  })

  it('does not try to connect anything for an agent with no addons', async () => {
    const { lease } = await prepare(alpha)
    expect(state.ensureConnected).not.toHaveBeenCalled()
    lease?.close()
  })

  it('offers nothing to a chat conductor whose tool policy is none', async () => {
    state.conductor = true
    state.addons.alpha = ['gh']
    state.connected = new Set(['gh'])
    const { lease, chatId } = await prepare(alpha)
    expect(await tools(JSON.stringify([chatId, 'alpha']))).toEqual([])
    lease?.close()
  })

  it('serves a nested run with addons only its addons, on its own endpoint', async () => {
    state.chat = { agentId: 'root', router: 'coordinator' }
    state.addons.alpha = ['gh']
    state.chatMcps = ['mode']
    state.connected = new Set(['gh', 'mode'])
    const coordinator = { providerType: 'coordinator', displayName: 'Coordinator', getTools: () => [{ name: 'finish' }] } as unknown as NonNullable<RunInput['coordinator']>
    const { lease, plan, chatId } = await prepare(alpha, { nested: { toolCallId: 'call-1' }, coordinator })
    expect(lease).toBeDefined()
    expect(plan.session.mcpServers).toEqual([expect.objectContaining({ name: 'cinna' })])
    const key = JSON.stringify(['nested', chatId, 'alpha'])
    expect(state.sessions.has(JSON.stringify([chatId, 'alpha']))).toBe(false)
    expect(await tools(key)).toEqual(['gh_tool'])
    // The parent chat's observer is not this session's: nothing opens between turns.
    lease!.close()
    await expect(state.sessions.get(key)!.options.beforeCall!({ toolCallId: 'late', requestId: 'r', name: 'gh_tool', signal: new AbortController().signal }))
      .rejects.toThrow('no longer listening')
  })

  it('keeps a nested call out of the parent transcript', async () => {
    state.addons.alpha = ['gh']
    state.connected = new Set(['gh'])
    const events: unknown[] = []
    const { lease, chatId } = await prepare(alpha, { nested: { toolCallId: 'call-1' }, onEvent: (event) => events.push(event) })
    const provider = { providerType: 'mcp', displayName: 'GH', getTools: () => [], callTool: async () => ({ content: 'ok' }) } as unknown as ToolProvider
    await state.sessions.get(JSON.stringify(['nested', chatId, 'alpha']))!.options.executeTool!(provider, 'gh_tool', {},
      { toolCallId: 'c1', signal: new AbortController().signal }, { toolCallId: 'c1', requestId: 'r', name: 'gh_tool', signal: new AbortController().signal })
    expect(state.saveToolCall).not.toHaveBeenCalled()
    expect(events).toContainEqual(expect.objectContaining({ type: 'tool_result', id: 'c1' }))
    lease?.close()
  })

  it('keeps a nested session on a fixed-tools engine out of the chat’s session slot, and reuses it while the digest holds', async () => {
    state.addons.alpha = ['gh']
    state.connected = new Set(['gh'])
    const nestedRun = { nested: { toolCallId: 'call-1' } }
    const first = await prepare(alpha, nestedRun, undefined, true)
    expect(first.lease?.freshSession).toBe(true)
    expect(first.lease?.session?.read()).toBeNull()
    first.lease!.session!.save('ses_nested')
    first.lease!.sessionReady!()
    first.lease!.close()
    const second = await prepare(alpha, nestedRun, first.chatId, true)
    expect(second.lease?.freshSession).toBe(false)
    expect(second.lease?.session?.read()).toBe('ses_nested')
    // Lost: the id goes with the digest.
    second.lease!.sessionLost!()
    expect(second.lease!.session!.read()).toBeNull()
    second.lease!.close()
    // The agent's own session, and a nested run on an engine that re-reads its tools, keep the runtime's slot.
    const own = await prepare(alpha, {}, first.chatId, true)
    expect(own.lease?.session).toBeUndefined()
    own.lease?.close()
    const rereads = await prepare(alpha, nestedRun)
    expect(rereads.lease?.session).toBeUndefined()
    rereads.lease?.close()
  })

  it('gives a nested run with no addons no lease, as before', async () => {
    state.chatMcps = ['mode']
    state.connected = new Set(['mode'])
    const before = state.sessions.size
    const { lease } = await prepare(alpha, { nested: { toolCallId: 'call-1' } })
    expect(lease).toBeUndefined()
    expect(state.sessions.size).toBe(before)
  })

  it('refreshes every live session of the agent when its addons change, and only those', async () => {
    state.addons.alpha = ['gh']
    const own = await prepare(alpha)
    const nested = await prepare(alpha, { nested: { toolCallId: 'call-1' } }, own.chatId)
    const other = await prepare({ ...alpha, id: 'beta' } as AgentRow)
    const refreshed = (key: string) => state.sessions.get(key)!.refreshTools
    for (const key of [JSON.stringify([own.chatId, 'alpha']), JSON.stringify(['nested', own.chatId, 'alpha']), JSON.stringify([other.chatId, 'beta'])]) refreshed(key).mockClear()
    await conductorBridge.refreshAgent('alpha')
    expect(refreshed(JSON.stringify([own.chatId, 'alpha']))).toHaveBeenCalledOnce()
    expect(refreshed(JSON.stringify(['nested', own.chatId, 'alpha']))).toHaveBeenCalledOnce()
    expect(refreshed(JSON.stringify([other.chatId, 'beta']))).not.toHaveBeenCalled()
    for (const run of [own, nested, other]) run.lease?.close()
  })

  it('refreshes the agent’s sessions when an addon’s tools change', async () => {
    state.addons.alpha = ['gh']
    const { lease, chatId } = await prepare(alpha)
    const refresh = state.sessions.get(JSON.stringify([chatId, 'alpha']))!.refreshTools
    refresh.mockClear()
    state.toolsChanged!('gh')
    expect(refresh).toHaveBeenCalledOnce()
    lease?.close()
  })
})
