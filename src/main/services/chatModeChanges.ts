import { createLogger } from '../logger/logger'

/**
 * "A chat mode may have changed" — one created, edited, reset or deleted, or a
 * managed mode switched on or off or given another model.
 *
 * The twin of `aiCredentialChanges.ts`: a signal with no payload, in a module
 * that imports nothing, so `chatModeService` can raise it without importing
 * whoever reacts. The listener decides whether anything it depends on moved —
 * the folder agents re-resolve only when the Default runtime they fall back to
 * did (`localAgentService.runtimeInputsMayHaveMoved`, wired in `hub/core.ts`).
 */
const logger = createLogger('chat-mode-changes')
const listeners = new Set<() => void>()

export function notifyChatModesChanged(): void {
  for (const listener of listeners) {
    try {
      listener()
    } catch (err) {
      logger.warn('a chat mode change listener threw', { error: String(err) })
    }
  }
}

/** Returns unsubscribe. */
export function onChatModesChanged(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}
