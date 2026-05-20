import { nanoid } from 'nanoid'
import { chatRepo, ChatRow, ChatMetaUpdate, MessageRow } from '../db/chats'
import { chatMcpRepo } from '../db/chatMcp'
import { chatOnDemandMcpRepo } from '../db/chatOnDemandMcp'
import { mcpProviderRepo } from '../db/mcpProviders'
import { messageRepo } from '../db/messages'
import { getSettingsScopeUserId } from '../auth/scope'
import { ChatError, McpError } from '../errors'
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
