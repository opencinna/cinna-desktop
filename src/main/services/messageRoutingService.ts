import { chatRepo } from '../db/chats'
import { messageRepo } from '../db/messages'
import { chatTitleService, ChatTitleError } from './chatTitleService'
import { ChatError } from '../errors'
import { createLogger } from '../logger/logger'
import type { MessageAttachment } from '../../shared/attachments'

const logger = createLogger('routing')

/**
 * Fire-and-forget background chat-title autogeneration. Called from both
 * `prepareLlmSend` and `prepareAgentSend` so any first user message —
 * regardless of which channel it routes to — triggers a title attempt.
 * The title service guards on its own toggle + first-message check, so
 * the call is safe to make after every persist. ALL failure modes are
 * logged here and swallowed; nothing reaches the streaming pipeline.
 *
 * Log-level classification:
 *   - `feature_disabled`, `not_first_message`, `chat_renamed_initial`:
 *     expected pre-condition misses (fire on every non-first send) →
 *     debug, so they don't drown out other signal.
 *   - `chat_renamed_mid_flight`: rare — the user renamed the chat in the
 *     window between our adapter call starting and finishing → info.
 *   - everything else (`no_provider`, `llm_failed`, `empty_output`,
 *     `chat_not_found`): real failures → warn.
 */
function fireTitleGenInBackground(userId: string, chatId: string): void {
  void chatTitleService
    .autoGenerateForFirstMessage({ userId, chatId })
    .catch((err) => {
      if (err instanceof ChatTitleError) {
        const expected =
          err.code === 'feature_disabled' ||
          err.code === 'not_first_message' ||
          err.code === 'chat_renamed_initial'
        if (expected) {
          logger.debug('chat-title autogen skipped', { chatId, code: err.code })
          return
        }
        if (err.code === 'chat_renamed_mid_flight') {
          logger.info('chat-title autogen lost rename race', {
            chatId,
            code: err.code
          })
          return
        }
        logger.warn('chat-title autogen failed', {
          chatId,
          code: err.code,
          message: err.message,
          detail: err.detail
        })
        return
      }
      logger.warn('chat-title autogen failed (unexpected)', {
        chatId,
        error: err instanceof Error ? err.message : String(err)
      })
    })
}

export interface PrepareAgentSendInput {
  userId: string
  chatId: string
  agentId: string
  userContent: string
  attachments?: MessageAttachment[]
}

export interface PrepareLlmSendInput {
  userId: string
  chatId: string
  userContent: string
  attachments?: MessageAttachment[]
}

export interface PreparedSend {
  /** What goes on the wire to the LLM / agent. */
  wireContent: string
  /** Id of the user message just persisted to `messages`. */
  userMessageId: string
}

/**
 * Single chokepoint for "the user just sent a routed message" — owns
 * persistence of the user row and fires background title generation.
 *
 * Both streaming IPC handlers (`agent:send-message`, `llm:send-message`) go
 * through here so the side-effects stay consistent regardless of channel.
 */
export const messageRoutingService = {
  prepareAgentSend(input: PrepareAgentSendInput): PreparedSend {
    const { userId, chatId, agentId, userContent, attachments } = input

    if (!chatRepo.getOwned(userId, chatId)) {
      throw new ChatError('not_found', 'Chat not found')
    }

    const userMessageId = messageRepo.saveUser({
      chatId,
      content: userContent,
      addressedAgentId: agentId,
      attachments: attachments && attachments.length > 0 ? attachments : null
    })

    logger.debug('prepared agent send', {
      chatId,
      agentId,
      userMessageId,
      attachmentCount: attachments?.length ?? 0
    })

    fireTitleGenInBackground(userId, chatId)

    return { wireContent: userContent, userMessageId }
  },

  prepareLlmSend(input: PrepareLlmSendInput): PreparedSend {
    const { userId, chatId, userContent, attachments } = input

    if (!chatRepo.getOwned(userId, chatId)) {
      throw new ChatError('not_found', 'Chat not found')
    }

    const userMessageId = messageRepo.saveUser({
      chatId,
      content: userContent,
      attachments: attachments && attachments.length > 0 ? attachments : null
    })

    logger.debug('prepared llm send', {
      chatId,
      userMessageId,
      attachmentCount: attachments?.length ?? 0
    })

    fireTitleGenInBackground(userId, chatId)

    return { wireContent: userContent, userMessageId }
  }
}
