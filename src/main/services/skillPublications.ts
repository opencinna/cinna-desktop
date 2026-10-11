/**
 * Where a kit agent's own skills were shared (catalog U8), folded into the
 * agent DTO at read time: `publications.json` `skills[]` says which of them
 * went to the active account's catalog and as which version, and the cached
 * listing says whether this person may add a new version. Applied beside
 * `withCatalogSkillUpdates`, not in the (cached) folder scan, because the
 * account and the listing move without any file in the folder changing.
 *
 * Kept apart from `skillPublishService` so `localAgentService` can import it
 * without an import cycle.
 *
 * Core: no Electron; files and the cached listing only, no network.
 */

import { getProfileScopeUserId } from '../auth/scope'
import { readSkillPublications } from '../kit/publications'
import { libraryService } from './libraryService'
import { activeListing, changeableFromLink } from './catalogSkillUpdates'
import type { LocalAgentDto } from '../../shared/localAgents'

const sameOrigin = (a: string, b: string): boolean => a.replace(/\/+$/, '') === b.replace(/\/+$/, '')

/**
 * `shared` (with the person's `access` to the package, from the cached
 * listing) and `shareable` on every authored skill row. Share is offered on a
 * deliverable skill while a Cinna account is active and the person may change
 * the agent (`changeableFromLink`: never in a team agent they may only use,
 * where a share would write `SKILL.md` and `publications.json` they cannot
 * send back); once the skill has an
 * entry for that account's server, a new version is offered only when the
 * cached listing gives the person `edit` or `maintain` on its package.
 * An agent without authored rows comes back as it was. Never throws.
 */
export function withSkillPublications(agent: LocalAgentDto): LocalAgentDto {
  const rows = agent.skills
  if (!rows || !rows.some((row) => row.source === 'authored')) return agent
  try {
    const profile = getProfileScopeUserId()
    const host = libraryService.hostOf(profile)
    const entries = host === null ? [] : readSkillPublications(agent.path).filter((entry) => sameOrigin(entry.platform_url, host))
    const listing = host === null ? null : activeListing(profile)
    const changeable = host !== null && changeableFromLink(agent.path, listing)
    return {
      ...agent,
      skills: rows.map((row) => {
        if (row.source !== 'authored') return row
        const entry = entries.find((candidate) => candidate.name === row.name) ?? null
        const item = entry
          ? listing?.items.find(
              (candidate) => candidate.kind === 'skill' && candidate.uuid.toLowerCase() === entry.package_uuid.toLowerCase()
            )
          : undefined
        // The listing's access is what the row's Who can use offers on (`maintain`).
        const shared = entry
          ? {
              packageUuid: entry.package_uuid,
              packageId: entry.package_id,
              revisionNumber: entry.revision_number,
              access: item?.access ?? null
            }
          : null
        let shareable = changeable && row.deliverable
        if (shareable && shared) shareable = item?.access === 'edit' || item?.access === 'maintain'
        return { ...row, shared, shareable }
      })
    }
  } catch {
    return agent
  }
}
