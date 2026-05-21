import { chatRepo } from '../db/chats'
import { messageRepo } from '../db/messages'
import { appSettingsRepo } from '../db/appSettings'
import { aiFunctions, AiFunctionError } from './aiFunctionsService'
import { getMainWindow } from '../index'
import { DomainError } from '../errors'
import { createLogger } from '../logger/logger'
import { CHAT_TITLE_UPDATED_CHANNEL } from '../../shared/appSettings'
import { deriveTitleFromMessage } from '../../shared/chatTitle'

const logger = createLogger('chat-title')

const MAX_TITLE_CHARS = 40
const DEFAULT_CHAT_TITLE = 'New Chat'

/**
 * The renderer's new-chat flow stamps the chat title with a truncated copy
 * of the first user message (see {@link deriveTitleFromMessage}). That's a
 * fallback title, not a user edit — for the "is this chat still using an
 * auto-generated title?" decision we treat both the initial `'New Chat'`
 * and the renderer's truncation as untouched, anything else as a real edit.
 */
function isUntouchedAutoTitle(currentTitle: string, firstUserText: string): boolean {
  return (
    currentTitle === DEFAULT_CHAT_TITLE ||
    currentTitle === deriveTitleFromMessage(firstUserText)
  )
}

export type ChatTitleErrorCode =
  | 'feature_disabled'
  | 'not_first_message'
  | 'chat_not_found'
  /**
   * Up-front check before the LLM call: the chat already has a user-set
   * title. Fires on every non-first send too — expected, noisy, log at
   * debug at the call site.
   */
  | 'chat_renamed_initial'
  /**
   * Post-LLM re-check: the user (or another feature) renamed the chat in
   * the gap between our adapter call starting and finishing. Rare and
   * interesting — log at info at the call site so we can see when our
   * generation lost a race against a manual rename.
   */
  | 'chat_renamed_mid_flight'
  | 'no_provider'
  | 'llm_failed'
  | 'empty_output'

export class ChatTitleError extends DomainError<ChatTitleErrorCode> {}

function mapAiFunctionError(err: AiFunctionError): ChatTitleError {
  if (err.code === 'no_provider') {
    return new ChatTitleError('no_provider', err.message, err.detail)
  }
  if (err.code === 'empty_output') {
    return new ChatTitleError('empty_output', err.message, err.detail)
  }
  return new ChatTitleError('llm_failed', err.message, err.detail)
}

/**
 * Normalize the model's output into a safe title:
 *   - strip surrounding quotes / backticks the model may add
 *   - collapse any whitespace (newlines/tabs) into single spaces
 *   - strip trailing punctuation
 *   - hard-cap at MAX_TITLE_CHARS (runSingleShot already caps but defend
 *     against off-by-one or future changes there)
 */
function sanitizeTitle(raw: string): string {
  const collapsed = raw.replace(/\s+/g, ' ').trim()
  const unquoted = collapsed.replace(/^["'`“”‘’]+|["'`“”‘’]+$/g, '').trim()
  const trimmedPunct = unquoted.replace(/[.,;:!?\-–—]+$/g, '').trim()
  if (trimmedPunct.length <= MAX_TITLE_CHARS) return trimmedPunct
  return trimmedPunct.slice(0, MAX_TITLE_CHARS).trim()
}

function broadcastTitleUpdate(chatId: string, title: string): void {
  const win = getMainWindow()
  if (win && !win.isDestroyed()) {
    win.webContents.send(CHAT_TITLE_UPDATED_CHANNEL, { chatId, title })
  }
}

const TITLE_SYSTEM_PROMPT = [
  'You generate concise chat titles.',
  '',
  'Given the user\'s first message in a new conversation, output a short',
  `title (max ${MAX_TITLE_CHARS} characters) summarizing the topic.`,
  '',
  'Rules:',
  '- Output ONLY the title text. No quotes, no preamble, no explanation.',
  '- No trailing punctuation.',
  '- Plain text, no markdown.',
  '- Prefer nouns / noun phrases over full sentences.',
  '- Match the language of the user\'s message.'
].join('\n')

export const chatTitleService = {
  /**
   * Fire-and-forget background title generation for a chat's first user
   * message. All failure modes are logged and swallowed by the caller — this
   * method throws {@link ChatTitleError} so logging at the call site has a
   * structured code to record, but the streaming flow MUST NOT propagate it.
   *
   * Pre-conditions checked here (so the caller stays a one-liner):
   *   - `autoChatTitles` feature toggle is enabled
   *   - the chat exists and still has an auto-generated title — either the
   *     initial `'New Chat'` or the renderer's truncated-first-message
   *     fallback (see {@link isUntouchedAutoTitle}). A real user-edited
   *     title is never overwritten.
   *   - this is genuinely the first user message in the chat (defends
   *     against the rare race where the caller fires for a later message)
   */
  async autoGenerateForFirstMessage(input: {
    userId: string
    chatId: string
  }): Promise<void> {
    const { userId, chatId } = input

    if (!appSettingsRepo.get('autoChatTitles')) {
      throw new ChatTitleError('feature_disabled', 'Auto chat titles are off')
    }

    const chat = chatRepo.getOwned(userId, chatId)
    if (!chat) {
      throw new ChatTitleError('chat_not_found', 'Chat not found')
    }

    // COUNT-only early-out so the noisy non-first-send case doesn't
    // deserialize the whole history. We only load the actual message row
    // when count === 1.
    const userMessageCount = messageRepo.countByRole(chatId, 'user')
    if (userMessageCount !== 1) {
      throw new ChatTitleError(
        'not_first_message',
        `Expected exactly 1 user message, found ${userMessageCount}`
      )
    }
    const firstUserMessage = messageRepo.firstByRole(chatId, 'user')
    if (!firstUserMessage) {
      // Race: count saw 1 but the row was deleted in the meantime.
      throw new ChatTitleError(
        'not_first_message',
        'First user message disappeared between count and fetch'
      )
    }
    const firstUserText = firstUserMessage.content.trim()
    if (!firstUserText) {
      throw new ChatTitleError('empty_output', 'First user message is empty')
    }

    // User-edited titles are sacred. Both 'New Chat' and the renderer's
    // truncation of the first message are treated as "still auto-set" and
    // safe to replace — anything else means the user (or another feature)
    // intentionally renamed the chat.
    if (!isUntouchedAutoTitle(chat.title, firstUserText)) {
      throw new ChatTitleError(
        'chat_renamed_initial',
        'Chat already has a custom title'
      )
    }

    let resolved
    try {
      resolved = aiFunctions.resolveAdapterFromDefaultMode(userId)
    } catch (err) {
      if (err instanceof AiFunctionError) throw mapAiFunctionError(err)
      throw err
    }

    let raw: string
    try {
      raw = await aiFunctions.runSingleShot({
        adapter: resolved.adapter,
        modelId: resolved.modelId,
        systemPrompt: TITLE_SYSTEM_PROMPT,
        userText: firstUserText,
        label: 'chat-title',
        maxOutputChars: MAX_TITLE_CHARS
      })
    } catch (err) {
      if (err instanceof AiFunctionError) throw mapAiFunctionError(err)
      throw err
    }

    const title = sanitizeTitle(raw)
    if (!title) {
      throw new ChatTitleError(
        'empty_output',
        'Model output sanitized to empty title'
      )
    }

    // Re-check the title hasn't changed between the read above and now —
    // a slow LLM call gives plenty of window for the user to manually
    // rename the chat. Re-read instead of trusting the snapshot.
    const fresh = chatRepo.getOwned(userId, chatId)
    if (!fresh) {
      throw new ChatTitleError('chat_not_found', 'Chat deleted during generation')
    }
    if (!isUntouchedAutoTitle(fresh.title, firstUserText)) {
      throw new ChatTitleError(
        'chat_renamed_mid_flight',
        'Chat was renamed while title was being generated'
      )
    }

    chatRepo.updateMeta(userId, chatId, { title })
    logger.info('chat title generated', {
      chatId,
      modelId: resolved.modelId,
      providerType: resolved.adapter.providerType,
      titleLen: title.length
    })
    broadcastTitleUpdate(chatId, title)
  }
}
