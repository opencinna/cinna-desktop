import { chatRepo } from '../db/chats'
import { chatOnDemandAgentRepo } from '../db/chatOnDemandAgent'
import { routingOf } from '../../shared/chatRouting'

/**
 * May this agent still speak in this chat, for this profile?
 *
 * One rule, in one place, because two services need exactly the same answer and
 * for the same reason. `followUpTurnService` asks it before opening a turn an
 * engine requested; `handoverService` asks it of a brief's `origin.chat`, which
 * is a string a *file on disk* supplied and must never be trusted — anything
 * that can write to a project folder can write a chat id into it (§3.5).
 *
 * Deliberately a sentence or null, not a boolean: the caller logs it, and the
 * three refusals are genuinely different — a chat that was deleted, one in the
 * trash, and one that has since been re-pointed at somebody else.
 *
 * `human` routing is the one case where a chat answers to more than its bound
 * agent: the user addresses each message, and an agent attached on demand is as
 * much a participant as the root one.
 */
export function chatAnswersToAgent(
  profileUserId: string,
  chatId: string,
  agentId: string
): string | null {
  const chat = chatRepo.getOwned(profileUserId, chatId)
  if (!chat) return 'the chat is gone'
  if (chat.deletedAt) return 'the chat is in the trash'
  const routing = routingOf(chat)
  if (routing.rootAgentId === agentId) return null
  if (routing.router === 'human' && chatOnDemandAgentRepo.listAgentIds(chatId).includes(agentId)) {
    return null
  }
  return 'the chat no longer answers to this agent'
}
