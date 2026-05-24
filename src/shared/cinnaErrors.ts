/**
 * Shared constants for Cinna re-authentication signalling across the
 * main/preload/renderer split. Keeping the message text + machine-readable
 * code in one place prevents drift between the IPC handlers that emit a
 * reauth-required error and the renderer surfaces that branch on it (chat
 * SystemMessage chip, settings banner, agent status overlay).
 *
 * Pure type-only / string-constant module — safe to import from either
 * Electron process and the renderer.
 */

/** Stable error code shipped on `AgentErrorEvent` + persisted in error
 *  message rows. Renderer code branches on this rather than substring-matching
 *  the user-facing string. */
export const CINNA_REAUTH_REQUIRED_CODE = 'cinna_reauth_required' as const
export type CinnaReauthRequiredCode = typeof CINNA_REAUTH_REQUIRED_CODE

/** User-facing copy. Single source of truth — change here, both wire and DB
 *  payloads update together. */
export const CINNA_SESSION_EXPIRED_MESSAGE =
  'Cinna session expired — please re-authenticate.'

/** Code on `CinnaApiError` thrown by REST fetches (catalog, agent status,
 *  remote sync) when the server answers 401/403 or token refresh fails. The
 *  IPC error wrapper branches on this to broadcast {@link CINNA_REAUTH_REQUIRED_CHANNEL}. */
export const REAUTH_REQUIRED_CODE = 'reauth_required' as const

/** main → renderer broadcast fired the moment any IPC handler signals a
 *  reauth-required code (whether it threw or returned an error shape). The
 *  renderer raises the global reauth modal off this, so it doesn't depend on a
 *  specific query's error code surviving IPC or on React Query retry timing. */
export const CINNA_REAUTH_REQUIRED_CHANNEL = 'cinna:reauth-required' as const

/** Payload for {@link CINNA_REAUTH_REQUIRED_CHANNEL} — tells the modal which
 *  account/connection lost its session and what was being done when it failed,
 *  so the prompt can name them rather than showing generic copy. */
export interface ReauthRequiredEvent {
  /** Human label for the active Cinna profile (full name › display name › username). */
  account: string
  /** The Cinna server the session is against, if known. */
  serverUrl: string | null
  /** Friendly description of the failing operation, e.g. "agent status". */
  source: string | null
}
