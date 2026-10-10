/**
 * The active Cinna profile's catalog, as last listed, and the team library —
 * the desktop agents in it — derived from that one listing.
 *
 * `GET /api/v1/catalog/items` answers every kind the caller may list (cloud
 * agents, desktop agents, skills). It is fetched once and kept whole
 * ({@link CachedListing.items}) for the one-catalog dialog; team sharing reads
 * the desktop agents out of it ({@link CachedListing.agents}).
 *
 * Core's events do not reach the desktop yet, so this polls: once when a
 * Cinna profile becomes active, every five minutes while it stays active, and
 * whenever a caller asks for a refresh (the catalog's Team library, and every
 * sharing action that moved an agent). The listing is the one place
 * `head_sha` per desktop agent comes from, which is what lets a shared agent
 * say "The team changed this agent" without a fetch per folder.
 *
 * Nothing here is persisted: a restart lists again.
 *
 * `sharing:changed` is published when the set of desktop agents, their heads,
 * versions, visibility, listing or the caller's access moved — not on every poll — so
 * the renderer refetches only when there is something new to show. Any other
 * move of an item the catalog dialog shows (a cloud agent installed, a
 * skill's new version) is the lighter `catalog:items-changed`, which re-reads
 * only the catalog's items and the Inbox, never the sharing reads.
 */
import { publishEvent } from '../host/events'
import { userRepo } from '../db/users'
import { cinnaFetch } from './cinna-http'
import { CinnaApiError, DomainError } from '../errors'
import { CinnaReauthRequired } from '../auth/cinna-oauth'
import { libraryTrust } from './libraryTrust'
import { createLogger } from '../logger/logger'
import { SHARING_CHANGED_CHANNEL } from '../../shared/agentSharing'
import type { LibraryAccess, LibraryMaintainer, LibraryVersionDto } from '../../shared/agentSharing'
import { CATALOG_ITEMS_CHANGED_CHANNEL } from '../../shared/catalogItems'
import type {
  CatalogItem,
  CatalogItemDetail,
  CatalogItemsListing,
  CatalogRevisionWire,
  CatalogVisibility
} from '../../shared/catalogItems'

const logger = createLogger('team-library')

const REFRESH_INTERVAL_MS = 5 * 60 * 1000

/** The listing, under the profile's API. */
export const CATALOG_ITEMS_PATH = '/api/v1/catalog/items'

/** One catalog item's path, under the profile's API. */
export function catalogItemPath(uuid: string): string {
  return `${CATALOG_ITEMS_PATH}/${encodeURIComponent(uuid)}`
}

/** One team agent (a desktop agent in the catalog) as main keeps it: the listing's facts, nothing about this machine. */
export interface LibraryEntry {
  /** The catalog item's uuid — what every catalog route takes. */
  uuid: string
  /** The catalog id (`bundle_id`). */
  bundleId: string
  repoId: string
  slug: string
  name: string
  description: string
  cloneUrl: string
  /** '' before the first share. */
  headSha: string
  access: LibraryAccess
  visibility: CatalogVisibility
  /**
   * Whether the catalog lists it. Core counts `public` (everyone's `use`) and
   * a `use` grant only while it is listed; `edit` and `maintain` grants count
   * either way.
   */
  isListed: boolean
  maintainers: LibraryMaintainer[]
  engine: string | null
  manifestId: string | null
  /** Null until the first share. */
  latest: LibraryVersionDto | null
}

export interface CachedListing {
  /** `scheme://host[:port]` of the profile's server. */
  host: string
  /** Every item the listing gave, every kind, as core sent it. */
  items: CatalogItem[]
  /** The desktop agents among {@link items}, as team sharing reads them. */
  agents: LibraryEntry[]
  fetchedAt: Date
  /**
   * False when the instance answered 404 or 403 and the listing stands in as
   * empty: it says nothing about which entries exist, so no caller may read
   * an entry's absence from it as "removed from the library".
   */
  available: boolean
}

const cache = new Map<string, CachedListing>()
/**
 * Per profile: the number of the last refresh started, and of the one whose
 * listing the cache holds. Refreshes overlap — the five-minute timer, a
 * catalog opening, a sharing action's own re-read — and their answers can
 * land in any order; a later-started one already in the cache means an
 * earlier one's answer is older than what is there, so it is dropped.
 */
const started = new Map<string, number>()
const applied = new Map<string, number>()
/** Hosts already logged as having no catalog listing, so a 404 is said once. */
const missingRoutesLogged = new Set<string>()
let timer: ReturnType<typeof setInterval> | null = null
let generation = 0

const str = (value: unknown): string => (typeof value === 'string' ? value : '')
const strOrNull = (value: unknown): string | null =>
  typeof value === 'string' && value !== '' ? value : null
const record = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null

function toAccess(value: unknown): LibraryAccess {
  return value === 'edit' || value === 'maintain' ? value : 'use'
}

function toVisibility(value: unknown): CatalogVisibility {
  return value === 'public' || value === 'users' ? value : 'private'
}

/** `{user_id, display_name}` → a person; null without an id. */
function toPerson(value: unknown): LibraryMaintainer | null {
  const row = record(value)
  const userId = str(row?.user_id)
  return userId === '' ? null : { userId, displayName: str(row?.display_name) || userId }
}

/**
 * One listing row, checked loosely: an object with a `uuid`, an `id` and a
 * known `kind`. Kept as core sent it; null for anything else.
 */
export function toCatalogItem(raw: unknown): CatalogItem | null {
  const row = record(raw)
  if (!row) return null
  if (str(row.uuid) === '' || str(row.id) === '') return null
  if (row.kind !== 'agent' && row.kind !== 'skill') return null
  return row as unknown as CatalogItem
}

/**
 * A catalog item → a {@link LibraryEntry}, for a desktop agent that carries
 * what a Get needs (`desktop.repo_id`, `clone_url`, `slug`); null otherwise.
 */
export function toLibraryEntry(raw: unknown): LibraryEntry | null {
  const item = record(raw)
  if (!item || item.kind !== 'agent' || item.runs_on !== 'desktop') return null
  const desktop = record(item.desktop) ?? {}
  const uuid = str(item.uuid)
  const repoId = str(desktop.repo_id)
  const cloneUrl = str(desktop.clone_url)
  const slug = str(desktop.slug)
  if (uuid === '' || repoId === '' || cloneUrl === '' || slug === '') return null
  const maintainers = Array.isArray(item.maintainers)
    ? item.maintainers.flatMap((entry): LibraryMaintainer[] => {
        const person = toPerson(entry)
        return person ? [person] : []
      })
    : []
  const latestRow = record(item.latest)
  const number = latestRow && typeof latestRow.revision_number === 'number' ? latestRow.revision_number : null
  const latest: LibraryVersionDto | null =
    latestRow && number !== null
      ? {
          number,
          label: strOrNull(typeof latestRow.version === 'string' ? latestRow.version.trim() : null),
          publishedAt: str(latestRow.published_at),
          publishedBy: toPerson(latestRow.published_by)?.displayName ?? null,
          releaseNotes: strOrNull(latestRow.release_notes)
        }
      : null
  return {
    uuid,
    bundleId: str(item.id),
    repoId,
    slug,
    name: str(item.display_name) || str(item.name) || slug,
    description: str(item.description),
    cloneUrl,
    headSha: str(desktop.head_sha),
    access: toAccess(item.access),
    visibility: toVisibility(item.visibility),
    // Core always sends it; a row without it is read as listed, as before it existed.
    isListed: item.is_listed !== false,
    maintainers,
    engine: strOrNull(desktop.engine),
    manifestId: strOrNull(desktop.manifest_id),
    latest
  }
}

/**
 * What decides whether team sharing has to be told (`sharing:changed`): the
 * desktop agents as team sharing reads them. Every sharing read in the
 * renderer — each shared agent's git status among them — re-reads on it, so
 * nothing else belongs here.
 */
function sharingSignature(listing: CachedListing | undefined): string {
  if (!listing) return ''
  return [
    listing.host,
    ...listing.agents
      .map(
        (agent) =>
          `${agent.uuid}:${agent.repoId}:${agent.headSha}:${agent.access}:${agent.visibility}:${agent.isListed}:${agent.latest?.number ?? 0}`
      )
      .sort()
  ].join('|')
}

/**
 * What decides whether the catalog dialog has to be told
 * (`catalog:items-changed`): for every item of every kind the facts it shows
 * and acts on — name, access, version and the caller's own installs — so a
 * cloud agent's install or a skill's new version reaches an open dialog. Not
 * `install_count`: someone else's install is no reason to re-read anything.
 */
function itemsSignature(listing: CachedListing | undefined): string {
  if (!listing) return ''
  return [listing.host, listing.available, ...listing.items.map(itemSignature).sort()].join('|')
}

function itemSignature(item: CatalogItem): string {
  const installs = Array.isArray(item.my_installs)
    ? item.my_installs
        .map((install) => `${install?.where}/${install?.install_id ?? ''}/${install?.host_manifest_id ?? ''}/${install?.revision_number ?? ''}`)
        .sort()
        .join(',')
    : ''
  return [
    item.kind,
    item.uuid,
    item.display_name,
    item.access,
    item.latest?.revision_number ?? 0,
    item.latest?.version ?? '',
    installs
  ].join(':')
}

/** A detail answer's revisions, newest first; rows without a number are dropped. */
function toRevisions(raw: unknown): CatalogRevisionWire[] {
  if (!Array.isArray(raw)) return []
  return raw
    .filter((row): row is CatalogRevisionWire => {
      const rec = record(row)
      return rec !== null && typeof rec.revision_number === 'number'
    })
    .sort((a, b) => b.revision_number - a.revision_number)
}

/** The origin of a Cinna profile's server, or null for any other profile. */
function hostOf(userId: string): string | null {
  const user = userRepo.get(userId)
  if (!user || user.type !== 'cinna_user' || !user.cinnaServerUrl) return null
  try {
    return new URL(user.cinnaServerUrl).origin
  } catch {
    return null
  }
}

export const libraryService = {
  hostOf,

  /** The origins of every Cinna profile on this machine — what makes a remote a `cinna` one. */
  knownHosts(): Set<string> {
    const hosts = new Set<string>()
    for (const user of userRepo.list()) {
      if (user.type !== 'cinna_user' || !user.cinnaServerUrl) continue
      try {
        hosts.add(new URL(user.cinnaServerUrl).origin)
      } catch {
        /* a malformed URL names no host */
      }
    }
    return hosts
  },

  /** The last listing for this profile, without reaching the network. */
  cached(userId: string): CachedListing | null {
    const listing = cache.get(userId)
    if (!listing) return null
    // A profile re-pointed at another server must not keep the old host's listing.
    return listing.host === hostOf(userId) ? listing : null
  },

  /**
   * List the catalog again. Null for a profile that is not a Cinna one.
   *
   * A 404 or 403 is an **empty listing**, said once in the log, not an error:
   * the first is an instance without the catalog routes yet, the second one
   * that gates them by role — and treating a 403 as a dead session would pop
   * the re-auth prompt on every poll for a session that is fine.
   *
   * @throws CinnaApiError `reauth_required` (via `cinnaFetch`) and other
   *   transport failures; the caller decides whether that is a prompt or a log.
   */
  async refresh(userId: string): Promise<CachedListing | null> {
    const host = hostOf(userId)
    if (host === null) return null
    const seq = (started.get(userId) ?? 0) + 1
    started.set(userId, seq)
    let items: CatalogItem[] = []
    let available = true
    try {
      const body = await cinnaFetch<{ data?: unknown }>(userId, CATALOG_ITEMS_PATH)
      const rows = Array.isArray(body?.data) ? body.data : []
      items = rows.flatMap((row) => {
        const item = toCatalogItem(row)
        return item ? [item] : []
      })
    } catch (err) {
      const status = err instanceof CinnaApiError ? err.status : undefined
      if (status === 404 || status === 403) {
        available = false
        if (!missingRoutesLogged.has(host)) {
          missingRoutesLogged.add(host)
          logger.info('catalog listing not available on this instance; treating it as empty', { status })
        }
      } else {
        throw err
      }
    }
    const agents = items.flatMap((item) => {
      const entry = toLibraryEntry(item)
      return entry ? [entry] : []
    })
    // This instance, answering this profile's session, says where its git is.
    for (const agent of agents) libraryTrust.learn(host, agent.cloneUrl)
    // A refresh that started after this one has already answered: the cache
    // is newer than this listing, and still no older than this call's start.
    const newer = cache.get(userId)
    if ((applied.get(userId) ?? 0) > seq && newer && newer.host === host) return newer
    const listing: CachedListing = { host, items, agents, fetchedAt: new Date(), available }
    applied.set(userId, seq)
    const previous = cache.get(userId)
    cache.set(userId, listing)
    // `sharing:changed` re-reads the catalog items too, so one event at most.
    if (sharingSignature(listing) !== sharingSignature(previous)) publishEvent(SHARING_CHANGED_CHANNEL)
    else if (itemsSignature(listing) !== itemsSignature(previous)) publishEvent(CATALOG_ITEMS_CHANGED_CHANNEL)
    return listing
  },

  /**
   * The whole listing, every kind, for the catalog dialog — the same cache
   * team sharing reads; `refresh` lists again first (the dialog opening, its
   * Refresh). Null for a profile that is not a Cinna one.
   */
  async items(userId: string, refresh: boolean): Promise<CatalogItemsListing | null> {
    if (hostOf(userId) === null) return null
    const listing = (!refresh && libraryService.cached(userId)) || (await libraryService.refresh(userId))
    if (!listing) return null
    return {
      host: listing.host,
      items: listing.items,
      fetchedAt: listing.fetchedAt.toISOString(),
      available: listing.available
    }
  },

  /**
   * One item with its versions (`GET /api/v1/catalog/items/{uuid}`), read
   * when the dialog opens its detail. Not cached here: the renderer keeps it
   * while the dialog is open.
   *
   * @throws DomainError `not_a_cinna_profile` for any other profile,
   *   `invalid_id` for an empty uuid, and whatever `cinnaFetch` throws — a
   *   404 when the caller may no longer see the item.
   */
  async itemDetail(userId: string, uuid: string): Promise<CatalogItemDetail> {
    if (hostOf(userId) === null) throw new DomainError('not_a_cinna_profile', 'The catalog needs a Cinna account.')
    if (uuid.trim() === '') throw new DomainError('invalid_id', 'No catalog item was named.')
    const body = await cinnaFetch<unknown>(userId, catalogItemPath(uuid))
    const item = toCatalogItem(body)
    if (!item) throw new DomainError('invalid_response', 'The catalog answered with something that is not an item.')
    return { ...item, revisions: toRevisions(record(body)?.revisions) }
  },

  /** {@link refresh} for timers and hooks: never throws, logs what went wrong. */
  async refreshQuietly(userId: string): Promise<void> {
    const epoch = generation
    try {
      await libraryService.refresh(userId)
    } catch (err) {
      if (epoch !== generation) return
      const reauth =
        err instanceof CinnaReauthRequired ||
        (err instanceof CinnaApiError && err.code === 'reauth_required')
      if (reauth) {
        // Like remote sync: stop polling a session that is gone. Activation
        // after the re-auth starts it again.
        logger.warn('team library refresh stopped: Cinna re-auth required')
        libraryService.stop()
        return
      }
      logger.warn('team library refresh failed', { error: err instanceof Error ? err.message : String(err) })
    }
  },

  /** List now and every five minutes while this profile is active. */
  start(userId: string): void {
    libraryService.stop()
    if (hostOf(userId) === null) return
    timer = setInterval(() => void libraryService.refreshQuietly(userId), REFRESH_INTERVAL_MS)
    timer.unref?.()
    void libraryService.refreshQuietly(userId)
  },

  stop(): void {
    generation++
    if (timer) {
      clearInterval(timer)
      timer = null
    }
  },

  /** Tests only. */
  _reset(): void {
    libraryService.stop()
    cache.clear()
    started.clear()
    applied.clear()
    missingRoutesLogged.clear()
  }
}
