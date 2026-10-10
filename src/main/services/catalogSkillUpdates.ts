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
import { CATALOG_ISSUE_MESSAGES } from '../kit/skills'
import { catalogSkillCache, instanceKey } from './catalogSkillCache'
import type { LocalAgentDto, LocalAgentSkill } from '../../shared/localAgents'
import type { UpdateAvailableInboxItem } from '../../shared/inbox'

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
 * The `catalog_unavailable` warning for a row whose package the listing no
 * longer has: only on an agent no team tracks (a tracked one reaches its pins
 * through the team's version, U7, never through the person's listing), only
 * from a listing that actually loaded, and only while the cached copy is
 * here — a row not on this computer keeps its own state, and Try again says
 * why. A warning: the copy stays deliverable, and it is no validator finding.
 * Only for a copy cached under the listing's own server (`instance`): a
 * lookup falls back to other instances, and a copy fetched under another
 * profile's server says nothing about this listing.
 */
function withUnavailableWarning(row: LocalAgentSkill, instance: string): LocalAgentSkill {
  const issues = row.issues ?? []
  if (issues.some((issue) => issue.code === 'not_downloaded' || issue.code === 'download_failed' || issue.code === 'catalog_unavailable')) {
    return row
  }
  if (catalogSkillCache.instanceOfPath(row.path) !== instance) return row
  return {
    ...row,
    issues: [...issues, { code: 'catalog_unavailable', message: CATALOG_ISSUE_MESSAGES.catalog_unavailable, severity: 'warning' }]
  }
}

/**
 * `latestRevision` (with its `latestVersion` label) and the skill's catalog
 * `title` from the active profile's cached listing on every catalog row, and `updatable` when it is past the pin and the person may change the
 * agent; and {@link withUnavailableWarning} on a row the listing no longer
 * has. An agent without catalog rows comes back as it was. Never throws.
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
    const absenceCounts = listing !== null && listing.available === true && !linkedEntry(agent.path, listing).linked
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
        return absenceCounts && listingInstance !== null && !skills.has(key) ? withUnavailableWarning(folded, listingInstance) : folded
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
