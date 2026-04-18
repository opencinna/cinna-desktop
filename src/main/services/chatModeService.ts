import { chatModeRepo, ChatModeRow, ChatModeUpsertInput } from '../db/chatModes'
import { createLogger } from '../logger/logger'

const logger = createLogger('chatmode')

export const chatModeService = {
  list(userId: string): ChatModeRow[] {
    return chatModeRepo.list(userId)
  },

  get(userId: string, id: string): ChatModeRow | null {
    return chatModeRepo.getOwned(userId, id) ?? null
  },

  upsert(userId: string, input: ChatModeUpsertInput): { id: string } {
    const { id, created } = chatModeRepo.upsert(userId, input)
    logger.info(created ? 'chat mode created' : 'chat mode updated', { modeId: id })
    return { id }
  },

  delete(userId: string, id: string): void {
    const removed = chatModeRepo.delete(userId, id)
    if (removed) logger.info('chat mode deleted', { modeId: id })
  }
}
