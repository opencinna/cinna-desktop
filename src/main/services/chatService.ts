import { taskRunnerBridge } from './taskRunnerBridge'
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
import { routerOf, type ChatRouter } from '../../shared/chatRouting'
import { createLogger } from '../logger/logger'
import { taskRunnersByChat } from './taskRunnerState'
import { activeRunsByChat } from './runExecutionState'
import { sessionActivityHub } from './sessionActivityHub'
import { forgetChatSessions, releaseChatSessions } from './chatSessionRelease'
import { chatRunResultRepo } from '../db/chatRunResults'
import type { ChatRunResult } from '../../shared/chatRunResult'

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

function activeRunId(chatId: string): string | null {
  const runner = taskRunnersByChat.get(chatId)
  return activeRunsByChat.get(chatId)?.id ?? (runner?.working ? runner.id : null)
}

export const chatService = {
  list(userId: string): (ChatRow & { activeRunId: string | null; lastRunResult: ChatRunResult | null })[] {
    const results = chatRunResultRepo.list(userId)
    return chatRepo.list(userId).map((chat) => ({ ...chat, activeRunId: activeRunId(chat.id), lastRunResult: results.get(chat.id) ?? null }))
  },

  markResultRead(userId: string, chatId: string, runId: string): void {
    requireOwnedChat(userId, chatId)
    chatRunResultRepo.markRead(chatId, runId)
  },

  get(userId: string, chatId: string): (ChatRow & { messages: MessageRow[]; activeRunId: string | null; lastRunResult: ChatRunResult | null }) | null {
    const chat = chatRepo.getOwned(userId, chatId)
    if (!chat) return null
    const messages = chatRepo.listMessages(chatId)
    return { ...chat, messages, activeRunId: activeRunId(chatId), lastRunResult: chatRunResultRepo.get(userId, chatId) }
  },

  create(userId: string): ChatRow {
    const chat = chatRepo.create(userId)
    logger.info('chat created', { chatId: chat.id })
    return chat
  },

  delete(userId: string, chatId: string): void {
    requireOwnedChat(userId, chatId)
    if (activeRunId(chatId)) throw new ChatError('run_active', 'Interrupt the session before deleting it.')
    const ok = chatRepo.softDelete(userId, chatId)
    if (!ok) throw new ChatError('not_found', 'Chat not found')
    taskRunnerBridge.chatRemoved(userId, chatId)
    // Activity is held per chat in memory; a trashed chat shows none, and
    // nothing its agents say between turns lands in it.
    forgetChatSessions(chatId)
    sessionActivityHub.clear(chatId)
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
    taskRunnerBridge.chatRemoved(userId, chatId)
    forgetChatSessions(chatId)
    sessionActivityHub.clear(chatId)
    logger.info('chat permanently deleted', { chatId })
  },

  emptyTrash(userId: string): void {
    const removed = chatRepo.emptyTrash(userId)
    logger.info('trash emptied', { removed })
  },

  update(userId: string, chatId: string, updates: ChatMetaUpdate): void {
    const chat = requireOwnedChat(userId, chatId)
    if (taskRunnersByChat.has(chatId) && Object.keys(updates).some((key) => key !== 'title')) {
      throw new ChatError('not_configured', 'Stop the autonomous task before changing its model or routing.')
    }
    const ok = chatRepo.updateMeta(userId, chatId, updates)
    if (!ok) throw new ChatError('not_found', 'Chat not found')
    // Who answers here changed: the old sessions are no longer this chat's.
    if (updates.router !== undefined && updates.router !== routerOf(chat)) releaseChatSessions(chatId)
    else if (updates.agentId !== undefined && chat.agentId && updates.agentId !== chat.agentId) releaseChatSessions(chatId, chat.agentId)
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
   * Move a chat onto a router — who answers a message here.
   *
   * The three transitions the app makes, and what each costs:
   *
   *  - **`direct` → `human`**, when the user brings a second agent into a chat
   *    that already has one. **No model.** This is the whole point of the
   *    router: two agents in one thread used to force the local model into the
   *    middle of them, and a user with no LLM provider configured could not
   *    have two agents talk to them at all. The former root becomes one of the
   *    attached agents, keeping its session.
   *  - **→ `coordinator`**, when the user asks the model to conduct. This is
   *    the one that still needs a model, so it is the only one that can be
   *    refused (`not_configured`).
   *  - **`coordinator` → `human` / `direct`**, when they turn it off again. A
   *    chat with agents lands on `human`; one with none lands back on `direct`,
   *    where the model answers as it always did.
   *
   * Arriving at `direct` with exactly one attached agent binds that agent as
   * the root, which is what `direct` means. Arriving with more is refused
   * rather than silently dropping the rest.
   */
  setRouter(userId: string, chatId: string, router: ChatRouter): void {
    const chat = requireOwnedChat(userId, chatId)
    const current = routerOf(chat)
    if (current === router) return
    if (taskRunnersByChat.has(chatId)) throw new ChatError('not_configured', 'Stop the autonomous task before changing who coordinates it.')

    let providerId: string | undefined
    let modelId: string | undefined

    // Only the coordinator runs on the local model. An agent-rooted chat
    // carries no model of its own (it talks straight to its agent), so one has
    // to be resolved before the model can conduct.
    if (router === 'coordinator' && !(chat.providerId && chat.modelId)) {
      try {
        const pair = aiFunctions.resolveProviderModelFromChatMode(userId, chatId)
        providerId = pair.providerId
        modelId = pair.modelId
      } catch (err) {
        if (err instanceof AiFunctionError && err.code === 'no_provider') {
          throw new ChatError(
            'not_configured',
            'Add an LLM provider or pick a chat mode to let the model coordinate this chat.'
          )
        }
        throw err
      }
    }

    const attached = chatOnDemandAgentRepo.listAgentIds(chatId)
    let bindRoot: string | null = null
    if (router === 'direct') {
      if (attached.length > 1) {
        throw new ChatError(
          'not_configured',
          'A direct chat has one counterparty. Remove the other agents first.'
        )
      }
      bindRoot = attached[0] ?? null
    }

    chatRepo.setRouter(userId, chatId, router, {
      // The root is only ever detached on the way *out* of `direct`; the other
      // routers never have one.
      detachRoot: current === 'direct' ? chat.agentId : null,
      bindRoot,
      providerId,
      modelId
    })
    // Who answers here changed. The old sessions keep their context in the
    // database, but what they say between turns and what they were running
    // are no longer shown in this chat.
    releaseChatSessions(chatId)
    logger.info('chat router changed', {
      chatId,
      from: current,
      to: router,
      hadRootAgent: !!chat.agentId,
      attached: attached.length,
      resolvedModel: modelId ?? chat.modelId ?? null
    })
  },

  removeOnDemandAgent(userId: string, chatId: string, agentId: string): void {
    requireOwnedChat(userId, chatId)
    chatOnDemandAgentRepo.remove(chatId, agentId)
    releaseChatSessions(chatId, agentId)
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
