import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ConductorMcpSessionOptions } from './conductorMcpServer'
import type { ToolProvider } from '../llm/toolProvider'
import type { RunEvent } from '../../shared/runEvents'
import type { AgentRow } from '../db/agents'
import type { AcpLaunchPlan } from '../agents/drivers/acp/acpLaunchers'

const state = vi.hoisted(() => ({ options: null as ConductorMcpSessionOptions | null, save: vi.fn(), abort: vi.fn(), digest: vi.fn(), tools: [] as string[],
  listings: 0, order: [] as string[], refreshed: [] as string[][], guided: false, unbuilt: true, guidedOwners: [] as string[] }))
vi.mock('./localAgents/localAgentService', () => ({ localAgentService: { guidedBuildOpen: (owner: string) => { state.guidedOwners.push(owner); return state.unbuilt } } }))
vi.mock('../db/chats', () => ({ chatRepo: { getOwned: () => ({ agentId: 'root', router: 'coordinator', guidedBuild: state.guided }) } }))
vi.mock('../db/tasks', () => ({ taskRepo: { getByChatId: () => ({ id: 'delegated-task' }) } }))
vi.mock('../db/delegations', () => ({ delegationRepo: { byTaskId: () => ({ targetAgentId: 'root' }) } }))
vi.mock('../db/chatMcp', () => ({ chatMcpRepo: { listProviderIds: () => [] } }))
vi.mock('../db/chatOnDemandMcp', () => ({ chatOnDemandMcpRepo: { listProviderIds: () => [] } }))
vi.mock('./agentMcpService', () => ({ agentMcpService: { providerIds: () => [], ensureConnected: async () => {} } }))
vi.mock('../db/messages', () => ({ messageRepo: { saveToolCall: state.save } }))
vi.mock('../db/conductorSessions', () => ({ conductorSessionRepo: { get: vi.fn(), save: state.digest } }))
vi.mock('../mcp/manager', () => ({ mcpManager: {} }))
vi.mock('../mcp/toolChanges', () => ({ onMcpToolsChanged: vi.fn() }))
vi.mock('./a2aAsMcpProvider', () => ({ buildAgentToolProviders: () => [{ providerType: 'agent', displayName: 'Agents', getTools: () => state.tools.map((name) => ({ name })) }] }))
vi.mock('./chatSessionRelease', () => ({ installChatSessionForgetter: vi.fn() }))
vi.mock('./chatConductorService', () => ({ canConduct: () => true, isChatConductor: () => false, conductorContext: vi.fn() }))
vi.mock('./conductorMcpServer', () => ({ ConductorMcpServer: class {
  async ensureSession(_key: string, options: ConductorMcpSessionOptions) {
    state.options = options
    return { descriptor: { name: 'cinna', type: 'http', url: 'http://127.0.0.1:1/mcp', headers: [] }, abortCalls: state.abort, dispose: vi.fn(),
      // What a listing answered right after the announcement would serve.
      refreshTools: vi.fn(async () => {
        state.order.push('refresh')
        state.refreshed.push((await state.options!.getProviders()).flatMap((provider) => provider.getTools().map((tool) => tool.name)))
      }),
      toolsListings: () => { state.order.push('mark'); return state.listings },
      offers: (name: string) => state.tools.includes(name) }
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
  it('offers requester and executor tools to an ordinary adopted folder session', async () => {
    const plan = { spec: { remote: false }, session: { mcpServers: [] } } as unknown as AcpLaunchPlan
    const lease = await conductorBridge.prepare('settings', { id: 'root', source: 'folder', localPath: '/tmp/project', driver: 'acp' } as AgentRow,
      { chatId: 'ordinary-folder', wireContent: 'Work', signal: new AbortController().signal, runScope: { profileUserId: 'user', settingsUserId: 'settings' } }, plan, vi.fn(), () => true)
    const providers = await state.options!.getProviders()
    const tools = providers.flatMap((provider) => provider.getTools()).map((tool) => tool.name)
    expect(tools).toEqual(expect.arrayContaining(['tasks_targets', 'tasks_list', 'tasks_get', 'tasks_create', 'tasks_update',
      'tasks_comment', 'tasks_report', 'tasks_reply']))
    // `tasks_create` with an assignee is the only way to delegate through a tool; no old name survives as an alias.
    for (const old of ['handover_create', 'handover_targets', 'handover_list', 'handover_reply', 'handover_report', 'task_create', 'task_update', 'task_comment']) {
      expect(tools).not.toContain(old)
    }
    expect(new Set(providers.flatMap((provider) => provider.getTools()).filter((tool) => tool.name.startsWith('task')).map((tool) => tool.mcpProviderId)))
      .toEqual(new Set(['cinna-handovers']))
    expect(plan.session.mcpServers).toEqual([expect.objectContaining({ name: 'cinna', type: 'http' })])
    lease?.close()
  })

  it('offers the build brief tool to a folder agent’s own session only in a guided chat', async () => {
    const toolsIn = async (chatId: string): Promise<string[]> => {
      const plan = { spec: { remote: false }, session: { mcpServers: [] } } as unknown as AcpLaunchPlan
      const lease = await conductorBridge.prepare('settings', { id: 'root', source: 'folder', localPath: '/tmp/project', driver: 'acp' } as AgentRow,
        { chatId, wireContent: 'Work', signal: new AbortController().signal, runScope: { profileUserId: 'user', settingsUserId: 'settings' } }, plan, vi.fn(), () => true)
      const tools = (await state.options!.getProviders()).flatMap((provider) => provider.getTools()).map((tool) => tool.name)
      lease?.close()
      return tools
    }
    try {
      expect(await toolsIn('plain-folder')).not.toContain('build_brief_propose')
      state.guided = true
      expect(await toolsIn('guided-folder')).toContain('build_brief_propose')
      expect(state.guidedOwners.at(-1)).toBe('settings')
    } finally {
      state.guided = false
    }
  })

  it('stops offering the build brief tool once the guided chat’s agent is no longer unbuilt', async () => {
    // Mutation: drop the fresh unbuilt read and a started or skipped build keeps the tool forever.
    const plan = { spec: { remote: false }, session: { mcpServers: [] } } as unknown as AcpLaunchPlan
    state.guided = true
    state.unbuilt = false
    try {
      const lease = await conductorBridge.prepare('settings', { id: 'root', source: 'folder', localPath: '/tmp/project', driver: 'acp' } as AgentRow,
        { chatId: 'guided-built', wireContent: 'Work', signal: new AbortController().signal, runScope: { profileUserId: 'user', settingsUserId: 'settings' } }, plan, vi.fn(), () => true)
      const tools = (await state.options!.getProviders()).flatMap((provider) => provider.getTools()).map((tool) => tool.name)
      lease?.close()
      expect(tools).not.toContain('build_brief_propose')
      expect(tools).toContain('tasks_list')
    } finally {
      state.guided = false
      state.unbuilt = true
    }
  })

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

  it('gives an engine that never re-reads its tools a new session when the tool list changes', async () => {
    const digests = async (fixed: boolean): Promise<string[]> => {
      state.digest.mockClear()
      const chatId = `bridge-${++counter}`
      for (const tools of [['writer'], ['writer'], ['writer', 'reviewer']]) {
        state.tools = tools
        const lease = await conductorBridge.prepare('owner', { id: 'root', driver: 'acp' } as AgentRow,
          { chatId, wireContent: 'Task', signal: new AbortController().signal, runScope: { profileUserId: 'user', settingsUserId: 'settings' } },
          { spec: { remote: false }, session: { mcpServers: [] }, sessionToolsFixed: fixed } as unknown as AcpLaunchPlan, vi.fn(), () => true)
        lease!.sessionReady!()
        lease!.close()
      }
      state.tools = []
      return state.digest.mock.calls.map((call) => call[2] as string)
    }
    state.refreshed = []
    const [first, same, grown] = await digests(true)
    expect(same).toBe(first)
    expect(grown).not.toBe(first)
    // Codex reads its tools at `session/new`: no `awaitMcpTools`, so its fresh
    // sessions are never announced. Mutation: drop that gate and this fills.
    expect(state.refreshed).toEqual([])
    // Claude adopts `tools/list_changed` in the live session.
    expect(new Set(await digests(false)).size).toBe(1)
  })

  it('gives an OpenCode conductor a new session when a tool is attached after its first turn', async () => {
    // OpenCode 2 fixes its Code Mode tool catalog for a session at the first
    // prompt; the plan below is what its launcher returns for that.
    // Mutation: drop the tool names from the session digest and the third
    // turn keeps the session that has no `reviewer`.
    const saved = new Map<string, string>()
    const { conductorSessionRepo } = await import('../db/conductorSessions')
    vi.mocked(conductorSessionRepo.get).mockImplementation((chatId: string, agentId: string) => saved.get(`${chatId}:${agentId}`) ?? null)
    state.digest.mockImplementation((chatId: string, agentId: string, hash: string) => { saved.set(`${chatId}:${agentId}`, hash) })
    const chatId = `bridge-${++counter}`
    const fresh: boolean[] = []
    const marks: Array<number | undefined> = []
    state.refreshed = []
    try {
      for (const [index, tools] of [[], [], ['invoice_reader']].entries()) {
        state.tools = tools
        state.listings = index * 2
        const lease = await conductorBridge.prepare('owner', { id: 'root', driver: 'acp' } as AgentRow,
          { chatId, wireContent: 'Task', signal: new AbortController().signal, runScope: { profileUserId: 'user', settingsUserId: 'settings' } },
          { spec: { remote: false }, session: { mcpServers: [] }, awaitMcpTools: { settleMs: 300 }, sessionToolsFixed: true } as unknown as AcpLaunchPlan, vi.fn(), () => true)
        fresh.push(lease!.freshSession === true)
        marks.push(lease!.toolsRefreshMark)
        lease!.sessionReady!()
        lease!.close()
      }
    } finally {
      state.tools = []
      vi.mocked(conductorSessionRepo.get).mockReset()
      state.digest.mockReset()
    }
    expect(fresh).toEqual([true, false, true])
    // A fresh session announces its tools and hands the driver the listing
    // count of that moment (`awaitCinnaTools`); a kept session does neither.
    // Mutation: refresh on every turn and the kept one re-lists too.
    expect(marks).toEqual([0, undefined, 4])
    expect(state.refreshed).toEqual([[], ['invoice_reader']])
  })

  it('announces a fresh session’s tools once its turn is bound, with the mark taken first', async () => {
    // The attach-time re-list ran before the turn existed, without the
    // binding's own tools (`tasks_*` here). Mutation: refresh before setting
    // `entry.binding`, and the announced set lacks them.
    const { conductorSessionRepo } = await import('../db/conductorSessions')
    vi.mocked(conductorSessionRepo.get).mockReturnValue(null)
    state.refreshed = []
    state.order = []
    state.listings = 5
    try {
      const lease = await conductorBridge.prepare('settings', { id: 'root', source: 'folder', localPath: '/tmp/project', driver: 'acp' } as AgentRow,
        { chatId: `bridge-${++counter}`, wireContent: 'Work', signal: new AbortController().signal, runScope: { profileUserId: 'user', settingsUserId: 'settings' } },
        { spec: { remote: false }, session: { mcpServers: [] }, awaitMcpTools: { settleMs: 300 }, sessionToolsFixed: true } as unknown as AcpLaunchPlan, vi.fn(), () => true)
      expect(lease!.freshSession).toBe(true)
      expect(lease!.toolsRefreshMark).toBe(5)
      expect(state.refreshed).toHaveLength(1)
      expect(state.refreshed[0]).toEqual(expect.arrayContaining(['tasks_create', 'tasks_report']))
      // Marked before the announcement: a re-list answered while it is sent still counts.
      expect(state.order).toEqual(['mark', 'refresh'])
      lease!.close()
    } finally {
      vi.mocked(conductorSessionRepo.get).mockReset()
      state.listings = 0
    }
  })

  it('answers what its server offered from the session, synchronously', async () => {
    state.tools = ['probe']
    const turn = await subject()
    expect(turn.lease.offers?.('probe')).toBe(true)
    expect(turn.lease.offers?.('x_y')).toBe(false)
    state.tools = []
    turn.lease.close()
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

describe('OpenCode 2 Code Mode across turns', () => {
  const prepare = (chatId: string) => conductorBridge.prepare('owner', { id: 'root', driver: 'acp' } as AgentRow,
    { chatId, wireContent: 'Task', signal: new AbortController().signal, runScope: { profileUserId: 'user', settingsUserId: 'settings' } },
    { spec: { remote: false }, session: { mcpServers: [] } } as unknown as AcpLaunchPlan, vi.fn(), () => true)
  const settled = async (promise: Promise<unknown> | void): Promise<boolean> => {
    let done = false
    void Promise.resolve(promise).then(() => { done = true }, () => { done = true })
    await new Promise((resolve) => setTimeout(resolve, 20))
    return done
  }

  it('forgets an `execute` left running when its turn ends, so the next turn’s calls wait for their notice again', async () => {
    // Mutation: drop `endTurn()` from the lease's close and the second call
    // below is released at once, ahead of the text the engine streamed before it.
    const chatId = `code-mode-${++counter}`
    const first = (await prepare(chatId))!
    expect(first.ownsCodeModeCalls).toBe(false)
    first.observe!({ sessionId: 's', update: { sessionUpdate: 'tool_call', toolCallId: 'exec-1', title: 'execute', kind: 'other', status: 'pending', rawInput: {} } })
    // Inside a running `execute` there is no notice to wait for.
    expect(await settled(state.options!.beforeCall!({ toolCallId: 'call-a', requestId: 'r1', name: 'tool', signal: new AbortController().signal }))).toBe(true)
    // The engine never finished it (killed, or closed by the driver after a refusal).
    first.close()

    const second = (await prepare(chatId))!
    const abort = new AbortController()
    const waiting = state.options!.beforeCall!({ toolCallId: 'call-b', requestId: 'r2', name: 'tool', signal: abort.signal })
    expect(await settled(waiting)).toBe(false)
    abort.abort()
    await waiting
    second.close()
  })
})
