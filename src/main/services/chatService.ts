import { nanoid } from 'nanoid'
import { chatRepo, ChatRow, ChatUpdateInput, MessageRow } from '../db/chats'
import { chatMcpRepo } from '../db/chatMcp'
import { messageRepo } from '../db/messages'
import { ChatError } from '../errors'
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

  update(userId: string, chatId: string, updates: ChatUpdateInput): void {
    const ok = chatRepo.update(userId, chatId, updates)
    if (!ok) throw new ChatError('not_found', 'Chat not found')
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

  setMcpProviders(userId: string, chatId: string, mcpProviderIds: string[]): void {
    requireOwnedChat(userId, chatId)
    chatMcpRepo.replaceForChat(chatId, mcpProviderIds)
  },

  getMcpProviders(userId: string, chatId: string): Array<{ chatId: string; mcpProviderId: string }> {
    requireOwnedChat(userId, chatId)
    return chatMcpRepo.list(chatId)
  }
}
