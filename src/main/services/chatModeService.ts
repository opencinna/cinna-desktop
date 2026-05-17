import { chatModeRepo, ChatModeRow, ChatModeUpsertInput } from '../db/chatModes'
import { getDb } from '../db/client'
import { ChatModeError } from '../errors'
import { createLogger } from '../logger/logger'

const logger = createLogger('chatmode')

export const chatModeService = {
  list(userId: string): ChatModeRow[] {
    return chatModeRepo.list(userId)
  },

  get(userId: string, id: string): ChatModeRow | null {
    return chatModeRepo.getOwned(userId, id) ?? null
  },

  /**
   * Create or update a chat mode. Enforces the single-default-per-user
   * invariant in one transaction: marking a mode as default clears the flag
   * on every other mode owned by the same user first.
   */
  upsert(userId: string, input: ChatModeUpsertInput): { id: string } {
    return getDb().transaction((tx) => {
      if (input.isDefault) {
        chatModeRepo.clearDefaults(userId, tx)
      }

      if (input.id) {
        const updated = chatModeRepo.update(userId, input.id, input, tx)
        if (!updated) throw new ChatModeError('not_found', 'Chat mode not found')
        logger.info('chat mode updated', { modeId: input.id })
        return { id: input.id }
      }

      const { id } = chatModeRepo.insert(userId, input, tx)
      logger.info('chat mode created', { modeId: id })
      return { id }
    })
  },

  delete(userId: string, id: string): void {
    const removed = chatModeRepo.delete(userId, id)
    if (removed) logger.info('chat mode deleted', { modeId: id })
  }
}
