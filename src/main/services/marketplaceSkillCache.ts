/**
 * The shared cache of marketplace skills a local agent pins:
 * `<userData>/marketplace-skills/<instance>/<entry_uuid>/<archive_sha256>/<name>/`.
 *
 * The same properties as the catalog's (`pinnedSkillCache.ts`): shared across
 * agents, read-only, complete-or-absent through a staging folder and a marker
 * (`.cinna-marketplace-skill.json`: entry uuid, name, `archive_sha256`), a
 * lookup that prefers the active profile's instance, and a marker digest that
 * must equal the pin's. A pin is content-addressed, so the digest is the
 * folder: a re-pin to the entry's next snapshot is a new folder beside the old.
 *
 * Folders no agent pins any more are removed once per app start
 * (`marketplaceSkillService.collectGarbage`), never right after a Remove or an
 * Update: a running turn may still read the old snapshot.
 *
 * Core: no Electron. Paths come from `runtimeHost`.
 */

import { createPinnedSkillCache, SHA256_RE, UUID_RE, type SafePin } from './pinnedSkillCache'
import { isCatalogPinName, type MarketplaceSkillRef, type MarketplaceSkillResolver } from '../kit/skills'

export const MARKETPLACE_MARKER_FILE = '.cinna-marketplace-skill.json'

/** What a snapshot folder's marker records. */
export interface CachedSnapshotMarker {
  entry_uuid: string
  name: string
  archive_sha256: string
}

/** A 404 on a download: the entry is gone, or the person can no longer see its marketplace. */
export const MARKETPLACE_NOT_AVAILABLE_SENTENCE =
  'This skill is no longer available to you — it was removed from its marketplace, or you can no longer see the marketplace.'

/** The pin's fields as safe path components, or null when one is not. */
export function marketplaceCacheRefOf(ref: MarketplaceSkillRef): SafePin | null {
  const uuid = typeof ref.entryUuid === 'string' ? ref.entryUuid.trim().toLowerCase() : ''
  const sha = typeof ref.archiveSha256 === 'string' ? ref.archiveSha256.trim().toLowerCase() : ''
  if (!UUID_RE.test(uuid) || !SHA256_RE.test(sha) || !isCatalogPinName(ref.name)) return null
  return { uuid, key: sha, name: ref.name, sha }
}

/**
 * The `entry/sha256` key garbage collection keeps a snapshot by, from a pin as
 * written, or null when it names no usable one.
 */
export function snapshotKeyOf(pin: unknown): string | null {
  if (!pin || typeof pin !== 'object') return null
  const { entry_uuid: rawUuid, archive_sha256: rawSha } = pin as Record<string, unknown>
  const uuid = typeof rawUuid === 'string' ? rawUuid.trim().toLowerCase() : ''
  const sha = typeof rawSha === 'string' ? rawSha.trim().toLowerCase() : ''
  if (!UUID_RE.test(uuid) || !SHA256_RE.test(sha)) return null
  return `${uuid}/${sha}`
}

const cache = createPinnedSkillCache<MarketplaceSkillRef>({
  dir: 'marketplace-skills',
  markerFile: MARKETPLACE_MARKER_FILE,
  label: 'marketplace skill',
  logger: 'marketplace-skill-cache',
  keyField: 'sha256',
  keyNoun: 'snapshots',
  safe: marketplaceCacheRefOf,
  marker: (safe): Record<string, unknown> => {
    const marker: CachedSnapshotMarker = { entry_uuid: safe.uuid, name: safe.name, archive_sha256: safe.sha }
    return { ...marker }
  },
  markerMatches: (marker, safe) => typeof marker.entry_uuid === 'string' && marker.entry_uuid.toLowerCase() === safe.uuid,
  // The sentence does not depend on the agent: a marketplace pin is reached through the
  // person's own visibility of the marketplace, never a team's version.
  notAvailableSentence: () => MARKETPLACE_NOT_AVAILABLE_SENTENCE
})

export const marketplaceSkillCache = {
  ...cache,

  /** What `kit/skills.ts` is handed as its marketplace resolver. */
  resolve: cache.resolve as MarketplaceSkillResolver
}
