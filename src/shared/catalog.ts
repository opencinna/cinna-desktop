/**
 * DTOs for the bundles catalog (cinna-server agent bundles). Shared across
 * the main-process service, preload bindings, and the renderer settings UI
 * so the wire shape stays consistent.
 *
 * Mirrors a subset of cinna-server's `SetupStatusResponse` and
 * `SetupCredentialSummary` Pydantic models — only the fields the desktop
 * renders are kept.
 */

export interface CatalogCredentialSpec {
  name: string
  type: string
  description: string | null
  providedBy: 'user' | 'publisher' | 'template'
}

/** Result of POST /catalog/{bundle_id}/install. */
export interface CatalogInstallResultDto {
  installId: string
  bundleId: string
  agentName: string
}

export type SetupStatusValue = 'ready' | 'needs_setup' | 'publisher_broken'

export type SetupMissingReason =
  | 'placeholder_empty'
  | 'publisher_credential_missing'
  | 'publisher_credential_unshared'

export interface SetupMissingItemDto {
  specName: string
  specType: string
  reason: SetupMissingReason
  isAi: boolean
}

export interface SetupStatusDto {
  status: SetupStatusValue
  missing: SetupMissingItemDto[]
  /** Absolute URL to the install's Credentials tab; surfaced by the server. */
  setupUrl: string | null
}

export interface SetupCredentialSummaryDto {
  id: string
  name: string
  type: string
  description: string | null
  templatePrivateFields: string[]
}

/**
 * Per-spec auto-prefill verdict from `GET /catalog/{bundle_id}/install-context`.
 * The match itself runs on cinna-server (`CredentialsService.find_match_for_spec`);
 * the desktop only consumes the boolean outcome plus the template-private-fields
 * hint so the catalog card can render an "already covered" vs "you'll provide
 * this" vs "template fields to fill" affordance per spec.
 */
export interface InstallContextSpecDto {
  name: string
  type: string
  providedBy: 'user' | 'publisher' | 'template'
  hasSuggestedMatch: boolean
  templatePrivateFields: string[]
}

/**
 * Lightweight (name, type) descriptor for a publisher-provided AI credential.
 * Mirrors `InstallContextPublisherSummary` on cinna-server — names and types
 * are safe to surface; secret values stay on the server.
 */
export interface InstallContextPublisherSummaryDto {
  name: string
  type: string
}

export interface InstallContextDto {
  specs: InstallContextSpecDto[]
  /**
   * When true the bundle ships AI credentials and the install will link the
   * publisher's keys; the user doesn't need their own. When false the install
   * falls back to the user's account-wide AI defaults (or lands in
   * needs_setup if those aren't configured).
   */
  aiProvidedByPublisher: boolean
  /**
   * Per-role summary of the publisher's AI credentials, surfaced so the
   * card can name what the install will link. Only populated when
   * `aiProvidedByPublisher === true`; either field can still be null when
   * the publisher only provides one role or the row is no longer resolvable.
   */
  aiPublisherSummaries: {
    conversation: InstallContextPublisherSummaryDto | null
    building: InstallContextPublisherSummaryDto | null
  }
}

/**
 * What `catalog:items`, `catalog:item` and `catalog:quick-install` resolve with.
 *
 * A failure is returned, not thrown: a thrown error's `code` does not survive
 * `ipcMain.handle` and `contextBridge` (see `src/main/ipc/_wrap.ts`), and the
 * renderer needs `reauth_required` to offer re-authentication rather than a
 * bare retry. `success: false` plus `code` is also the shape `_wrap` inspects to
 * raise the app-wide session-expired prompt.
 */
export type CatalogOutcome<T> =
  | { success: true; value: T }
  | { success: false; code: string; message: string }

/** Turn an outcome back into a value, or a thrown error carrying its `code`. */
export function unwrapCatalogOutcome<T>(outcome: CatalogOutcome<T>): T {
  if (outcome.success) return outcome.value
  const error = new Error(outcome.message) as Error & { code: string }
  error.code = outcome.code
  throw error
}
