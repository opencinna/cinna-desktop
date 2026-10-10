/**
 * One catalog item as cinna-core's unified listing sends it
 * (`GET /api/v1/catalog/items`, `GET /api/v1/catalog/items/{uuid}`,
 * `POST /api/v1/catalog/desktop-agents`): a cloud agent, a desktop agent or a
 * skill package, keyed on its `uuid`.
 *
 * Kept in core's own snake_case: the field names are a contract core shares
 * with this app (core `app/models/catalog/catalog_item.py`), and main keeps the
 * listing as it came so the one-catalog dialog can read every kind from it.
 * Team sharing derives its own entries from the desktop agents in it
 * (`libraryService`).
 */

/**
 * Main → renderer, no payload: the cached listing moved in a way the catalog
 * dialog shows but team sharing does not care about (a cloud agent's install,
 * a skill's new version). Desktop-agent moves are `sharing:changed`, which
 * re-reads the catalog's items as well.
 */
export const CATALOG_ITEMS_CHANGED_CHANNEL = 'catalog:items-changed'

/** What the caller may do with an item: see and install, publish new versions, manage access. */
export type CatalogAccessLevel = 'use' | 'edit' | 'maintain'

/**
 * Who an item reaches besides its grants. `public` (and listed) gives everyone
 * on the instance `use`; a `use` grant counts only under `users`.
 */
export type CatalogVisibility = 'private' | 'users' | 'public'

export interface CatalogPersonWire {
  user_id: string
  display_name: string
}

/** The item's newest version. A desktop agent has none until its first share. */
export interface CatalogLatestWire {
  revision_number: number
  version: string | null
  published_at: string
  published_by: CatalogPersonWire | null
  release_notes: string | null
}

/** One of the caller's installs: an agent in Cinna (`cloud`), or one a desktop reported (`local`). */
export interface CatalogInstallWire {
  where: 'cloud' | 'local'
  install_id: string | null
  device_id: string | null
  host_manifest_id: string | null
  revision_number: number | null
}

export interface CatalogItemSkillWire {
  name: string
  description: string | null
  source: 'authored' | 'catalog'
  package_id: string | null
  package_uuid: string | null
}

/** Where Cinna Desktop gets a desktop agent. */
export interface CatalogDesktopWire {
  repo_id: string
  clone_url: string
  default_branch: string
  head_sha: string | null
  manifest_id: string
  slug: string
  engine: string | null
  contract_version: string | null
}

export interface CatalogSkillContentWire {
  frontmatter: Record<string, unknown>
  archive_sha256: string | null
  size_bytes: number
}

export interface CatalogItem {
  kind: 'agent' | 'skill'
  /** Agents only. */
  runs_on: 'cloud' | 'desktop' | null
  uuid: string
  /** `bundle_id` (agents) or `package_id` (skills). */
  id: string
  /** The display name for a cloud agent, the slug for a desktop agent, the folder name for a skill. */
  name: string
  display_name: string
  description: string | null
  publisher: CatalogPersonWire | null
  maintainers: CatalogPersonWire[]
  access: CatalogAccessLevel
  visibility: CatalogVisibility
  is_listed: boolean
  latest: CatalogLatestWire | null
  install_count: number
  my_installs: CatalogInstallWire[]
  required_credential_specs: Record<string, unknown>[]
  /** Agents only. */
  skills: CatalogItemSkillWire[] | null
  /** Desktop agents only. */
  desktop: CatalogDesktopWire | null
  /** Skills only. */
  skill: CatalogSkillContentWire | null
}

/** One version, as `GET /api/v1/catalog/items/{uuid}` lists them, newest first. */
export interface CatalogRevisionWire {
  revision_number: number
  version: string | null
  published_at: string
  published_by: CatalogPersonWire | null
  release_notes: string | null
  /** `publish` (cloud agent), `share` (desktop agent) or `skill`. */
  origin: string
  git_commit_sha: string | null
}

/** One item with its versions, as `GET /api/v1/catalog/items/{uuid}` answers. */
export interface CatalogItemDetail extends CatalogItem {
  /** Newest first. */
  revisions: CatalogRevisionWire[]
}

/**
 * The active Cinna profile's catalog listing as the renderer reads it: every
 * item main's cached `GET /api/v1/catalog/items` gave, every kind, as core
 * sent it (`catalog:items`).
 */
export interface CatalogItemsListing {
  /** The instance the listing came from, `https://host[:port]`. */
  host: string
  items: CatalogItem[]
  /** When main fetched it. */
  fetchedAt: string
  /**
   * False when the instance answered 404 or 403 and the listing stands in as
   * empty — an older server without the catalog routes, or one that gates them.
   */
  available: boolean
}
