/**
 * The update signal for an agent's catalog skills (catalog U9), folded into
 * the agent DTO at read time: the cached listing moves without any file in
 * the folder changing, so this is applied where `localAgentService` folds in
 * the index row's `enabled`, not in the (cached) folder scan.
 *
 * Kept apart from `catalogSkillService` so `localAgentService` can import it
 * without an import cycle.
 *
 * Core: no Electron; files and the cached listing only, no network.
 */

import { getProfileScopeUserId } from '../auth/scope'
import { libraryService, type CachedListing } from './libraryService'
import { desktopStateService } from './localAgents/desktopStateService'
import { CATALOG_DISCONNECTED_NOT_CACHED, CATALOG_ISSUE_MESSAGES } from '../kit/skills'
import { catalogSkillCache, instanceKey } from './catalogSkillCache'
import type { LocalAgentDto, LocalAgentSkill } from '../../shared/localAgents'
import { disconnectedKey } from '../../shared/inbox'
import type { SkillDisconnectedInboxItem, UpdateAvailableInboxItem } from '../../shared/inbox'

/** A catalog row's code for the Disconnected state: the listing no longer has its package. */
export const DISCONNECTED_CODE = 'catalog_disconnected'

/**
 * Whether each team-tracked agent's folder is behind its team version, as the
 * newest "Update available" read (`sharingService.teamChanges`) found it, by
 * profile and then agent id: a read made under one profile says nothing on
 * another's rows. An agent not in it is not known. Lets the (synchronous) row
 * fold agree with the Inbox's Disconnected card without running git per list.
 */
const teamBehind = new Map<string, { sequence: number; answers: Map<string, boolean> }>()

/** The last {@link beginTeamBehindRead} handed out. */
let teamBehindSequence = 0

/**
 * Start a `teamChanges` read: the sequence its {@link noteTeamBehind} carries,
 * so a read that finishes after a newer one has been applied is dropped.
 */
export function beginTeamBehindRead(): number {
  teamBehindSequence += 1
  return teamBehindSequence
}

/**
 * Record a `teamChanges` read under `profile`: `answers` holds every agent it
 * looked at (true = behind). Replaces what was known for that profile, unless
 * a newer read (higher `sequence`) was already applied there — then nothing
 * changes. Returns the ids whose answer changed (appeared, moved or went), so
 * their rows can be re-read.
 */
export function noteTeamBehind(
  answers: ReadonlyMap<string, boolean>,
  profile: string = getProfileScopeUserId(),
  sequence: number = beginTeamBehindRead()
): string[] {
  const known = teamBehind.get(profile)
  if (known && known.sequence > sequence) return []
  const before = known?.answers ?? new Map<string, boolean>()
  const changed: string[] = []
  for (const [id, behind] of answers) if (before.get(id) !== behind) changed.push(id)
  for (const id of before.keys()) if (!answers.has(id)) changed.push(id)
  teamBehind.set(profile, { sequence, answers: new Map(answers) })
  return changed
}

/** Whether the active profile's newest read found an agent behind its team version; undefined when not known. */
function teamBehindOf(agentId: string): boolean | undefined {
  return teamBehind.get(getProfileScopeUserId())?.answers.get(agentId)
}

/** The active profile's cached listing, or null. Never throws. */
export function activeListing(profile: string = getProfileScopeUserId()): CachedListing | null {
  try {
    return libraryService.cached(profile)
  } catch {
    return null
  }
}

/**
 * The team agent a folder's `shared_remote` link (`app-data/desktop.json`)
 * names: whether it names a Cinna one at all, and the caller's access to it
 * in `listing` (null when the listing does not have it).
 */
export function linkedEntry(dir: string, listing: CachedListing | null): { linked: boolean; access: string | null } {
  let link: ReturnType<typeof desktopStateService.read>['shared_remote'] = null
  try {
    link = desktopStateService.read(dir, 'kit').shared_remote ?? null
  } catch {
    link = null
  }
  if (!link || link.kind !== 'cinna') return { linked: false, access: null }
  const entry = listing?.agents.find(
    (agent) => (link.repo_id && agent.repoId === link.repo_id) || (link.bundle_id && agent.bundleId === link.bundle_id)
  )
  return { linked: true, access: entry?.access ?? null }
}

/**
 * Whether the person may change this agent's pins, from files and the cached
 * listing only — cheap enough for every list. A folder linked to a Cinna team
 * agent counts only with `edit` or `maintain`; the verbs themselves also read
 * the git `origin` (`catalogSkillService`).
 */
export function changeableFromLink(dir: string, listing: CachedListing | null): boolean {
  const linked = linkedEntry(dir, listing)
  return !linked.linked || (linked.access !== null && linked.access !== 'use')
}

/**
 * The `catalog_disconnected` warning ("Disconnected") for a row whose package
 * the listing no longer has — the cached copy is now a local version: only on an agent no team tracks (a tracked one reaches its pins
 * through the team's version, U7, never through the person's listing), only
 * from a listing that actually loaded, and only while the cached copy is
 * here — a row not on this computer keeps its own state, and Try again says
 * why. A warning: the copy stays deliverable, and it is no validator finding.
 * Only for a copy cached under the listing's own server (`instance`): a
 * lookup falls back to other instances, and a copy fetched under another
 * profile's server says nothing about this listing.
 */
function withDisconnectedWarning(row: LocalAgentSkill, instance: string): LocalAgentSkill {
  const issues = row.issues ?? []
  if (issues.some((issue) => issue.code === 'not_downloaded' || issue.code === 'download_failed' || issue.code === DISCONNECTED_CODE)) {
    return row
  }
  if (catalogSkillCache.instanceOfPath(row.path) !== instance) return row
  return {
    ...row,
    issues: [...issues, { code: DISCONNECTED_CODE, message: CATALOG_ISSUE_MESSAGES[DISCONNECTED_CODE], severity: 'warning' }]
  }
}

/** Whether a catalog row's last download failed (its revision is not on this computer). */
function downloadFailed(row: LocalAgentSkill): boolean {
  return (row.issues ?? []).some((issue) => issue.code === 'download_failed')
}

/**
 * The Disconnected state of a pin with no copy on this computer whose
 * download was refused as not available (404): its `download_failed` issue
 * (the WITHDRAWN or BEHIND sentence, with Try again) becomes
 * `catalog_disconnected` with {@link CATALOG_DISCONNECTED_NOT_CACHED}, which
 * offers no Try again — the same state the Inbox card shows
 * ({@link catalogSkillDisconnectedItems}):
 *
 * - an agent no team tracks: the 404 is known, and a loaded listing does not
 *   list the package again (then access may be back, and Try again is how);
 * - a team-tracked agent: the 404 is known, the team agent is in the listing
 *   (`access`), and the last "Update available" read found the folder not
 *   behind it ({@link noteTeamBehind}). Behind, or not known, the row keeps
 *   the BEHIND sentence: updating the agent is the way out.
 */
function withNotCachedDisconnect(
  row: LocalAgentSkill,
  agentId: string,
  link: { linked: boolean; access: string | null },
  listedAgain: boolean
): LocalAgentSkill {
  if (!downloadFailed(row)) return row
  const uuid = (row.packageUuid ?? '').trim().toLowerCase()
  const revision = typeof row.revisionNumber === 'number' ? row.revisionNumber : null
  if (uuid === '' || !catalogSkillCache.notAvailable(uuid, revision)) return row
  if (link.linked ? link.access === null || teamBehindOf(agentId) !== false : listedAgain) return row
  return {
    ...row,
    issues: (row.issues ?? []).map((issue) =>
      issue.code === 'download_failed' ? { code: DISCONNECTED_CODE, message: CATALOG_DISCONNECTED_NOT_CACHED, severity: 'warning' as const } : issue
    )
  }
}

/**
 * `latestRevision` (with its `latestVersion` label) and the skill's catalog
 * `title` from the active profile's cached listing on every catalog row, and `updatable` when it is past the pin and the person may change the
 * agent; {@link withDisconnectedWarning} on a row the listing no longer
 * has, and {@link withNotCachedDisconnect} on a row whose download was
 * refused as not available. An agent without catalog rows comes back as it
 * was. Never throws.
 */
export function withCatalogSkillUpdates(agent: LocalAgentDto): LocalAgentDto {
  const rows = agent.skills
  if (!rows || !rows.some((row) => row.source === 'catalog')) return agent
  try {
    const listing = activeListing()
    const latest = new Map<string, number>()
    const latestLabel = new Map<string, string | null>()
    const titles = new Map<string, string>()
    for (const item of listing?.items ?? []) {
      if (item.kind !== 'skill') continue
      const key = item.uuid.toLowerCase()
      const number = item.latest?.revision_number
      if (typeof number === 'number') {
        latest.set(key, number)
        latestLabel.set(key, item.latest?.version ?? null)
      }
      if (typeof item.display_name === 'string' && item.display_name.trim() !== '') titles.set(key, item.display_name)
    }
    const changeable = changeableFromLink(agent.path, listing)
    // Absence means something only in a listing that loaded, for an agent the person's own grants reach.
    const link = linkedEntry(agent.path, listing)
    const loaded = listing !== null && listing.available === true
    const absenceCounts = loaded && !link.linked
    const listingInstance = typeof listing?.host === 'string' ? instanceKey(listing.host) : null
    const skills = new Set((listing?.items ?? []).filter((item) => item.kind === 'skill').map((item) => item.uuid.toLowerCase()))
    return {
      ...agent,
      skills: rows.map((row) => {
        if (row.source !== 'catalog') return row
        const key = (row.packageUuid ?? '').toLowerCase()
        const latestRevision = latest.get(key) ?? null
        const updatable =
          changeable && latestRevision !== null && typeof row.revisionNumber === 'number' && latestRevision > row.revisionNumber
        const folded = { ...row, title: titles.get(key) ?? null, latestRevision, latestVersion: latestLabel.get(key) ?? null, updatable }
        const warned =
          absenceCounts && listingInstance !== null && !skills.has(key) ? withDisconnectedWarning(folded, listingInstance) : folded
        return withNotCachedDisconnect(warned, agent.id, link, loaded && skills.has(key))
      })
    }
  } catch {
    return agent
  }
}

/**
 * The Inbox's "Update available" items for catalog skills: one per agent and
 * pin whose row is `updatable` (a newer version in the listing, and an agent
 * this person may change — {@link withCatalogSkillUpdates} decided both).
 * Who published that version, and when, comes from the same listing.
 * `agents` are DTOs as `localAgentService.list` answers them. Never throws.
 */
export function catalogSkillUpdateItems(
  agents: readonly LocalAgentDto[],
  listing: CachedListing | null = activeListing()
): UpdateAvailableInboxItem[] {
  try {
    const items = new Map((listing?.items ?? []).filter((item) => item.kind === 'skill').map((item) => [item.uuid.toLowerCase(), item]))
    return agents.flatMap((agent) =>
      (agent.skills ?? []).flatMap((row): UpdateAvailableInboxItem[] => {
        if (row.source !== 'catalog' || !row.updatable || typeof row.latestRevision !== 'number') return []
        const item = items.get((row.packageUuid ?? '').toLowerCase())
        // The label belongs to the version the number names; a listing that moved on since has none for it.
        const sameVersion = item?.latest?.revision_number === row.latestRevision
        const publishedAt = sameVersion && item?.latest?.published_at ? new Date(item.latest.published_at) : null
        return [
          {
            kind: 'update_available',
            target: 'skill',
            agentId: agent.id,
            agentName: agent.name,
            skillName: row.name,
            skillTitle: item?.display_name || row.name,
            pinnedRevision: typeof row.revisionNumber === 'number' ? row.revisionNumber : null,
            version: row.latestRevision,
            versionLabel: sameVersion ? (item?.latest?.version ?? null) : null,
            changedBy: sameVersion ? (item?.latest?.published_by?.display_name ?? null) : null,
            changedAt: publishedAt && !Number.isNaN(publishedAt.getTime()) ? publishedAt : null
          }
        ]
      })
    )
  } catch {
    return []
  }
}


/** Where one pin stands for the Disconnected card. */
type PinConnection = 'disconnected' | 'connected' | 'unknown'

/** Whether a catalog row's revision is on this computer: a path, and no download issue. */
function here(row: LocalAgentSkill): boolean {
  return (
    !!row.path &&
    !(row.issues ?? []).some((issue) => issue.code === 'not_downloaded' || issue.code === 'download_failed')
  )
}

/**
 * The Inbox's "Disconnected" cards for catalog skills, and which dismissals
 * are over. `agents` are DTOs as `localAgentService.list` answers them
 * (already through {@link withCatalogSkillUpdates}).
 *
 * - An agent no team tracks: its row carries the `catalog_disconnected`
 *   issue — the cached copy's warning (`cached`), or, with no copy here, a
 *   download refused as not available (404) while the listing does not have
 *   the package ({@link withCatalogSkillUpdates}). Connected again once a
 *   loaded listing has the package.
 * - An agent a team tracks (U7 — its pins reach the person through the
 *   team's version, never their own listing): only when both facts are
 *   known — the last download of the pinned revision was refused as not
 *   available (404), and the team agent is in the listing and this folder is
 *   not behind it (`behind`, the desktop agents with an "Update available"
 *   card; null when that read failed, so no tracked card). Never `cached`.
 *   Connected again once the revision is on this computer.
 *
 * `clear` names the dismissals whose state is over: the pin connected again,
 * the pin (that revision) gone from its agent, or the agent gone. A pin whose
 * state is not known keeps its dismissal. Never throws.
 */
export function catalogSkillDisconnectedItems(
  agents: readonly LocalAgentDto[],
  options: { listing?: CachedListing | null; behind: ReadonlySet<string> | null; dismissed: ReadonlySet<string> }
): { items: SkillDisconnectedInboxItem[]; clear: string[] } {
  try {
    const listing = options.listing === undefined ? activeListing() : options.listing
    const loaded = listing !== null && listing.available === true
    const listed = new Set((listing?.items ?? []).filter((item) => item.kind === 'skill').map((item) => item.uuid.toLowerCase()))
    const states = new Map<string, PinConnection>()
    const items: SkillDisconnectedInboxItem[] = []
    for (const agent of agents) {
      const rows = (agent.skills ?? []).filter((row) => row.source === 'catalog')
      if (rows.length === 0) continue
      const link = linkedEntry(agent.path, listing)
      const removable = changeableFromLink(agent.path, listing)
      for (const row of rows) {
        const uuid = (row.packageUuid ?? '').trim().toLowerCase()
        if (uuid === '') continue
        const revision = typeof row.revisionNumber === 'number' ? row.revisionNumber : null
        const key = disconnectedKey(agent.id, uuid, revision)
        let state: PinConnection
        if (!link.linked) {
          if ((row.issues ?? []).some((issue) => issue.code === DISCONNECTED_CODE)) state = 'disconnected'
          else if (loaded && listed.has(uuid)) state = 'connected'
          else state = 'unknown'
        } else if (here(row)) {
          state = 'connected'
        } else if (
          link.access !== null &&
          options.behind !== null &&
          !options.behind.has(agent.id) &&
          catalogSkillCache.notAvailable(uuid, revision)
        ) {
          state = 'disconnected'
        } else {
          state = 'unknown'
        }
        // Two pins of one revision in one agent (a duplicate name) are one card.
        if (states.has(key)) continue
        states.set(key, state)
        if (state !== 'disconnected' || options.dismissed.has(key)) continue
        items.push({
          kind: 'skill_disconnected',
          agentId: agent.id,
          agentName: agent.name,
          skillName: row.name,
          skillTitle: row.title || row.name,
          packageUuid: uuid,
          revision,
          removable,
          // A tracked agent's card is only ever for a revision not here.
          cached: here(row)
        })
      }
    }
    const clear = [...options.dismissed].filter((key) => {
      const state = states.get(key)
      return state === undefined || state === 'connected'
    })
    return { items, clear }
  } catch {
    return { items: [], clear: [] }
  }
}
