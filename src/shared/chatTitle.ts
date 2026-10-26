/**
 * Single source of truth for the chat-title fallback the renderer applies
 * to a brand-new chat (truncated first user message). The main-process
 * auto-title feature needs to recognise this exact shape to decide whether
 * a chat is "still using an auto-generated title" — duplicating the rule
 * across layers would silently break the feature the next time the
 * truncation changes.
 */

import { pathRefLabel, splitPathRefs } from './pathMentions'
import { pasteLabel, splitPastes, typedText } from './pastedText'

export const AUTO_TITLE_MAX_FROM_MESSAGE = 50

/**
 * Derive the renderer's fallback chat title from the user's first message:
 * the message itself if short enough, otherwise the first
 * {@link AUTO_TITLE_MAX_FROM_MESSAGE} characters plus a unicode ellipsis.
 */
export function deriveTitleFromMessage(message: string): string {
  // Files and folders sent as reference chips ("Mention in Cinna") are lines
  // naming absolute paths after the typed text; the title is the typed text,
  // or with none the chips' names — never "Referenced file: /Users/…".
  // Pasted text goes before the typed text as `<pasted_text>` blocks; the
  // title is the typed text, or with none the first paste's label.
  const segments = splitPastes(message)
  const firstPaste = segments.find((segment) => segment.kind === 'paste')
  if (firstPaste) message = typedText(message).trim()
  const { text, paths } = splitPathRefs(message)
  if (paths.length > 0) message = text.trim() || paths.map(pathRefLabel).join(', ')
  if (firstPaste && !message.trim()) message = pasteLabel(firstPaste.text)
  if (message.length > AUTO_TITLE_MAX_FROM_MESSAGE) {
    return message.slice(0, AUTO_TITLE_MAX_FROM_MESSAGE) + '…'
  }
  return message
}
