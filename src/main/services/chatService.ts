import { nanoid } from 'nanoid'
import { chatRepo, ChatRow, ChatMetaUpdate, MessageRow } from '../db/chats'
import { chatMcpRepo } from '../db/chatMcp'
import { chatOnDemandMcpRepo } from '../db/chatOnDemandMcp'
import { chatOnDemandAgentRepo } from '../db/chatOnDemandAgent'
import { mcpProviderRepo } from '../db/mcpProviders'
import { messageRepo } from '../db/messages'
import { agentService } from './agentService'
import { aiFunctions, AiFunctionError } from './aiFunctionsService'
import { getSettingsScopeUserId } from '../auth/scope'
import { ChatError, McpError, AgentError } from '../errors'
import { createLogger } from '../logger/logger'

const logger = createLogger('chat')

export interface AddMessageInput {
  role: string
  content: string
  toolCallId?: string
  toolName?: string
  toolInput?: Record<string, unknown>
}

function requireOwnedChat(userId: string, chatId: string): ChatRow {
  const chat = chatRepo.getOwned(userId, chatId)
  if (!chat) throw new ChatError('not_found', 'Chat not found')
  return chat
}

export const chatService = {
  list(userId: string): ChatRow[] {
    return chatRepo.list(userId)
  },

  get(userId: string, chatId: string): (ChatRow & { messages: MessageRow[] }) | null {
    const chat = chatRepo.getOwned(userId, chatId)
    if (!chat) return null
    const messages = chatRepo.listMessages(chatId)
    return { ...chat, messages }
  },

  create(userId: string): ChatRow {
    const chat = chatRepo.create(userId)
    logger.info('chat created', { chatId: chat.id })
    return chat
  },

  delete(userId: string, chatId: string): void {
    const ok = chatRepo.softDelete(userId, chatId)
    if (!ok) throw new ChatError('not_found', 'Chat not found')
    logger.info('chat moved to trash', { chatId })
  },

  listTrash(userId: string): ChatRow[] {
    return chatRepo.listTrash(userId)
  },

  restore(userId: string, chatId: string): void {
    const ok = chatRepo.restore(userId, chatId)
    if (!ok) throw new ChatError('not_found', 'Chat not found')
    logger.info('chat restored', { chatId })
  },

  permanentDelete(userId: string, chatId: string): void {
    const ok = chatRepo.permanentDelete(userId, chatId)
    if (!ok) throw new ChatError('not_found', 'Chat not found')
    logger.info('chat permanently deleted', { chatId })
  },

  emptyTrash(userId: string): void {
    const removed = chatRepo.emptyTrash(userId)
    logger.info('trash emptied', { removed })
  },

  update(userId: string, chatId: string, updates: ChatMetaUpdate): void {
    const ok = chatRepo.updateMeta(userId, chatId, updates)
    if (!ok) throw new ChatError('not_found', 'Chat not found')
  },

  /**
   * Promote a hidden (job-spawned) chat into the main Chats list. No-op if
   * the chat is already visible; errors out if the chat doesn't exist.
   */
  showInList(userId: string, chatId: string): void {
    requireOwnedChat(userId, chatId)
    chatRepo.showInList(userId, chatId)
    logger.info('chat promoted to main list', { chatId })
  },

  addMessage(userId: string, chatId: string, input: AddMessageInput): MessageRow {
    requireOwnedChat(userId, chatId)
    const id = nanoid()
    messageRepo.insertRaw({
      id,
      chatId,
      role: input.role,
      content: input.content,
      toolCallId: input.toolCallId ?? null,
      toolName: input.toolName ?? null,
      toolInput: input.toolInput ?? null
    })
    messageRepo.touchChat(chatId)
    const inserted = messageRepo.getById(id)
    if (!inserted) throw new ChatError('not_found', 'Message not found after insert')
    return inserted
  },

  /**
   * On-demand MCP attachments for a chat: user-engaged MCPs from the in-chat
   * `@-mention` flow. Separate from `chat_mcp_providers` (which reflects the
   * chat mode's baseline set) so removals don't fight the chat mode.
   */
  listOnDemandMcps(userId: string, chatId: string): Array<{ mcpProviderId: string; pendingAnnounce: boolean }> {
    requireOwnedChat(userId, chatId)
    return chatOnDemandMcpRepo
      .list(chatId)
      .map((r) => ({ mcpProviderId: r.mcpProviderId, pendingAnnounce: r.pendingAnnounce }))
  },

  addOnDemandMcp(userId: string, chatId: string, mcpProviderId: string): void {
    requireOwnedChat(userId, chatId)
    const mcp = mcpProviderRepo.getOwned(getSettingsScopeUserId(), mcpProviderId)
    if (!mcp) throw new McpError('not_found', 'MCP provider not found')
    chatOnDemandMcpRepo.add(chatId, mcpProviderId)
    logger.info('on-demand MCP added', { chatId, mcpProviderId, mcpName: mcp.name })
  },

  removeOnDemandMcp(userId: string, chatId: string, mcpProviderId: string): void {
    requireOwnedChat(userId, chatId)
    chatOnDemandMcpRepo.remove(chatId, mcpProviderId)
    logger.info('on-demand MCP removed', { chatId, mcpProviderId })
  },

  /**
   * On-demand agent attachments for a chat: user-engaged agents from the
   * in-chat `@-mention` flow. The orchestrator (local LLM) exposes each as an
   * emulated MCP tool. Mirrors the on-demand MCP methods above.
   */
  listOnDemandAgents(
    userId: string,
    chatId: string
  ): Array<{ agentId: string; pendingAnnounce: boolean }> {
    requireOwnedChat(userId, chatId)
    return chatOnDemandAgentRepo
      .list(chatId)
      .map((r) => ({ agentId: r.agentId, pendingAnnounce: r.pendingAnnounce }))
  },

  addOnDemandAgent(userId: string, chatId: string, agentId: string): void {
    requireOwnedChat(userId, chatId)
    // Agents live in two scopes: local in default (settings) scope, remote in
    // the active profile. `findAgent` resolves across both.
    const located = agentService.findAgent(getSettingsScopeUserId(), userId, agentId)
    if (!located) throw new AgentError('not_found', 'Agent not found')
    chatOnDemandAgentRepo.add(chatId, agentId)
    logger.info('on-demand agent added', { chatId, agentId, agentName: located.row.name })
  },

  /**
   * Promote a chat to orchestrated mode (local model conducts agents-as-tools).
   * Triggered the moment a chat crosses from one counterparty to two — e.g. the
   * user `@`-mentions a second agent into a direct-A2A chat.
   *
   *  - Already orchestrated → no-op.
   *  - Agent-rooted (direct A2A) → resolve a model (refuse with `not_configured`
   *    when none is available), move the bound agent into `chat_on_demand_agents`
   *    so the orchestrator can still call it as a tool (its `a2a_sessions` row is
   *    preserved, so its prior context survives), and detach it as the root.
   *  - Plain LLM chat → just flip the flag (it already has a model).
   */
  promoteToOrchestrated(userId: string, chatId: string): void {
    const chat = requireOwnedChat(userId, chatId)
    if (chat.orchestrated) return

    let providerId: string | undefined
    let modelId: string | undefined

    // Agent-rooted chats carry no model (they talk direct A2A); resolve one
    // before the orchestrator can conduct. Plain LLM chats already have a model.
    if (chat.agentId && !(chat.providerId && chat.modelId)) {
      try {
        const pair = aiFunctions.resolveProviderModelFromChatMode(userId, chatId)
        providerId = pair.providerId
        modelId = pair.modelId
      } catch (err) {
        if (err instanceof AiFunctionError && err.code === 'no_provider') {
          throw new ChatError(
            'not_configured',
            'Add an LLM provider or pick a chat mode to bring more than one agent into a chat.'
          )
        }
        throw err
      }
    }

    // The on-demand-agent re-exposure + flag flip happen atomically in the repo.
    chatRepo.promoteToOrchestrated(userId, chatId, {
      rootAgentId: chat.agentId,
      providerId,
      modelId
    })
    logger.info('chat promoted to orchestrated', {
      chatId,
      hadRootAgent: !!chat.agentId,
      resolvedModel: modelId ?? chat.modelId ?? null
    })
  },

  removeOnDemandAgent(userId: string, chatId: string, agentId: string): void {
    requireOwnedChat(userId, chatId)
    chatOnDemandAgentRepo.remove(chatId, agentId)
    logger.info('on-demand agent removed', { chatId, agentId })
  },

  setMcpProviders(userId: string, chatId: string, mcpProviderIds: string[]): void {
    requireOwnedChat(userId, chatId)
    // MCP providers live in settings scope; chats live in profile scope. The
    // renderer can pass stale IDs (e.g. a chat mode's JSON `mcpProviderIds`
    // array still referencing a provider that was deleted before a cascade
    // could clean it) — drop those before they hit the FK in
    // `chat_mcp_providers` and crash the chat creation flow.
    const validIds = new Set(
      mcpProviderRepo.list(getSettingsScopeUserId()).map((p) => p.id)
    )
    const filtered = mcpProviderIds.filter((id) => validIds.has(id))
    if (filtered.length !== mcpProviderIds.length) {
      const dropped = mcpProviderIds.filter((id) => !validIds.has(id))
      logger.warn('setMcpProviders:dropped-stale-ids', { chatId, dropped })
    }
    chatMcpRepo.replaceForChat(chatId, filtered)
  },

  getMcpProviders(userId: string, chatId: string): Array<{ chatId: string; mcpProviderId: string }> {
    requireOwnedChat(userId, chatId)
    return chatMcpRepo.list(chatId)
  }
}
