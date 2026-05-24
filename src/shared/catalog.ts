/**
 * DTOs for the bundles catalog (cinna-server agent bundles). Shared across
 * the main-process service, preload bindings, and the renderer settings UI
 * so the wire shape stays consistent.
 *
 * Mirrors a subset of cinna-server's `CatalogEntryPublic`,
 * `SetupStatusResponse`, and `SetupCredentialSummary` Pydantic models — only
 * the fields the desktop renders are kept.
 */

export interface CatalogEntryDto {
  bundleId: string
  bundleUuid: string
  displayName: string
  description: string | null
  publisherName: string | null
  publisherEmail: string | null
  publisherHandle: string | null
  visibility: string
  latestVersion: string | null
  latestRevisionNumber: number | null
  latestPublishedAt: string | null
  installCount: number
  isInstalled: boolean
  /** Set when `isInstalled` — the user's local Agent UUID on the server. */
  userInstallId: string | null
  requiredCredentialSpecs: CatalogCredentialSpec[]
}

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
