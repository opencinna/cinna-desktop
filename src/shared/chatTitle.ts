/**
 * Single source of truth for the chat-title fallback the renderer applies
 * to a brand-new chat (truncated first user message). The main-process
 * auto-title feature needs to recognise this exact shape to decide whether
 * a chat is "still using an auto-generated title" — duplicating the rule
 * across layers would silently break the feature the next time the
 * truncation changes.
 */

export const AUTO_TITLE_MAX_FROM_MESSAGE = 50

/**
 * Derive the renderer's fallback chat title from the user's first message:
 * the message itself if short enough, otherwise the first
 * {@link AUTO_TITLE_MAX_FROM_MESSAGE} characters plus a unicode ellipsis.
 */
export function deriveTitleFromMessage(message: string): string {
  if (message.length > AUTO_TITLE_MAX_FROM_MESSAGE) {
    return message.slice(0, AUTO_TITLE_MAX_FROM_MESSAGE) + '…'
  }
  return message
}
