import type { CatalogCredentialSpec } from '../../../shared/catalog'
import type { CatalogInstallWire, CatalogItem } from '../../../shared/catalogItems'
import { parseServerTimestamp } from './cinnaTime'

/**
 * How the catalog dialog and the Inbox read a catalog item: which of the
 * three kinds it is, the words for that kind, its version and its people.
 *
 * The vocabulary is the catalog's (plan U12): *Runs in Cinna* for a cloud
 * agent, *Runs on your computer* for a desktop agent, *Get*, *Update*,
 * *Version N*. No source names — the user sees one catalog.
 */

/** The three kinds the one list holds. What decides each item's action. */
export type CatalogItemKind = 'cloud_agent' | 'desktop_agent' | 'skill'

export function catalogItemKind(item: Pick<CatalogItem, 'kind' | 'runs_on'>): CatalogItemKind {
  if (item.kind === 'skill') return 'skill'
  return item.runs_on === 'desktop' ? 'desktop_agent' : 'cloud_agent'
}

/** The kind badge, on a tile, a detail and an Inbox card alike. */
export const CATALOG_KIND_TEXT: Record<CatalogItemKind, string> = {
  cloud_agent: 'Runs in Cinna',
  desktop_agent: 'Runs on your computer',
  skill: 'Skill'
}

/** The dialog's filter: one choice, kept for the session across the dialog's opens. */
export type CatalogFilter = 'all' | 'agents' | 'skills'

export const CATALOG_FILTER_TEXT: Record<CatalogFilter, string> = {
  all: 'All',
  agents: 'Agents',
  skills: 'Skills'
}

export function inCatalogFilter(kind: CatalogItemKind, filter: CatalogFilter): boolean {
  if (filter === 'all') return true
  return filter === 'skills' ? kind === 'skill' : kind !== 'skill'
}

/** Fixed words of the catalog dialog. */
export const CATALOG_TEXT = {
  title: 'Catalog',
  filterLabel: 'Show',
  searchLabel: 'Search the catalog',
  searchPlaceholder: 'Search the catalog…',
  refresh: 'Refresh',
  refreshFailed: 'Couldn’t refresh.',
  refreshReauth: 'Session expired.',
  reauthenticate: 'Re-authenticate',
  back: 'Back to catalog',
  loading: 'Loading the catalog…',
  loadFailed: 'Could not load the catalog.',
  reauth: 'Cinna session expired. Re-authenticate to load the catalog.',
  unavailable: 'This server has no catalog yet.',
  empty: {
    all: 'Nothing is in the catalog for you yet.',
    agents: 'No agents are in the catalog for you yet.',
    skills: 'No skills are in the catalog for you yet.'
  } satisfies Record<CatalogFilter, string>,
  noMatch: 'Nothing matches your search.',
  get: 'Get',
  getting: 'Getting…',
  update: 'Update',
  updating: 'Updating…',
  /** A cloud agent installed but not synced to this computer yet, so there is nothing to Open. */
  installed: 'Installed',
  open: 'Open',
  anotherGetting: 'Another agent is being added',
  needs: (names: string) => `Needs ${names}`,
  by: (names: string) => `by ${names}`,
  maintainersLabel: 'Maintainers',
  publisherLabel: 'Shared by',
  catalogIdLabel: 'Catalog id',
  usersLabel: 'Users',
  usedByLabel: 'In your agents',
  versionsHeading: 'Versions',
  versionsLoading: 'Loading versions…',
  versionsFailed: 'The versions couldn’t be read.',
  versionsEmpty: 'No version has been shared yet.',
  retry: 'Retry',
  sharedBy: (who: string) => `shared by ${who}`,
  showMore: 'Show more',
  showLess: 'Show less'
} as const

/**
 * `Version N`, with the publisher's own label beside it when the version has
 * one: `Version 3 (1.2.0)`. The number is what every kind has; the label is
 * what a publisher wrote.
 */
export function catalogVersionLabel(revisionNumber: number, version: string | null | undefined): string {
  const label = typeof version === 'string' ? version.trim() : ''
  return label ? `Version ${revisionNumber} (${label})` : `Version ${revisionNumber}`
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

/**
 * A version's date as the catalog and the Inbox show it, with the month as a
 * word so no reader has to guess the order: `13 Sep 2026`. Null for a missing
 * or unreadable date.
 */
export function catalogDateLabel(value: string | Date | null | undefined): string | null {
  if (!value) return null
  const ms = value instanceof Date ? value.getTime() : parseServerTimestamp(value)
  if (Number.isNaN(ms)) return null
  const date = new Date(ms)
  return `${date.getDate()} ${MONTHS[date.getMonth()]} ${date.getFullYear()}`
}

/** The name the user knows the item by. */
export function catalogItemName(item: Pick<CatalogItem, 'display_name' | 'name' | 'id'>): string {
  return item.display_name || item.name || item.id
}

/** Who stands behind an item: its maintainers, or the publisher when none are named. */
export function catalogItemPeople(item: Pick<CatalogItem, 'maintainers' | 'publisher'>): string | null {
  const names = (Array.isArray(item.maintainers) ? item.maintainers : [])
    .map((person) => person?.display_name)
    .filter((name): name is string => typeof name === 'string' && name !== '')
  if (names.length > 0) return names.join(', ')
  return item.publisher?.display_name || null
}

/** The item's credential slots, in the shape the catalog's credential rows read. */
export function catalogCredentialSpecs(item: Pick<CatalogItem, 'required_credential_specs'>): CatalogCredentialSpec[] {
  const raw = Array.isArray(item.required_credential_specs) ? item.required_credential_specs : []
  return raw.flatMap((spec): CatalogCredentialSpec[] => {
    const name = typeof spec?.name === 'string' ? spec.name : ''
    if (name === '') return []
    const providedBy = spec.provided_by === 'publisher' || spec.provided_by === 'template' ? spec.provided_by : 'user'
    return [
      {
        name,
        type: typeof spec.type === 'string' ? spec.type : '',
        description: typeof spec.description === 'string' ? spec.description : null,
        providedBy
      }
    ]
  })
}

/**
 * The caller's install of a cloud agent, if any. With more than one, the one
 * the tile can act on: one already synced to an agent row on this computer
 * (`synced`) first, then one behind the latest version, then the lowest
 * install id — the same answer on every read.
 */
export function cloudInstallOf(
  item: Pick<CatalogItem, 'my_installs' | 'latest'>,
  synced: (installId: string) => boolean = () => false
): CatalogInstallWire | null {
  const installs = Array.isArray(item.my_installs) ? item.my_installs : []
  const latest = item.latest?.revision_number ?? null
  const rank = (install: CatalogInstallWire): number => {
    const behind = latest !== null && install.revision_number != null && install.revision_number < latest
    return (synced(install.install_id as string) ? 0 : 2) + (behind ? 0 : 1)
  }
  const candidates = installs.filter((install) => install?.where === 'cloud' && !!install.install_id)
  candidates.sort(
    (a, b) => rank(a) - rank(b) || (a.install_id as string).localeCompare(b.install_id as string)
  )
  return candidates[0] ?? null
}

/** The manifest ids of the local agents that pin a skill, as the caller reported them. */
export function skillHostManifestIds(item: Pick<CatalogItem, 'my_installs'>): string[] {
  const installs = Array.isArray(item.my_installs) ? item.my_installs : []
  return installs.flatMap((install) =>
    install?.where === 'local' && install.host_manifest_id ? [install.host_manifest_id.toLowerCase()] : []
  )
}

/** Search over name, description, maintainers and publisher, and the catalog id. */
export function matchesCatalogQuery(item: CatalogItem, needle: string): boolean {
  if (needle === '') return true
  return [
    item.display_name,
    item.name,
    item.description,
    item.id,
    item.publisher?.display_name,
    ...(Array.isArray(item.maintainers) ? item.maintainers.map((person) => person?.display_name) : [])
  ].some((value) => typeof value === 'string' && value.toLowerCase().includes(needle))
}
