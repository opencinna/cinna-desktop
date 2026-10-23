import { createLogger } from '../logger/logger'

/**
 * "The AI credentials may have changed" — a key saved or removed by the user,
 * or an account-config sync that provisioned, rotated or pruned managed rows.
 *
 * A signal with no payload, in a module that imports nothing, so the writers
 * (`providerService`, `accountConfigService`) can raise it without importing
 * whoever reacts. The listener decides whether anything it depends on moved:
 * the drivers' wiring retires idle Claude processes whose auth fingerprint is
 * no longer current (`installClaudeAuthFollow`).
 */
const logger = createLogger('ai-credential-changes')
const listeners = new Set<() => void>()

export function notifyAiCredentialsChanged(): void {
  for (const listener of listeners) {
    try {
      listener()
    } catch (err) {
      logger.warn('an AI credential change listener threw', { error: String(err) })
    }
  }
}

/** Returns unsubscribe. */
export function onAiCredentialsChanged(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}
