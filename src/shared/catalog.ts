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
