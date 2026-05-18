import { chatRepo } from '../db/chats'
import { messageRepo } from '../db/messages'
import { multiAgentService } from './multiAgentService'
import { ChatError } from '../errors'
import { createLogger } from '../logger/logger'

const logger = createLogger('routing')

export interface PrepareAgentSendInput {
  userId: string
  chatId: string
  agentId: string
  userContent: string
  rewrittenText?: string | null
  originalText?: string | null
  catchupPacket?: string
}

export interface PrepareLlmSendInput {
  userId: string
  chatId: string
  userContent: string
  catchupPacket?: string
}

export interface PreparedSend {
  /** What goes on the wire to the LLM / agent (catch-up packet prepended). */
  wireContent: string
  /** Id of the user message just persisted to `messages`. */
  userMessageId: string
}

/**
 * Single chokepoint for "the user just sent a routed message" — owns
 * persistence of the user row (with all multi-agent metadata), assembly of
 * the wire content (catch-up prepend), and the (chat, agent) cursor advance.
 *
 * Both streaming IPC handlers (`agent:send-message`, `llm:send-message`) go
 * through here so the side-effects stay consistent regardless of channel.
 */
export const messageRoutingService = {
  prepareAgentSend(input: PrepareAgentSendInput): PreparedSend {
    const {
      userId,
      chatId,
      agentId,
      userContent,
      rewrittenText,
      originalText,
      catchupPacket
    } = input

    if (!chatRepo.getOwned(userId, chatId)) {
      throw new ChatError('not_found', 'Chat not found')
    }

    const wireContent = catchupPacket ? `${catchupPacket}${userContent}` : userContent
    const userMessageId = messageRepo.saveUser({
      chatId,
      content: userContent,
      addressedAgentId: agentId,
      rewrittenText: rewrittenText ?? null,
      originalText: originalText ?? null
    })

    multiAgentService.advanceCatchupCursor({
      userId,
      chatId,
      targetAgentId: agentId,
      lastMessageId: userMessageId
    })

    logger.debug('prepared agent send', {
      chatId,
      agentId,
      userMessageId,
      hasCatchup: !!catchupPacket,
      hasRewrite: !!rewrittenText
    })

    return { wireContent, userMessageId }
  },

  prepareLlmSend(input: PrepareLlmSendInput): PreparedSend {
    const { userId, chatId, userContent, catchupPacket } = input

    if (!chatRepo.getOwned(userId, chatId)) {
      throw new ChatError('not_found', 'Chat not found')
    }

    const wireContent = catchupPacket ? `${catchupPacket}${userContent}` : userContent
    const userMessageId = messageRepo.saveUser({ chatId, content: userContent })

    logger.debug('prepared llm send', {
      chatId,
      userMessageId,
      hasCatchup: !!catchupPacket
    })

    return { wireContent, userMessageId }
  }
}
