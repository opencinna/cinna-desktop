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

import { join } from 'node:path'
import { getProfileScopeUserId } from '../auth/scope'
import { readSkillPublications, type SkillPublication } from '../kit/publications'
import { SKILLS_DIR } from '../kit/skills'
import { collectSkillTree, skillTreeHash, skillTreeStamp } from '../kit/skillPack'
import { libraryService } from './libraryService'
import { activeListing, changeableFromLink } from './catalogSkillUpdates'
import type { CatalogItem } from '../../shared/catalogItems'
import type { LocalAgentDto, LocalAgentSkillLatest, LocalAgentSkillSync } from '../../shared/localAgents'

const sameOrigin = (a: string, b: string): boolean => a.replace(/\/+$/, '') === b.replace(/\/+$/, '')

/**
 * Tree hashes of linked skill folders, per folder, kept against
 * {@link skillTreeStamp} (newest mtime, total size and file count over the
 * tree): a DTO read re-stats the tree, and reads the files only when it moved.
 */
const hashes = new Map<string, { stamp: string; hash: string }>()

/**
 * The tree hash of `skills/<name>/` as core computes it (`skillTreeHash`), or
 * null when the folder cannot be read whole (a link, a secret-looking file,
 * an unreadable file). `fresh` skips the cache — a verb about to replace the
 * folder decides on the bytes, not on a stat.
 */
export function folderTreeHash(skillDir: string, name: string, fresh = false): string | null {
  const stamp = fresh ? null : skillTreeStamp(skillDir)
  const known = stamp === null ? undefined : hashes.get(skillDir)
  if (known && known.stamp === stamp) return known.hash
  const tree = collectSkillTree(skillDir)
  if (!tree.ok) {
    hashes.delete(skillDir)
    return null
  }
  const hash = skillTreeHash(name, tree.tree.files)
  if (stamp !== null) hashes.set(skillDir, { stamp, hash })
  return hash
}

/** Forget every cached hash (tests). */
export function _resetSkillHashes(): void {
  hashes.clear()
}

/** The package's latest version as the listing item gives it, or null. */
export function latestOf(item: CatalogItem | null | undefined): LocalAgentSkillLatest | null {
  const number = item?.latest?.revision_number
  if (!item || typeof number !== 'number' || !Number.isInteger(number) || number < 1) return null
  const version = typeof item.latest?.version === 'string' && item.latest.version.trim() !== '' ? item.latest.version.trim() : null
  const by = item.latest?.published_by?.display_name
  return { revisionNumber: number, version, publishedBy: typeof by === 'string' && by.trim() !== '' ? by.trim() : null }
}

/**
 * Where a linked folder stands (S4): `changed` when its tree hash is not the
 * recorded `content_hash` (S3: the hash of the version it holds), `behind`
 * when the listing's latest is past the recorded `revision_number`, both
 * `diverged`, neither `in_sync`; `unknown` when the listing has no latest for
 * the package or the folder cannot be hashed.
 */
export function syncOf(
  skillDir: string,
  entry: Pick<SkillPublication, 'name' | 'revision_number' | 'content_hash'>,
  item: CatalogItem | null | undefined,
  fresh = false
): { sync: LocalAgentSkillSync; latest: LocalAgentSkillLatest | null } {
  const latest = latestOf(item)
  if (latest === null) return { sync: 'unknown', latest: null }
  const hash = folderTreeHash(skillDir, entry.name, fresh)
  if (hash === null) return { sync: 'unknown', latest }
  const changed = hash !== entry.content_hash.trim().toLowerCase()
  const behind = latest.revisionNumber > entry.revision_number
  return { sync: changed ? (behind ? 'diverged' : 'changed') : behind ? 'behind' : 'in_sync', latest }
}

/**
 * `shared` (with the person's `access` to the package, from the cached
 * listing) and `shareable` on every authored skill row. Share is offered on a
 * deliverable skill while a Cinna account is active and the person may change
 * the agent (`changeableFromLink`: never in a team agent they may only use,
 * where a share would write `SKILL.md` and `publications.json` they cannot
 * send back); once the skill has an
 * entry for that account's server, a new version is offered only when the
 * cached listing gives the person `edit` or `maintain` on its package.
 * A row with an entry also gets its sync state and the package's `latest`
 * ({@link syncOf}). An agent without authored rows comes back as it was.
 * Never throws.
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
        if (!entry) return { ...row, shared, shareable }
        return { ...row, shared, shareable, ...syncOf(join(agent.path, SKILLS_DIR, row.name), entry, item) }
      })
    }
  } catch {
    return agent
  }
}
