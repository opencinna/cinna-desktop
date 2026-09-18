import { mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { app } from 'electron'
import { agentRepo, agentSessionRepo, type AgentRow } from '../db/agents'
import { chatRepo, type ChatRow } from '../db/chats'
import { chatModeService } from './chatModeService'
import { defaultEngineService } from './localAgents/defaultEngineService'
import { runtimeService } from './localAgents/runtimeService'
import { providerService } from './providerService'
import { isAgentEngine, type AgentEngine } from '../../shared/engine'
import type { AcpRuntimeView } from '../agents/drivers/acp/acpRuntime'

export function isChatConductor(agent: Pick<AgentRow, 'driverConfig'>): boolean {
  return typeof agent.driverConfig?.conductorChatId === 'string'
}

export function canConduct(agent: Pick<AgentRow, 'driver' | 'driverConfig'>): boolean {
  return agent.driver === 'acp' && agent.driverConfig?.transport !== 'websocket'
}

export interface ConductorContext {
  engine: AgentEngine
  modelId: string | null
  credentialId: string | null
  instructions: string
  path: string
  toolPolicy: 'none' | 'connectors'
}

const PLAIN_PROMPT = 'You are a helpful conversational assistant. Answer the user in this chat. Use the connected tools when useful. You have no access to files, shell commands, or coding tools. When a specialist is waiting for an Inbox answer, stop calling it and tell the user. A later message will identify the tool call its result completes.'

/** Runtime choices are captured per chat; changing the default never changes an existing session. */
export function conductorContext(agent: AgentRow): ConductorContext {
  const config = agent.driverConfig
  if (!isChatConductor(agent) || !isAgentEngine(config?.conductorEngine) || typeof config?.cwd !== 'string') {
    throw new Error('This chat runtime is no longer available.')
  }
  return {
    engine: config.conductorEngine,
    modelId: typeof config.conductorModel === 'string' ? config.conductorModel : null,
    credentialId: typeof config.conductorCredential === 'string' ? config.conductorCredential : null,
    instructions: typeof config.conductorPrompt === 'string' ? config.conductorPrompt : PLAIN_PROMPT,
    path: config.cwd,
    toolPolicy: config.conductorToolPolicy === 'none' ? 'none' : 'connectors'
  }
}

export const chatConductorService = {
  remove(userId: string, chatId: string): void {
    // Only generated rows own these folders. User-added local agents are never
    // removed as a side effect of deleting a conversation.
    for (const agent of agentRepo.list(userId)) if (agent.driverConfig?.conductorChatId === chatId) {
      rmSync(join(app.getPath('userData'), 'chat-conductors', chatId), { recursive: true, force: true })
      agentRepo.delete(userId, agent.id)
    }
  },
  ensure(userId: string, chat: ChatRow, refresh = false): AgentRow {
    if (!refresh && chat.agentId) {
      const existing = agentRepo.getOwned(userId, chat.agentId)
      if (existing && isChatConductor(existing) && existing.driverConfig?.conductorChatId === chat.id) return existing
    }
    const existing = agentRepo.list(userId).find((agent) => agent.driverConfig?.conductorChatId === chat.id)
    if (existing && !refresh) return existing
    const mode = chat.modeId ? chatModeService.findMerged(chat.modeId) : chatModeService.resolveEffectiveDefault()
    const engine = isAgentEngine(mode?.engine) ? mode.engine : defaultEngineService.current()
    const providerId = chat.providerId ?? mode?.providerId
    const modelId = chat.modelId ?? mode?.modelId
    const runtime = runtimeService.resolve({ engine, ...(engine === 'opencode' && providerId ? { credential: providerId } : {}), ...(modelId ? { model: modelId } : {}) }, providerService.listMerged())
    const path = join(app.getPath('userData'), 'chat-conductors', chat.id)
    const instructions = mode?.systemPrompt?.trim() || PLAIN_PROMPT
    mkdirSync(path, { recursive: true, mode: 0o700 })
    for (const name of ['AGENTS.md', 'CLAUDE.md']) writeFileSync(join(path, name), `${instructions}\n`, { mode: 0o600 })
    const input = {
      name: engine === 'claude' ? 'Claude' : engine === 'codex' ? 'Codex' : 'OpenCode',
      description: 'Chat runtime', driver: 'acp' as const,
      config: { launcher: engine, cwd: path, conductorChatId: chat.id, conductorEngine: engine,
        conductorModel: runtime.modelId, conductorCredential: runtime.credentialId,
        conductorPrompt: instructions, conductorToolPolicy: mode?.toolPolicy ?? 'connectors' }
    }
    return existing ? agentRepo.updateRuntime(userId, existing.id, 'acp', input) : agentRepo.createRuntime(userId, input)
  },

  bind(userId: string, chat: ChatRow): ChatRow {
    const agent = this.ensure(userId, chat)
    chatRepo.updateMeta(userId, chat.id, { agentId: agent.id })
    return { ...chat, agentId: agent.id }
  },

  runtime(userId: string, agent: AgentRow): AcpRuntimeView {
    const context = conductorContext(agent)
    const validate = (chatId?: string): void => {
      const owner = chatRepo.getOwned(userId, String(agent.driverConfig?.conductorChatId))
      if (!owner || owner.deletedAt || (chatId && owner.id !== chatId)) throw new Error('This chat runtime is no longer available.')
    }
    validate()
    return {
      type: 'folder',
      folder: { name: agent.name, slug: `chat-${agent.id}`, description: 'Chat runtime', path: context.path,
        kind: 'bare', runtimeMode: 'isolated', enabled: agent.enabled, readiness: 'ok', readinessReason: null,
        runtime: { engine: context.engine } },
      validate,
      readSession: (chatId) => agentSessionRepo.getByChatAndAgent(chatId, agent.id)?.contextId ?? null,
      saveSession: (chatId, sessionId) => { agentSessionRepo.upsert({ chatId, agentId: agent.id, contextId: sessionId, taskId: null, taskState: null }) },
      isGranted: () => false,
      rememberGrant: () => false
    }
  }
}
