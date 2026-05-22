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
