import { chatModeService } from './chatModeService'
import { taskRunnerBridge } from './taskRunnerBridge'
import { nanoid } from 'nanoid'
import { chatRepo, ChatRow, ChatMetaUpdate, MessageRow } from '../db/chats'
import { chatMcpRepo } from '../db/chatMcp'
import { chatOnDemandMcpRepo } from '../db/chatOnDemandMcp'
import { chatOnDemandAgentRepo } from '../db/chatOnDemandAgent'
import { mcpProviderRepo } from '../db/mcpProviders'
import { llmProviderRepo } from '../db/llmProviders'
import { messageRepo } from '../db/messages'
import { agentService } from './agentService'
import { chatConductorService, canConduct, isChatConductor } from './chatConductorService'
import { getSettingsScopeUserId } from '../auth/scope'
import { chatOwnerFor, chatScopesFor, localDataInAllProfiles, visibleChat } from '../auth/chatScope'
import { agentRepo } from '../db/agents'
import { DEFAULT_USER_ID } from '../../shared/userIds'
import { ChatError, McpError, AgentError } from '../errors'
import { routerOf, type ChatRouter } from '../../shared/chatRouting'
import { createLogger } from '../logger/logger'
import { taskRunnersByChat } from './taskRunnerState'
import { activeChatRunId as activeRunId, chatHardDeleted } from './chatRemoval'
import { sessionActivityHub } from './sessionActivityHub'
import { forgetChatSessions, releaseChatSessions } from './chatSessionRelease'
import { chatRunResultRepo } from '../db/chatRunResults'
import type { ChatRunResult } from '../../shared/chatRunResult'
import type { ChatListSummary } from '../../shared/chatListSummary'
import { buildChatListSummaries } from './chatListSummary'

const logger = createLogger('chat')

export interface AddMessageInput {
  role: string
  content: string
  toolCallId?: string
  toolName?: string
  toolInput?: Record<string, unknown>
}

/**
 * Every method takes the **active profile** as `userId` and resolves the chat's
 * owner itself (`auth/chatScope.ts`): a profile can use a chat the default
 * profile owns. Writes to the chat row go to `chat.userId`, the owner; agent
 * lookups keep the profile.
 */
function requireOwnedChat(userId: string, chatId: string): ChatRow {
  const chat = visibleChat(userId, chatId)
  if (!chat) throw new ChatError('not_found', 'Chat not found')
  return chat
}

/** The owners argument for a list read: a lone owner stays a string. */
function listOwners(userId: string): string | string[] {
  const scopes = chatScopesFor(userId)
  return scopes.length === 1 ? scopes[0] : scopes
}

/**
 * Who should own a new chat, from the runtime it is being bound to. Anything
 * of the account — a `remote:` agent, a profile-scoped or development agent,
 * an agent that does not resolve, a profile-managed chat mode or credential —
 * keeps it in the profile; local agents, local chat modes and local
 * credentials, or no binding at all, make it the computer's (the default
 * profile's), listed in every profile. The chat's own conductor runtime is not
 * a choice the user made and is skipped — but what it will run on is: a chat
 * the model answers, with no mode or credential of its own, runs on the
 * effective default mode, and an account default keeps it in the profile.
 */
function ownerForBinding(profileUserId: string, chatId: string, next: Pick<ChatRow, 'agentId' | 'modeId' | 'providerId' | 'router'>): string {
  const agentIds = [next.agentId, ...chatOnDemandAgentRepo.listAgentIds(chatId)].filter((id): id is string => !!id)
  let rootIsAgent = false
  for (const agentId of agentIds) {
    if (agentId.startsWith('remote:')) return profileUserId
    const located = agentService.findAgent(getSettingsScopeUserId(), profileUserId, agentId)
    if (!located) return profileUserId
    if (isChatConductor(located.row)) continue
    // Only machine-local agents (hand-added A2A and folder agents) resolve in
    // the default scope; a development agent is still the profile's.
    if (located.userId !== DEFAULT_USER_ID || located.row.driverConfig?.developmentProfileId) return profileUserId
    if (agentId === next.agentId) rootIsAgent = true
  }
  if (next.modeId) {
    const mode = chatModeService.findMerged(next.modeId)
    if (!mode || mode.managed || mode.userId !== DEFAULT_USER_ID) return profileUserId
  }
  if (next.providerId) {
    const provider = llmProviderRepo.getOwned(DEFAULT_USER_ID, next.providerId)
    if (!provider || provider.managed) return profileUserId
  }
  // A `human` chat, or a `direct` one rooted on a local agent, never runs a
  // conductor; every other chat does, on the effective default when it names
  // neither a mode nor a credential.
  const conducted = next.router === 'coordinator' || (next.router !== 'human' && !rootIsAgent)
  if (conducted && !next.modeId && !next.providerId) {
    const mode = chatModeService.resolveEffectiveDefault()
    if (mode && (mode.managed || mode.userId !== DEFAULT_USER_ID)) return profileUserId
  }
  return DEFAULT_USER_ID
}

/**
 * Decide a new chat's owner at its runtime binding, before any conductor is
 * made for it (a conductor row lives under the chat owner's id). Only while
 * the chat is empty — once something was said or attached its owner never
 * changes — only with `showLocalDataInAllProfiles` on, and never in the
 * default profile, which owns everything it makes anyway.
 */
function settleNewChatOwner(profileUserId: string, chat: ChatRow, next: Pick<ChatRow, 'agentId' | 'modeId' | 'providerId' | 'router'>): ChatRow {
  if (profileUserId === DEFAULT_USER_ID || chatRepo.hasContent(chat.id) || !localDataInAllProfiles()) return chat
  const owner = ownerForBinding(profileUserId, chat.id, next)
  if (owner === chat.userId) return chat
  const conductors = agentRepo.list(chat.userId)
    .filter((agent) => agent.driverConfig?.conductorChatId === chat.id).map((agent) => agent.id)
  if (!chatRepo.reassignOwner(chat.id, chat.userId, owner, conductors)) throw new ChatError('not_found', 'Chat not found')
  logger.info('new chat owner settled', { chatId: chat.id, shared: owner === DEFAULT_USER_ID })
  return { ...chat, userId: owner }
}

export const chatService = {
  list(userId: string): (ChatRow & { activeRunId: string | null; lastRunResult: ChatRunResult | null })[] {
    const owners = listOwners(userId)
    const results = chatRunResultRepo.list(owners)
    return chatRepo.list(owners).map((chat) => ({ ...chat, activeRunId: activeRunId(chat.id), lastRunResult: results.get(chat.id) ?? null }))
  },

  /**
   * The sidebar tooltips' data, keyed by chat id. Deliberately not part of
   * `list`: that is polled every second, and this scans the messages table.
   */
  listSummaries(userId: string): Record<string, ChatListSummary> {
    const owners = listOwners(userId)
    return Object.fromEntries(buildChatListSummaries(getSettingsScopeUserId(), userId, chatRepo.list(owners), owners))
  },

  markResultRead(userId: string, chatId: string, runId: string): void {
    requireOwnedChat(userId, chatId)
    chatRunResultRepo.markRead(chatId, runId)
  },

  get(userId: string, chatId: string): (ChatRow & { messages: MessageRow[]; activeRunId: string | null; lastRunResult: ChatRunResult | null }) | null {
    const chat = visibleChat(userId, chatId)
    if (!chat) return null
    const messages = chatRepo.listMessages(chatId)
    return { ...chat, messages, activeRunId: activeRunId(chatId), lastRunResult: chatRunResultRepo.get(chat.userId, chatId) }
  },

  create(userId: string): ChatRow {
    const chat = chatRepo.create(userId)
    logger.info('chat created', { chatId: chat.id })
    return chat
  },

  delete(userId: string, chatId: string): void {
    const { userId: owner } = requireOwnedChat(userId, chatId)
    if (activeRunId(chatId)) throw new ChatError('run_active', 'Interrupt the session before deleting it.')
    const ok = chatRepo.softDelete(owner, chatId)
    if (!ok) throw new ChatError('not_found', 'Chat not found')
    taskRunnerBridge.chatRemoved(userId, chatId)
    // Activity is held per chat in memory; a trashed chat shows none, and
    // nothing its agents say between turns lands in it.
    forgetChatSessions(chatId)
    sessionActivityHub.clear(chatId)
    logger.info('chat moved to trash', { chatId })
  },

  listTrash(userId: string): ChatRow[] {
    return chatRepo.listTrash(listOwners(userId))
  },

  restore(userId: string, chatId: string): void {
    const ok = chatRepo.restore(chatOwnerFor(userId, chatId), chatId)
    if (!ok) throw new ChatError('not_found', 'Chat not found')
    logger.info('chat restored', { chatId })
  },

  permanentDelete(userId: string, chatId: string): void {
    const owner = chatOwnerFor(userId, chatId)
    const ok = chatRepo.permanentDelete(owner, chatId)
    if (!ok) throw new ChatError('not_found', 'Chat not found')
    chatHardDeleted(userId, chatId, owner)
    logger.info('chat permanently deleted', { chatId })
  },

  emptyTrash(userId: string): void {
    const owners = listOwners(userId)
    const chats = chatRepo.listTrash(owners)
    const removed = chatRepo.emptyTrash(owners)
    for (const chat of chats) chatConductorService.remove(chat.userId, chat.id)
    logger.info('trash emptied', { removed })
  },

  update(userId: string, chatId: string, updates: ChatMetaUpdate): void {
    let chat = requireOwnedChat(userId, chatId)
    if (taskRunnersByChat.has(chatId) && Object.keys(updates).some((key) => key !== 'title')) {
      throw new ChatError('not_configured', 'Stop the autonomous task before changing its model or routing.')
    }
    if (chat.router === 'coordinator' && updates.router && updates.router !== 'coordinator') throw new ChatError('not_configured', 'AI routing cannot be turned off for this chat.')
    const changesRuntime = updates.modeId !== undefined || updates.providerId !== undefined || updates.modelId !== undefined || updates.agentId !== undefined || updates.router !== undefined
    if (changesRuntime && activeRunId(chatId)) throw new ChatError('run_active', 'Interrupt the session before changing its runtime.')
    if (updates.modeId) {
      const mode = chatModeService.findMerged(updates.modeId)
      if (mode) updates = { ...updates, providerId: mode.providerId, modelId: mode.modelId }
    }
    const binds = updates.agentId !== undefined || updates.modeId !== undefined || updates.router !== undefined
    if (binds) chat = settleNewChatOwner(userId, chat, { ...chat, ...updates })
    // The chat's owner: its conductor runtime is made and looked up under it.
    const owner = chat.userId
    const next = { ...chat, ...updates }
    const bound = next.agentId ? agentService.findAgent(getSettingsScopeUserId(), userId, next.agentId) : null
    if (bound && isChatConductor(bound.row) && bound.row.driverConfig?.conductorChatId !== chatId) throw new ChatError('not_configured', 'This runtime belongs to another chat.')
    if (bound && isChatConductor(bound.row) && (updates.modeId !== undefined || updates.providerId !== undefined || updates.modelId !== undefined)) {
      chatConductorService.ensure(owner, next, true)
      releaseChatSessions(chatId, bound.row.id)
    }
    if (next.router === 'coordinator') {
      const located = next.agentId ? agentService.findAgent(getSettingsScopeUserId(), userId, next.agentId) : null
      if (!located || !canConduct(located.row)) {
        if (next.agentId) chatOnDemandAgentRepo.add(chatId, next.agentId)
        updates = { ...updates, agentId: chatConductorService.ensure(owner, { ...next, agentId: null }).id }
      }
    } else if (next.router === 'direct' && !next.agentId) {
      updates = { ...updates, agentId: chatConductorService.ensure(owner, next).id }
    }
    const ok = chatRepo.updateMeta(owner, chatId, updates)
    if (!ok) throw new ChatError('not_found', 'Chat not found')
    // Who answers here changed: the old sessions are no longer this chat's.
    if (updates.router !== undefined && updates.router !== routerOf(chat) && updates.agentId !== chat.agentId && !(updates.agentId === undefined && next.agentId === chat.agentId)) releaseChatSessions(chatId)
    else if (updates.agentId !== undefined && chat.agentId && updates.agentId !== chat.agentId) releaseChatSessions(chatId, chat.agentId)
  },

  /**
   * Rename from the sidebar. Trimmed; an empty title is refused. Writes the
   * title only, so the chat keeps its place in a list sorted by recency.
   */
  rename(userId: string, chatId: string, title: unknown): void {
    const { userId: owner } = requireOwnedChat(userId, chatId)
    const trimmed = typeof title === 'string' ? title.trim() : ''
    if (!trimmed) throw new ChatError('invalid_value', 'A chat needs a title.')
    if (!chatRepo.rename(owner, chatId, trimmed)) throw new ChatError('not_found', 'Chat not found')
  },

  /**
   * Pin a chat to the top of the sidebar's Pinned block, or take it out.
   * Returns the new rank, null once unpinned.
   */
  setPinned(userId: string, chatId: string, pinned: boolean): number | null {
    const { userId: owner } = requireOwnedChat(userId, chatId)
    if (!pinned) {
      if (!chatRepo.unpin(owner, chatId)) throw new ChatError('not_found', 'Chat not found')
      return null
    }
    // Ranked among every chat of the merged list, so a shared chat and one of
    // the profile's never share a place in Pinned.
    const rank = chatRepo.pin(owner, chatId, listOwners(userId))
    if (rank === null) throw new ChatError('not_found', 'Chat not found')
    return rank
  },

  /**
   * A drop in the sidebar: the rank the renderer computed from the chat's new
   * neighbours. `pinned` places it inside Pinned, and refuses a chat that is
   * not pinned; `chats` places it inside its Chats-list group.
   */
  move(userId: string, chatId: string, target: { list: unknown; rank: unknown }): void {
    const chat = requireOwnedChat(userId, chatId)
    const { list, rank } = target ?? {}
    if (typeof rank !== 'number' || !Number.isFinite(rank)) throw new ChatError('invalid_value', 'A chat moves to a finite rank.')
    if (list === 'pinned') {
      if (chat.pinnedRank === null || !chatRepo.setPinnedRank(chat.userId, chatId, rank)) {
        throw new ChatError('invalid_value', 'Only a pinned chat moves inside Pinned.')
      }
      return
    }
    if (list !== 'chats') throw new ChatError('invalid_value', `Unknown chat list: ${String(list)}`)
    if (!chatRepo.setSortKey(chat.userId, chatId, rank)) throw new ChatError('not_found', 'Chat not found')
  },

  /**
   * Promote a hidden (job-spawned) chat into the main Chats list. No-op if
   * the chat is already visible; errors out if the chat doesn't exist.
   */
  showInList(userId: string, chatId: string): void {
    const { userId: owner } = requireOwnedChat(userId, chatId)
    chatRepo.showInList(owner, chatId)
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
    refreshConductor(chatId)
    logger.info('on-demand MCP added', { chatId, mcpProviderId, mcpName: mcp.name })
  },

  removeOnDemandMcp(userId: string, chatId: string, mcpProviderId: string): void {
    requireOwnedChat(userId, chatId)
    chatOnDemandMcpRepo.remove(chatId, mcpProviderId)
    refreshConductor(chatId)
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
    refreshConductor(chatId)
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

    if (current === 'coordinator') throw new ChatError('not_configured', 'AI routing cannot be turned off for this chat.')

    // A plain chat's root is its own hidden runtime, never an agent the user
    // picked: it cannot become a participant they address. It keeps answering
    // and the arriving agent becomes its tool, whatever the caller assumed.
    const root = chat.agentId ? agentService.findAgent(getSettingsScopeUserId(), userId, chat.agentId) : null
    if (router === 'human' && current === 'direct' && root && isChatConductor(root.row)) router = 'coordinator'

    const attached = chatOnDemandAgentRepo.listAgentIds(chatId)
    let bindRoot: string | null = null
    if (router === 'coordinator') {
      const candidateId = chat.agentId ?? attached[0]
      const candidate = candidateId ? agentService.findAgent(getSettingsScopeUserId(), userId, candidateId) : null
      bindRoot = candidate && canConduct(candidate.row) ? candidate.row.id : chatConductorService.ensure(chat.userId, { ...chat, agentId: null }).id
    } else if (router === 'direct') {
      if (attached.length > 1) {
        throw new ChatError(
          'not_configured',
          'A direct chat has one counterparty. Remove the other agents first.'
        )
      }
      bindRoot = attached[0] ?? null
    }

    chatRepo.setRouter(chat.userId, chatId, router, {
      // The root is only ever detached on the way *out* of `direct`; the other
      // routers never have one.
      detachRoot: current === 'direct' ? chat.agentId : null,
      bindRoot,
    })
    // Who answers here changed. The old sessions keep their context in the
    // database, but what they say between turns and what they were running
    // are no longer shown in this chat.
    if (bindRoot !== chat.agentId) releaseChatSessions(chatId)
    refreshConductor(chatId)
    logger.info('chat router changed', {
      chatId,
      from: current,
      to: router,
      hadRootAgent: !!chat.agentId,
      attached: attached.length,
      conductor: bindRoot
    })
  },

  removeOnDemandAgent(userId: string, chatId: string, agentId: string): void {
    requireOwnedChat(userId, chatId)
    chatOnDemandAgentRepo.remove(chatId, agentId)
    refreshConductor(chatId)
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
    refreshConductor(chatId)
  },

  getMcpProviders(userId: string, chatId: string): Array<{ chatId: string; mcpProviderId: string }> {
    requireOwnedChat(userId, chatId)
    return chatMcpRepo.list(chatId)
  }
}

function refreshConductor(chatId: string): void {
  void import('./conductorBridge').then(({ conductorBridge }) => conductorBridge.refresh(chatId)).catch((error) => logger.warn('Could not refresh chat tools', { chatId, error: String(error) }))
}
