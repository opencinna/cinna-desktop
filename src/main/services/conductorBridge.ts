import { ConductorToolCorrelation } from './conductorToolCorrelation'
import { createHash } from 'node:crypto'
import { conductorSessionRepo } from '../db/conductorSessions'
import { applyConductorToolPolicy } from '../agents/drivers/acp/conductorToolPolicy'
import type { AgentRow } from '../db/agents'
import { chatRepo } from '../db/chats'
import { chatMcpRepo } from '../db/chatMcp'
import { chatOnDemandMcpRepo } from '../db/chatOnDemandMcp'
import { messageRepo } from '../db/messages'
import { mcpManager } from '../mcp/manager'
import { onMcpToolsChanged } from '../mcp/toolChanges'
import { createLogger } from '../logger/logger'
import { McpToolProvider, type ToolProvider, type ToolExecutionResult } from '../llm/toolProvider'
import { buildAgentToolProviders } from './a2aAsMcpProvider'
import { taskToolCallBudgetForChat } from '../tasks/toolCallBudget'
import { ConductorMcpServer, type ConductorMcpSession } from './conductorMcpServer'
import { canConduct, conductorContext, isChatConductor } from './chatConductorService'
import { installChatSessionForgetter } from './chatSessionRelease'
import type { RunInput } from '../agents/drivers/driver'
import type { AcpLaunchPlan } from '../agents/drivers/acp/acpLaunchers'
import type { RunEvent } from '../../shared/runEvents'

interface Binding { input: RunInput; pending: number; calls: number; needsInput?: boolean }
interface Entry {
  chatId: string
  agent: AgentRow
  ownerId: string
  scope: NonNullable<RunInput['runScope']>
  session: ConductorMcpSession
  correlation: ConductorToolCorrelation
  binding: Binding | null
  wake(): boolean
  waiters: Set<{resolve(): void; reject(error: Error): void}>
}
const logger = createLogger('conductor-bridge')
const server = new ConductorMcpServer((error) => logger.warn('Conductor MCP listener error', { error: String(error) }))
const entries = new Map<string, Entry>()
const MAX_CALLS = 100

export interface ConductorLease {
  freshSession?: boolean
  sessionReady?(): void
  /** The driver had to create a session: whatever digest was saved describes one that is gone. */
  sessionLost?(): void
  observe?(notification: import('@agentclientprotocol/sdk').SessionNotification): boolean
  owns?(id: string): boolean
  close(): void
  hasCalls(): boolean
}

async function providers(entry: Entry): Promise<ToolProvider[]> {
  const chat = chatRepo.getOwned(entry.scope.profileUserId, entry.chatId)
  if (!chat || chat.deletedAt || (chat.agentId !== entry.agent.id && chat.router !== 'human')) return []
  if (isChatConductor(entry.agent) && conductorContext(entry.agent).toolPolicy === 'none') return []
  const controls = entry.binding?.input.coordinator
  const result: ToolProvider[] = controls ? [controls] : []
  const ids = new Set([...chatMcpRepo.listProviderIds(entry.chatId), ...chatOnDemandMcpRepo.listProviderIds(entry.chatId)])
  for (const id of ids) {
    const connection = mcpManager.getConnection(id)
    if (connection?.status === 'connected') result.push(new McpToolProvider(id, connection.config.name))
  }
  const names = new Set(result.flatMap((provider) => provider.getTools().map((tool) => tool.name)))
  if (!controls && chat.router === 'coordinator') result.push(...buildAgentToolProviders(entry.chatId, entry.scope.settingsUserId,
    entry.scope.profileUserId, names, entry.agent.id))
  return result
}

async function openBetweenTurns(entry: Entry, signal: AbortSignal): Promise<void> {
  if (entry.binding) return
  if (signal.aborted) throw new Error('The tool call was canceled.')
  await new Promise<void>((resolve, reject) => {
    const waiter = { resolve: () => { cleanup(); resolve() }, reject: (error: Error) => { cleanup(); reject(error) } }
    const abort = (): void => waiter.reject(new Error('The tool call was canceled.'))
    const cleanup = (): void => { entry.waiters.delete(waiter); signal.removeEventListener('abort', abort) }
    entry.waiters.add(waiter)
    signal.addEventListener('abort', abort, {once:true})
    if (!entry.wake()) waiter.reject(new Error('The conductor session is no longer listening.'))
  })
}

export const conductorBridge = {
  async prepare(ownerId: string, agent: AgentRow, input: RunInput, plan: AcpLaunchPlan, stop: (outcome: import('../agents/drivers/acp/acpDriver').ConductorOutcome) => void, wake: () => boolean): Promise<ConductorLease | undefined> {
    if (input.nested || !input.runScope || !canConduct(agent) || plan.spec.remote) return undefined
    if (isChatConductor(agent)) Object.assign(plan, applyConductorToolPolicy(plan, conductorContext(agent).engine))
    const key = JSON.stringify([input.chatId, agent.id])
    let entry = entries.get(key)
    const binding: Binding = { input, pending: 0, calls: 0 }
    // A follow-up the engine opened between turns carries no budget of its own; the task's checkpoint still caps it.
    const budget = input.toolCallBudget ?? taskToolCallBudgetForChat(input.chatId, input.runScope.profileUserId, agent.id)
    const options = {
      conductorAgentId: agent.id,
      getProviders: () => providers(entry!),
      beforeCall: async (context: import('./conductorMcpServer').ConductorMcpCallContext) => {
        await openBetweenTurns(entry!, context.signal)
        context.toolCallId = entry!.correlation.claim(context.name, context.toolCallId, typeof context.meta?.['claudecode/toolUseId'] === 'string')
      },
      executeTool: async (provider: ToolProvider, name: string, args: Record<string, unknown>, opts: import('../llm/toolProvider').ToolCallOptions): Promise<ToolExecutionResult> => {
        const turn = entry!.binding
        if (!turn) throw new Error('This chat has no active turn.')
        // Runner controls (progress, finish) stay callable at the task's cap; the per-turn ceiling still bounds them.
        const counted = budget && !provider.budgetExempt?.(name) ? budget : null
        if (counted ? counted.remaining <= 0 : ++turn.calls > MAX_CALLS) { stop({ budget: true }); return { content: 'The chat reached its tool-call budget. Stop and ask the user to continue.', isError: true } }
        try { counted?.consume() } catch (error) {
          stop({ budget: true })
          return { content: error instanceof Error ? error.message : 'The task reached its tool-call budget.', isError: true, budget: true }
        }
        turn.pending++
        turn.input.flush?.()
        const id = opts.toolCallId!
        const publish = (event: RunEvent): void => turn.input.onEvent?.(event)
        const presentation = provider.describeCall?.(name, args)
        const agentId = presentation?.agentId ?? provider.agentId
        publish({ type: 'tool_use', id, name, input: args, provider: presentation?.displayName ?? provider.displayName,
          providerType: agentId ? 'agent' : provider.providerType, providerAgentId: agentId })
        let result: ToolExecutionResult
        try {
          result = await provider.callTool(name, args, { ...opts, queueWhenBusy: true,
            signal: AbortSignal.any([opts.signal!, turn.input.signal]), onEvent: provider.eventSink?.(id, publish) })
        } catch (error) { result = { content: error instanceof Error ? error.message : String(error), isError: true } }
        try {
          const content = typeof result.content === 'string' ? result.content : JSON.stringify(result.content) ?? ''
          messageRepo.saveToolCall({ chatId: input.chatId, content, toolCallId: id, toolName: name, toolInput: args,
            toolError: !!result.isError, toolProvider: provider.displayName, toolAgentId: agentId, parts: result.parts })
          publish(result.isError ? { type: 'tool_error', id, error: content } : { type: 'tool_result', id, result: result.content })
          if (result.budget) stop({ budget: true })
          else if (provider.providerType === 'coordinator' && result.control) stop({ control: result.control })
          // Stopping cancels the session, and with it every parallel sibling:
          // a durable question waits for them to finish before the turn ends.
          else if (result.needsInput) turn.needsInput = true
          return result
        } finally {
          turn.pending--
          if (turn.needsInput && turn.pending === 0) stop({ needsInput: true })
        }
      }
    }
    const session = await server.ensureSession(key, options)
    if (!entry) {
      entry = { chatId: input.chatId, agent, ownerId, scope: input.runScope, session, binding, wake, waiters: new Set(), correlation: new ConductorToolCorrelation() }
      entries.set(key, entry)
    } else { entry.binding = binding; entry.wake = wake }
    entry.agent = agent
    entry.scope = input.runScope
    for (const waiter of entry.waiters) waiter.resolve()
    plan.session = { ...plan.session, mcpServers: [...plan.session.mcpServers.filter((mcp) => mcp.name !== 'cinna'), session.descriptor] }
    const abort = (): void => session.abortCalls('The conductor stopped')
    input.signal.addEventListener('abort', abort, { once: true })
    // An engine that never re-reads its tools can only meet a new one in a new session.
    const fixedTools = plan.sessionToolsFixed ? (await providers(entry)).flatMap((provider) => provider.getTools().map((tool) => tool.name)).sort() : null
    const hash = createHash('sha256').update(JSON.stringify([session.descriptor, isChatConductor(agent) ? conductorContext(agent) : null, ...(fixedTools ? [fixedTools] : [])])).digest('hex')
    return {
      freshSession: conductorSessionRepo.get(input.chatId, agent.id) !== hash,
      sessionReady: () => conductorSessionRepo.save(input.chatId, agent.id, hash),
      sessionLost: () => conductorSessionRepo.save(input.chatId, agent.id, ''),
      observe: (notification) => entry!.correlation.observe(notification),
      owns: (id) => entry!.correlation.owns(id),
      hasCalls: () => binding.pending > 0,
      close: () => {
        input.signal.removeEventListener('abort', abort)
        // The engine ending/crashing cannot leave a child parked indefinitely.
        if (binding.pending > 0) abort()
        if (entry!.binding === binding) entry!.binding = null
      }
    }
  },
  async refresh(chatId: string): Promise<void> {
    await Promise.all([...entries.values()].filter((entry) => entry.chatId === chatId).map((entry) => entry.session.refreshTools()))
  },
  /** The follow-up a between-turn call was waiting for will not open. */
  abandonWaiters(chatId: string, agentId: string, reason: string): void {
    const entry = entries.get(JSON.stringify([chatId, agentId]))
    if (entry && !entry.binding) for (const waiter of entry.waiters) waiter.reject(new Error(`The conductor could not open a turn for this call: ${reason}.`))
  },
  abortAgent(agentId: string): void {
    for (const entry of entries.values()) if (entry.agent.id === agentId) { entry.session.abortCalls('The conductor process exited'); for (const waiter of entry.waiters) waiter.reject(new Error('The conductor session ended.')) }
  },
  async shutdown(): Promise<void> {
    for (const entry of entries.values()) for (const waiter of entry.waiters) waiter.reject(new Error('The app is closing.'))
    entries.clear()
    await server.dispose()
  }
}

onMcpToolsChanged((providerId) => {
  for (const entry of entries.values()) {
    const ids = [...chatMcpRepo.listProviderIds(entry.chatId), ...chatOnDemandMcpRepo.listProviderIds(entry.chatId)]
    if (ids.includes(providerId)) void entry.session.refreshTools().catch((error) => logger.warn('Could not refresh conductor tools', { error: String(error) }))
  }
})

installChatSessionForgetter((chatId, agentId) => {
  for (const [key, entry] of entries) if (entry.chatId === chatId && (!agentId || agentId === entry.agent.id)) {
    entries.delete(key)
    for (const waiter of entry.waiters) waiter.reject(new Error('The conductor session ended.'))
    void entry.session.dispose()
  }
})
