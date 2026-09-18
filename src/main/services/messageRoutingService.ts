import { chatRepo } from '../db/chats'
import { messageRepo } from '../db/messages'
import { chatTitleService, ChatTitleError } from './chatTitleService'
import { ChatError } from '../errors'
import { createLogger } from '../logger/logger'
import type { MessageAttachment } from '../../shared/attachments'
import { isDesktopAuthored, type TurnInputOrigin } from '../../shared/turnOrigin'

const logger = createLogger('routing')

/**
 * Fire-and-forget background chat-title autogeneration. Every runtime send
 * triggers an attempt after persisting the first user message.
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
  /** Runs inside the user-message transaction; throwing rolls that message back. */
  onPersisted?: () => void
  /**
   * Who authored the message. Everything the desktop wrote itself — a runner's
   * prompt, a handover's return packet — is recorded as a **system** row, so
   * the transcript never shows a user bubble nobody typed.
   */
  origin?: TurnInputOrigin
}

export interface PreparedSend {
  /** What goes on the wire to the runtime. */
  wireContent: string
  /** Id of the user message just persisted to `messages`. */
  userMessageId: string
}

/**
 * Single chokepoint for "the user just sent a routed message" — owns
 * persistence of the user row and fires background title generation.
 *
 * runExecutionService prepares routed sends here so interactive and autonomous
 * execution share the same persistence and title side effects.
 */
export const messageRoutingService = {
  prepareAgentSend(input: PrepareAgentSendInput): PreparedSend {
    const { userId, chatId, agentId, userContent, attachments } = input

    if (!chatRepo.getOwned(userId, chatId)) {
      throw new ChatError('not_found', 'Chat not found')
    }

    const userMessageId = isDesktopAuthored(input.origin)
      ? messageRepo.saveSystem({ chatId, content: userContent, ...( 'agentId' in input && typeof input.agentId === 'string' ? { addressedAgentId: input.agentId } : {}) }, input.onPersisted)
      : messageRepo.saveUser({
      chatId,
      content: userContent,
      addressedAgentId: agentId,
      attachments: attachments && attachments.length > 0 ? attachments : null
    }, input.onPersisted)

    logger.debug('prepared agent send', {
      chatId,
      agentId,
      userMessageId,
      attachmentCount: attachments?.length ?? 0
    })

    // A chat is titled after what the person said in it. A handover's return
    // packet would title it after another project's report.
    if (!isDesktopAuthored(input.origin)) fireTitleGenInBackground(userId, chatId)

    return { wireContent: userContent, userMessageId }
  }
}
