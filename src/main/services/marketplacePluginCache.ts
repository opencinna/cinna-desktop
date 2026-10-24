/**
 * The shared cache of marketplace plugins a local agent pins:
 * `<userData>/marketplace-plugins/<instance>/<entry_uuid>/<archive_sha256>/<name>/`
 * — the plugin's tree (its `.claude-plugin/`, `skills/`, `commands/`, `hooks/`,
 * `.mcp.json`, scripts …), as core's snapshot archive holds it.
 *
 * Built on the pinned-skill cache machinery (`pinnedSkillCache.ts`) and with
 * the same properties as the marketplace skills' (`marketplaceSkillCache.ts`):
 * shared across agents, read-only, complete-or-absent through a staging folder
 * and a marker (`.cinna-marketplace-plugin.json`), content-addressed by the
 * snapshot digest. A plugin's MCP servers, hooks and scripts run from here:
 * `${CLAUDE_PLUGIN_ROOT}` is this folder.
 *
 * Folders no agent pins any more are removed once per app start
 * (`marketplacePluginService.collectGarbage`), never right after a Remove.
 *
 * Core: no Electron. Paths come from `runtimeHost`.
 */

import { createHash } from 'node:crypto'
import { lstatSync, readdirSync, readFileSync, type Dirent } from 'node:fs'
import { dirname, join } from 'node:path'
import { createPinnedSkillCache, removeTree, SHA256_RE, UUID_RE, type SafePin } from './pinnedSkillCache'
import { isCatalogPinName, type CatalogSkillCacheState } from '../kit/skills'
import type { SkillArchive } from '../kit/skillArchive'

export const MARKETPLACE_PLUGIN_MARKER_FILE = '.cinna-marketplace-plugin.json'

/** What a plugin pin names, for the cache: the entry, the plugin's name and the snapshot digest. */
export interface MarketplacePluginRef {
  entryUuid: string
  name: string
  archiveSha256: string
}

/** A 404 on a download: the entry is gone, or the person can no longer see its marketplace. */
export const MARKETPLACE_PLUGIN_NOT_AVAILABLE_SENTENCE =
  'This plugin is no longer available to you — it was removed from its marketplace, or you can no longer see the marketplace.'

/** The pin's fields as safe path components, or null when one is not. */
export function marketplacePluginCacheRefOf(ref: MarketplacePluginRef): SafePin | null {
  const uuid = typeof ref.entryUuid === 'string' ? ref.entryUuid.trim().toLowerCase() : ''
  const sha = typeof ref.archiveSha256 === 'string' ? ref.archiveSha256.trim().toLowerCase() : ''
  if (!UUID_RE.test(uuid) || !SHA256_RE.test(sha) || !isCatalogPinName(ref.name)) return null
  return { uuid, key: sha, name: ref.name, sha }
}

/** A pin as written, as a {@link MarketplacePluginRef}. */
export function marketplacePluginRefOf(pin: unknown): MarketplacePluginRef {
  const record = pin && typeof pin === 'object' && !Array.isArray(pin) ? (pin as Record<string, unknown>) : {}
  return {
    entryUuid: typeof record.entry_uuid === 'string' ? record.entry_uuid : '',
    name: typeof record.name === 'string' ? record.name : '',
    archiveSha256: typeof record.archive_sha256 === 'string' ? record.archive_sha256 : ''
  }
}

/** The `entry/sha256` key garbage collection keeps a snapshot by, or null when the pin names no usable one. */
export function pluginSnapshotKeyOf(pin: unknown): string | null {
  const safe = marketplacePluginCacheRefOf(marketplacePluginRefOf(pin))
  return safe ? `${safe.uuid}/${safe.sha}` : null
}

/** Each file of an unpacked plugin, by its POSIX path under the plugin folder: what the marker records at install. */
export type PluginFileDigests = Record<string, { sha256: string; size: number }>

/** The sentence a plugin whose cached tree no longer matches its install reads. */
export const PLUGIN_TREE_MODIFIED_SENTENCE = 'The cached copy was changed on disk — Update to restore it'

/** The digest of every file an archive unpacks to, for the marker. */
export function archiveDigests(archive: SkillArchive): PluginFileDigests {
  return Object.fromEntries(
    archive.files.map((file) => [file.path, { sha256: createHash('sha256').update(file.data).digest('hex'), size: file.data.length }])
  )
}

const cache = createPinnedSkillCache<MarketplacePluginRef, { files: PluginFileDigests }>({
  dir: 'marketplace-plugins',
  markerFile: MARKETPLACE_PLUGIN_MARKER_FILE,
  label: 'marketplace plugin',
  logger: 'marketplace-plugin-cache',
  keyField: 'sha256',
  keyNoun: 'snapshots',
  safe: marketplacePluginCacheRefOf,
  marker: (safe, ref): Record<string, unknown> => ({
    entry_uuid: safe.uuid,
    name: safe.name,
    archive_sha256: safe.sha,
    ...(ref.files ? { files: ref.files } : {})
  }),
  markerMatches: (marker, safe) => typeof marker.entry_uuid === 'string' && marker.entry_uuid.toLowerCase() === safe.uuid,
  notAvailableSentence: () => MARKETPLACE_PLUGIN_NOT_AVAILABLE_SENTENCE
})

/* -------------------------------------------------------------- integrity */

/** A file's stat as last verified: any write, chmod, rename or touch moves one of these. */
type StatKey = string
const statKey = (stat: { size: number; mtimeMs: number; ctimeMs: number; ino: number }): StatKey =>
  `${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}:${stat.ino}`

/** Per plugin folder: the marker's and every file's stat when the tree last hashed clean (this app session). */
const verified = new Map<string, { marker: StatKey; files: Map<string, StatKey> }>()

/** Every regular file under `dir` by POSIX path, with its stat; null when the tree holds a link or anything else. */
function walkTree(dir: string): Map<string, { path: string; key: StatKey; size: number }> | null {
  const found = new Map<string, { path: string; key: StatKey; size: number }>()
  const visit = (abs: string, rel: string): boolean => {
    let list: Dirent[]
    try {
      list = readdirSync(abs, { withFileTypes: true })
    } catch {
      return false
    }
    for (const entry of list) {
      const path = join(abs, entry.name)
      const posix = rel === '' ? entry.name : `${rel}/${entry.name}`
      if (entry.isDirectory()) {
        if (!visit(path, posix)) return false
        continue
      }
      if (!entry.isFile()) return false
      try {
        const stat = lstatSync(path)
        if (!stat.isFile()) return false
        found.set(posix, { path, key: statKey(stat), size: stat.size })
      } catch {
        return false
      }
    }
    return true
  }
  return visit(dir, '') ? found : null
}

function markerDigests(dir: string): { digests: PluginFileDigests; key: StatKey } | null {
  const path = join(dirname(dir), MARKETPLACE_PLUGIN_MARKER_FILE)
  try {
    const stat = lstatSync(path)
    if (!stat.isFile()) return null
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as { files?: unknown }
    const files = parsed && typeof parsed.files === 'object' && parsed.files !== null && !Array.isArray(parsed.files) ? (parsed.files as Record<string, unknown>) : null
    if (!files) return null
    const digests: PluginFileDigests = {}
    for (const [name, value] of Object.entries(files)) {
      const item = value as { sha256?: unknown; size?: unknown } | null
      if (!item || typeof item.sha256 !== 'string' || typeof item.size !== 'number') return null
      digests[name] = { sha256: item.sha256, size: item.size }
    }
    return { digests, key: statKey(stat) }
  } catch {
    return null
  }
}

/**
 * Whether the cached plugin folder `dir` is still exactly what was unpacked:
 * the same files (no file added or removed, no link), each with the digest
 * the marker recorded at install. Cheap after the first check of a session —
 * a file whose stat (size, mtime, ctime, inode) is unchanged since it last
 * hashed clean is not read again; any other is hashed. A marker with no
 * digests (a copy cached before they were recorded) does not verify.
 */
export function verifyPluginTree(dir: string): boolean {
  const marker = markerDigests(dir)
  const files = walkTree(dir)
  if (!marker || !files) {
    verified.delete(dir)
    return false
  }
  const names = Object.keys(marker.digests)
  if (names.length !== files.size || names.some((name) => !files.has(name))) {
    verified.delete(dir)
    return false
  }
  const last = verified.get(dir)
  const clean = new Map<string, StatKey>()
  for (const [name, file] of files) {
    const want = marker.digests[name]
    if (last && last.marker === marker.key && last.files.get(name) === file.key) {
      clean.set(name, file.key)
      continue
    }
    let ok = file.size === want.size
    if (ok) {
      try {
        ok = createHash('sha256').update(readFileSync(file.path)).digest('hex') === want.sha256
      } catch {
        ok = false
      }
    }
    if (!ok) {
      verified.delete(dir)
      return false
    }
    clean.set(name, file.key)
  }
  verified.set(dir, { marker: marker.key, files: clean })
  return true
}

const resolve = cache.resolve as (ref: MarketplacePluginRef) => CatalogSkillCacheState

export const marketplacePluginCache = {
  ...cache,
  resolve,

  /** Remove the cached copy of `ref` wherever it is (an Update that restores a changed tree downloads it again). */
  discard(ref: MarketplacePluginRef): void {
    const state = resolve(ref)
    if (state.state !== 'ready') return
    verified.delete(state.dir)
    removeTree(dirname(state.dir), 'marketplace plugin')
  },

  /** Tests: forget the integrity checks of this session. */
  _resetIntegrity(): void {
    verified.clear()
  }
}
