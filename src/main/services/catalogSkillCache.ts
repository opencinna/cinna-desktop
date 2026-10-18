/**
 * The shared cache of catalog skills a local agent pins (catalog U6):
 * `<userData>/catalog-skills/<instance>/<package_uuid>/<revision_number>/<name>/`.
 *
 * * **Shared across agents.** Two agents pinning one revision use one folder;
 *   nothing in it is an agent's.
 * * **Read-only.** Files 0444 (0555 when the archive marked them executable),
 *   folders 0555 — an engine or an assistant reading a skill cannot edit the
 *   copy every other agent uses.
 * * **Complete or absent.** A revision is unpacked into a staging folder
 *   beside it, with a marker naming what it holds
 *   (`.cinna-catalog-skill.json`: uuid, name, revision, `archive_sha256`),
 *   and renamed into place in one step. A revision folder without a marker
 *   that matches the pin is not a cached skill.
 * * **Per instance.** `<instance>` is a filesystem-safe key of the Cinna
 *   server ({@link instanceKey}). A lookup prefers the active profile's
 *   instance and then tries the others — a pin names a package uuid and the
 *   archive digest, not a server, and an agent folder is not tied to one
 *   profile — but only a marker whose digest equals the pin's counts.
 *
 * The last failed download of each pin (revision and digest) is kept in memory for the
 * Skills section's issue; a restart forgets it. Revisions no agent pins any
 * more are removed once per app start ({@link catalogSkillCache.collectGarbage},
 * driven by `catalogSkillService.collectGarbage`), never right after a Remove
 * or an Update: a running turn may still read the old revision.
 *
 * The folder walking, staging and garbage collection are `pinnedSkillCache.ts`'s,
 * shared with marketplace skills; this module is the catalog's layout and marker.
 *
 * Core: no Electron. Paths come from `runtimeHost`.
 */

import { createPinnedSkillCache, SHA256_RE, UUID_RE, type SafePin } from './pinnedSkillCache'
import { isCatalogPinName, type CatalogSkillRef, type CatalogSkillResolver } from '../kit/skills'

export { instanceKey, removeTree } from './pinnedSkillCache'

export const MARKER_FILE = '.cinna-catalog-skill.json'

/** What a revision folder's marker records. */
export interface CachedRevisionMarker {
  package_uuid: string
  package_id: string
  name: string
  revision_number: number
  archive_sha256: string
}

/** The pin's fields as safe path components, or null when one is not. */
export function cacheRefOf(ref: CatalogSkillRef): { uuid: string; revision: string; name: string; sha: string } | null {
  const uuid = typeof ref.packageUuid === 'string' ? ref.packageUuid.trim().toLowerCase() : ''
  const sha = typeof ref.archiveSha256 === 'string' ? ref.archiveSha256.trim().toLowerCase() : ''
  if (!UUID_RE.test(uuid) || !SHA256_RE.test(sha) || !isCatalogPinName(ref.name)) return null
  if (!Number.isInteger(ref.revisionNumber) || (ref.revisionNumber as number) < 1) return null
  return { uuid, revision: String(ref.revisionNumber), name: ref.name, sha }
}

/**
 * The `uuid/revision` key {@link catalogSkillCache.collectGarbage} keeps a
 * revision by, from a pin as written, or null when it names no usable one.
 * Only the package and the revision: a pin with a digest that does not match
 * still keeps the folder, which the next install moves aside if it must.
 */
export function revisionKeyOf(pin: unknown): string | null {
  if (!pin || typeof pin !== 'object') return null
  const { package_uuid: rawUuid, revision_number: revision } = pin as Record<string, unknown>
  const uuid = typeof rawUuid === 'string' ? rawUuid.trim().toLowerCase() : ''
  if (!UUID_RE.test(uuid) || !Number.isInteger(revision) || (revision as number) < 1) return null
  return `${uuid}/${revision as number}`
}

/**
 * A 404 on a download (U7) for an agent a team tracks: the teammate's copy pins a version the
 * team has moved past.
 */
export const BEHIND_SENTENCE =
  'This version is not available to you. If the agent is shared, update it to the team’s latest version first.'
/** The same 404 for an agent no team tracks: the publisher withdrew the person's access, or the package is gone. */
export const WITHDRAWN_SENTENCE =
  'This skill is no longer available to you — its publisher took away your access or removed it from the catalog.'

/**
 * What a "not available" (404) download means depends on the agent asking, not on the revision:
 * the failure record is shared by every agent that pins the revision, so it keeps only the fact,
 * and each reader words it with its own agent's {@link BEHIND_SENTENCE} or {@link WITHDRAWN_SENTENCE}.
 */
export function notAvailableSentence(teamTracked: boolean): string {
  return teamTracked ? BEHIND_SENTENCE : WITHDRAWN_SENTENCE
}

function safePin(ref: CatalogSkillRef): SafePin | null {
  const safe = cacheRefOf(ref)
  return safe ? { uuid: safe.uuid, key: safe.revision, name: safe.name, sha: safe.sha } : null
}

const cache = createPinnedSkillCache<CatalogSkillRef, { packageId: string }>({
  dir: 'catalog-skills',
  markerFile: MARKER_FILE,
  label: 'catalog skill',
  logger: 'catalog-skill-cache',
  keyField: 'revision',
  keyNoun: 'revisions',
  safe: safePin,
  marker: (safe, ref): Record<string, unknown> => {
    const marker: CachedRevisionMarker = {
      package_uuid: safe.uuid,
      package_id: typeof ref.packageId === 'string' ? ref.packageId : '',
      name: safe.name,
      revision_number: Number(safe.key),
      archive_sha256: safe.sha
    }
    return { ...marker }
  },
  markerMatches: (marker, safe) =>
    String(marker.revision_number) === safe.key &&
    typeof marker.package_uuid === 'string' &&
    marker.package_uuid.toLowerCase() === safe.uuid,
  notAvailableSentence
})

export const catalogSkillCache = {
  ...cache,

  /**
   * {@link catalogSkillCache.resolve} for one agent: a recorded 404 reads as
   * {@link notAvailableSentence}`(teamTracked)` of that agent. What
   * `kit/skills.ts` is handed as its resolver.
   */
  resolverFor(teamTracked: boolean): CatalogSkillResolver {
    return cache.resolverFor(teamTracked)
  },

  /**
   * Whether the last download of a package's revision was refused as not
   * available (404), whichever pin (digest) asked. In memory only: a restart
   * forgets it until the next download is refused again.
   */
  notAvailable(packageUuid: string, revision: number | null): boolean {
    if (typeof revision !== 'number') return false
    return cache.notAvailableAt(packageUuid, String(revision))
  }
}
