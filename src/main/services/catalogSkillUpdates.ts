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
import type { LocalAgentDto } from '../../shared/localAgents'

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
 * `latestRevision` from the active profile's cached listing on every catalog
 * row, and `updatable` when it is past the pin and the person may change the
 * agent. An agent without catalog rows comes back as it was. Never throws.
 */
export function withCatalogSkillUpdates(agent: LocalAgentDto): LocalAgentDto {
  const rows = agent.skills
  if (!rows || !rows.some((row) => row.source === 'catalog')) return agent
  try {
    const listing = activeListing()
    const latest = new Map<string, number>()
    for (const item of listing?.items ?? []) {
      const number = item.kind === 'skill' ? item.latest?.revision_number : undefined
      if (typeof number === 'number') latest.set(item.uuid.toLowerCase(), number)
    }
    const changeable = changeableFromLink(agent.path, listing)
    return {
      ...agent,
      skills: rows.map((row) => {
        if (row.source !== 'catalog') return row
        const latestRevision = latest.get((row.packageUuid ?? '').toLowerCase()) ?? null
        const updatable =
          changeable && latestRevision !== null && typeof row.revisionNumber === 'number' && latestRevision > row.revisionNumber
        return { ...row, latestRevision, updatable }
      })
    }
  } catch {
    return agent
  }
}
