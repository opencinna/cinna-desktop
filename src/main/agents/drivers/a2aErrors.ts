import { A2aHttpError, AgentCardFetchError } from '../a2a-client'

/**
 * 401 or 403 from an A2A agent, whichever layer caught it; otherwise undefined.
 *
 * Two paths can produce the typed status: `A2aHttpError` from the logging
 * fetch (which intercepts 401/403 before the SDK or the card fetch wraps the
 * response), and `AgentCardFetchError` from the card fetch (any other non-OK
 * status — kept for symmetry, since 401/403 reach the fetch layer first).
 *
 * Its own module so the A2A driver can classify a rejection without importing
 * the connection helpers, which name the keystore and the Cinna OAuth flow.
 */
export function authRejectionStatus(err: unknown): 401 | 403 | undefined {
  const status =
    err instanceof A2aHttpError
      ? err.status
      : err instanceof AgentCardFetchError
        ? err.status
        : undefined
  return status === 401 || status === 403 ? status : undefined
}
