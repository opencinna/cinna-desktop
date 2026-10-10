/**
 * Telling cinna-core which team agents this computer holds (catalog U10):
 * after Get, Update and Use the team's version, `POST
 * /catalog/items/{uuid}/local-installs {device_id, revision_number}`; after
 * Remove from this computer, `DELETE …/local-installs/{device_id}`. A catalog
 * skill pinned in a local agent is reported the same way with that agent's
 * manifest id as `host_manifest_id` (`catalogSkillService`).
 *
 * Core uses the rows for install counts, the "N people use this" guard on
 * delete and "who is behind" for maintainers. **Best effort, always**: a
 * report never blocks, delays or fails the verb it follows — the callers do
 * not await it, and every failure is logged here and dropped. This machine's
 * own folders stay the truth about what it holds.
 *
 * ## The device id
 *
 * Core stores `device_id` as sent and keys rows on (person, device, item).
 * The sync device id would not do: it exists only once sync is set up, per
 * profile, and it is what decides write authority over a task run. So this
 * install keeps its own: a random UUID, written once to
 * `<userData>/catalog-device.json` and never changed after. It names this
 * installation, nothing about the machine or the person.
 *
 * Core module: no Electron import.
 */

import { randomUUID } from 'node:crypto'
import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, writeSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { runtimeHost } from '../host/runtimeHost'
import { createLogger } from '../logger/logger'
import { cinnaFetch } from './cinna-http'
import { CinnaApiError } from '../errors'
import { catalogItemPath, libraryService, type LibraryEntry } from './libraryService'

const logger = createLogger('catalog-local-installs')

let deviceIdMemo: string | null = null
let pathOverride: string | null = null

function filePath(): string | null {
  if (pathOverride) return pathOverride
  try {
    return join(runtimeHost.getPath('userData'), 'catalog-device.json')
  } catch {
    return null
  }
}

function save(path: string, id: string): void {
  try {
    mkdirSync(dirname(path), { recursive: true })
    const temp = `${path}.${process.pid}.${Date.now()}.tmp`
    const fd = openSync(temp, 'w')
    try {
      writeSync(fd, `${JSON.stringify({ deviceId: id }, null, 2)}\n`)
      fsyncSync(fd)
    } finally {
      closeSync(fd)
    }
    renameSync(temp, path)
  } catch (err) {
    // Kept in memory for this run; the next run mints another, which core
    // reads as one more device — a count off by one, never a failed verb.
    logger.warn('could not save the catalog device id', { error: String(err) })
  }
}

/** The `/git/<repo_id>.git` id in a git URL, or null. */
function repoIdOf(originUrl: string): string | null {
  try {
    const match = new URL(originUrl).pathname.match(/\/git\/([^/]+)\.git\/?$/)
    return match ? decodeURIComponent(match[1]) : null
  } catch {
    return null
  }
}

/**
 * Which version of `entry` a folder at `headSha` is: the latest when it is the
 * team's head, else the version shared at exactly that point (the item's
 * revisions, by `git_commit_sha`). Null when none matches — a folder with
 * changes of its own on top, say — and then nothing is reported.
 */
async function revisionAt(profile: string, entry: LibraryEntry, headSha: string): Promise<number | null> {
  if (entry.latest && entry.headSha !== '' && headSha === entry.headSha) return entry.latest.number
  const body = await cinnaFetch<{ revisions?: unknown }>(profile, catalogItemPath(entry.uuid))
  const revisions = Array.isArray(body?.revisions) ? body.revisions : []
  for (const raw of revisions) {
    if (!raw || typeof raw !== 'object') continue
    const row = raw as Record<string, unknown>
    if (row.git_commit_sha === headSha && typeof row.revision_number === 'number') return row.revision_number
  }
  return null
}

export const catalogLocalInstalls = {
  /** This installation's id for core's local-install rows; minted and saved on first use. */
  deviceId(): string {
    if (deviceIdMemo) return deviceIdMemo
    const path = filePath()
    if (path !== null) {
      try {
        const parsed = JSON.parse(readFileSync(path, 'utf8')) as { deviceId?: unknown }
        if (typeof parsed.deviceId === 'string' && parsed.deviceId.length > 0 && parsed.deviceId.length <= 128) {
          deviceIdMemo = parsed.deviceId
          return deviceIdMemo
        }
      } catch {
        /* none yet, or unreadable: mint one */
      }
    }
    deviceIdMemo = randomUUID()
    if (path !== null) save(path, deviceIdMemo)
    return deviceIdMemo
  },

  /**
   * Report that this computer now holds `entry` at `headSha` (after Get,
   * Update, Use the team's version). Skipped when the version cannot be told.
   * Never throws.
   */
  async reportInstalled(profile: string, entry: LibraryEntry, headSha: string | null): Promise<void> {
    try {
      if (!headSha) return
      const revision = await revisionAt(profile, entry, headSha)
      if (revision === null) {
        logger.info('local install not reported: this folder is not at a shared version', { uuid: entry.uuid })
        return
      }
      await cinnaFetch(profile, `${catalogItemPath(entry.uuid)}/local-installs`, {
        method: 'POST',
        body: { device_id: catalogLocalInstalls.deviceId(), revision_number: revision }
      })
    } catch (err) {
      logger.warn('local install could not be reported', { uuid: entry.uuid, error: describe(err) })
    }
  },

  /** Report that this computer no longer holds `entry` (Remove from this computer). Never throws. */
  async reportRemoved(profile: string, entry: Pick<LibraryEntry, 'uuid'>): Promise<void> {
    try {
      await cinnaFetch(
        profile,
        `${catalogItemPath(entry.uuid)}/local-installs/${encodeURIComponent(catalogLocalInstalls.deviceId())}`,
        { method: 'DELETE' }
      )
    } catch (err) {
      // A 204 has no JSON body: the removal happened.
      if (err instanceof CinnaApiError && err.code === 'invalid_response') return
      logger.warn('local removal could not be reported', { uuid: entry.uuid, error: describe(err) })
    }
  },

  /**
   * Report that this computer holds a catalog skill's revision in the local
   * agent whose manifest id is `hostManifestId` (core requires it for a
   * skill). Repeat calls move the revision. Never throws.
   */
  async reportSkillInstalled(profile: string, packageUuid: string, revisionNumber: number, hostManifestId: string): Promise<void> {
    try {
      await cinnaFetch(profile, `${catalogItemPath(packageUuid)}/local-installs`, {
        method: 'POST',
        body: { device_id: catalogLocalInstalls.deviceId(), revision_number: revisionNumber, host_manifest_id: hostManifestId }
      })
    } catch (err) {
      logger.warn('skill local install could not be reported', { uuid: packageUuid, error: describe(err) })
    }
  },

  /** Report that the local agent `hostManifestId` no longer pins the skill. Never throws. */
  async reportSkillRemoved(profile: string, packageUuid: string, hostManifestId: string): Promise<void> {
    try {
      const device = encodeURIComponent(catalogLocalInstalls.deviceId())
      await cinnaFetch(
        profile,
        `${catalogItemPath(packageUuid)}/local-installs/${device}?host_manifest_id=${encodeURIComponent(hostManifestId)}`,
        { method: 'DELETE' }
      )
    } catch (err) {
      // A 204 has no JSON body: the removal happened.
      if (err instanceof CinnaApiError && err.code === 'invalid_response') return
      logger.warn('skill local removal could not be reported', { uuid: packageUuid, error: describe(err) })
    }
  },

  /**
   * {@link reportRemoved} for a folder that was shared from `originUrl`: the
   * active profile's listed team agent with that repository id, if any.
   * Never throws.
   */
  async reportRemovedByOrigin(profile: string, originUrl: string): Promise<void> {
    try {
      const repoId = repoIdOf(originUrl)
      if (repoId === null) return
      const entry = libraryService.cached(profile)?.agents.find((agent) => agent.repoId === repoId)
      if (entry) await catalogLocalInstalls.reportRemoved(profile, entry)
    } catch (err) {
      logger.warn('local removal could not be reported', { error: describe(err) })
    }
  },

  /** Tests: forget the id, optionally keeping it at a given file. */
  _reset(path: string | null = null): void {
    deviceIdMemo = null
    pathOverride = path
  }
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
