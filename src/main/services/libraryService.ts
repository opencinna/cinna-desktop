/**
 * The active Cinna profile's team library, as last listed.
 *
 * Core has no realtime channel for library changes, so this polls: once when
 * a Cinna profile becomes active, every five minutes while it stays active,
 * and whenever a caller asks for a refresh (the catalog's Team library, and
 * every sharing action that moved a repository). The listing is the one
 * place `head_sha` per repository comes from, which is what lets a shared
 * agent say "The team changed this agent" without a fetch per folder.
 *
 * Nothing here is persisted: a restart lists again.
 *
 * `sharing:changed` is published when the set of repositories, their heads or
 * the caller's grants moved — not on every poll — so the renderer refetches
 * only when there is something new to show.
 */
import { publishEvent } from '../host/events'
import { userRepo } from '../db/users'
import { cinnaFetch } from './cinna-http'
import { CinnaApiError } from '../errors'
import { CinnaReauthRequired } from '../auth/cinna-oauth'
import { libraryTrust } from './libraryTrust'
import { createLogger } from '../logger/logger'
import { SHARING_CHANGED_CHANNEL } from '../../shared/agentSharing'
import type { LibraryAccess, LibraryMaintainer } from '../../shared/agentSharing'

const logger = createLogger('team-library')

const REFRESH_INTERVAL_MS = 5 * 60 * 1000

/** One library agent as main keeps it: the listing's facts, nothing about this machine. */
export interface LibraryEntry {
  repoId: string
  slug: string
  name: string
  description: string
  cloneUrl: string
  headSha: string
  updatedAt: string
  access: LibraryAccess
  maintainers: LibraryMaintainer[]
  engine: string | null
  manifestId: string | null
  /** Who sent the latest version, when the listing says. */
  pushedBy: string | null
}

export interface CachedListing {
  /** `scheme://host[:port]` of the profile's server. */
  host: string
  agents: LibraryEntry[]
  fetchedAt: Date
  /**
   * False when the instance answered 404 or 403 and the listing stands in as
   * empty: it says nothing about which entries exist, so no caller may read
   * an entry's absence from it as "removed from the library".
   */
  available: boolean
}

/** `LibraryAgent` as core sends it (README §4.2), loosely: every field is checked. */
interface RawLibraryAgent {
  repo_id?: unknown
  slug?: unknown
  name?: unknown
  description?: unknown
  clone_url?: unknown
  head_sha?: unknown
  updated_at?: unknown
  access?: unknown
  maintainers?: unknown
  manifest?: unknown
  pushed_by?: unknown
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
/** Hosts already logged as having no library routes, so a 404 is said once. */
const missingRoutesLogged = new Set<string>()
let timer: ReturnType<typeof setInterval> | null = null
let generation = 0

const str = (value: unknown): string => (typeof value === 'string' ? value : '')
const strOrNull = (value: unknown): string | null =>
  typeof value === 'string' && value !== '' ? value : null

function toAccess(value: unknown): LibraryAccess {
  return value === 'write' || value === 'maintain' ? value : 'read'
}

/** snake_case listing row → {@link LibraryEntry}; null when it lacks what a Get needs. */
export function toLibraryEntry(raw: RawLibraryAgent): LibraryEntry | null {
  const repoId = str(raw.repo_id)
  const cloneUrl = str(raw.clone_url)
  const slug = str(raw.slug)
  if (repoId === '' || cloneUrl === '' || slug === '') return null
  const manifest =
    raw.manifest && typeof raw.manifest === 'object' ? (raw.manifest as Record<string, unknown>) : {}
  const runtime =
    manifest.runtime && typeof manifest.runtime === 'object'
      ? (manifest.runtime as Record<string, unknown>)
      : {}
  const maintainers = Array.isArray(raw.maintainers)
    ? raw.maintainers.flatMap((entry): LibraryMaintainer[] => {
        if (!entry || typeof entry !== 'object') return []
        const row = entry as Record<string, unknown>
        const userId = str(row.user_id)
        return userId === '' ? [] : [{ userId, displayName: str(row.display_name) || userId }]
      })
    : []
  const pushedBy =
    raw.pushed_by && typeof raw.pushed_by === 'object'
      ? strOrNull((raw.pushed_by as Record<string, unknown>).display_name)
      : strOrNull(raw.pushed_by)
  return {
    repoId,
    slug,
    name: str(raw.name) || str(manifest.name) || slug,
    description: str(raw.description) || str(manifest.description),
    cloneUrl,
    headSha: str(raw.head_sha),
    updatedAt: str(raw.updated_at),
    access: toAccess(raw.access),
    maintainers,
    engine: strOrNull(runtime.engine),
    manifestId: strOrNull(manifest.id),
    pushedBy
  }
}

/** What decides whether the renderer has to be told. */
function signature(listing: CachedListing | undefined): string {
  if (!listing) return ''
  return [
    listing.host,
    ...listing.agents.map((agent) => `${agent.repoId}:${agent.headSha}:${agent.access}`).sort()
  ].join('|')
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
   * List the library again. Null for a profile that is not a Cinna one.
   *
   * A 404 or 403 is an **empty library**, said once in the log, not an error:
   * the first is an instance without the library routes yet, the second one
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
    let agents: LibraryEntry[] = []
    let available = true
    try {
      const body = await cinnaFetch<{ agents?: unknown }>(userId, '/api/v1/library')
      const rows = Array.isArray(body?.agents) ? (body.agents as RawLibraryAgent[]) : []
      agents = rows.flatMap((row) => {
        const entry = row && typeof row === 'object' ? toLibraryEntry(row) : null
        return entry ? [entry] : []
      })
    } catch (err) {
      const status = err instanceof CinnaApiError ? err.status : undefined
      if (status === 404 || status === 403) {
        available = false
        if (!missingRoutesLogged.has(host)) {
          missingRoutesLogged.add(host)
          logger.info('team library not available on this instance; treating it as empty', { status })
        }
      } else {
        throw err
      }
    }
    // This instance, answering this profile's session, says where its git is.
    for (const agent of agents) libraryTrust.learn(host, agent.cloneUrl)
    // A refresh that started after this one has already answered: the cache
    // is newer than this listing, and still no older than this call's start.
    const newer = cache.get(userId)
    if ((applied.get(userId) ?? 0) > seq && newer && newer.host === host) return newer
    const listing: CachedListing = { host, agents, fetchedAt: new Date(), available }
    applied.set(userId, seq)
    const before = signature(cache.get(userId))
    cache.set(userId, listing)
    if (signature(listing) !== before) publishEvent(SHARING_CHANGED_CHANNEL)
    return listing
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
