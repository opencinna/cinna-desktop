/**
 * The cloud agents' "Update available" card follows the catalog listing.
 *
 * The card is drawn from a synced agent's `bundle_version`, which only the
 * remote agents' sync writes (at activation and every five minutes). The
 * catalog listing, which moves sooner (a catalog opening, a sharing action,
 * its own poll), already knows an installed cloud agent's latest revision. So
 * when a listing that moved says one of this profile's cloud installs has a
 * revision newer than its synced row knows of, the sync runs once — through
 * {@link runSyncOnce}, whose in-flight guard it shares with the timer — and the
 * Inbox's own poll shows the card from there.
 *
 * Never a loop: one sync per profile at a time, and a revision already asked
 * about for an install is not asked about again, so a server whose
 * `bundle_version` lags the listing costs one sync per new revision.
 */
import { agentRepo } from '../db/agents'
import { libraryService, type CachedListing } from '../services/libraryService'
import { runSyncOnce } from './remote-sync'
import { getProfileScopeUserId } from '../auth/scope'
import { createLogger } from '../logger/logger'

const logger = createLogger('remote-sync')

/** Per profile: the newest revision a sync was already run for, per install id. */
const asked = new Map<string, Map<string, number>>()
/** Profiles with a follow-up sync queued or running. */
const running = new Set<string>()
let unsubscribe: (() => void) | null = null

/**
 * The install ids (with the listing's latest revision) of this profile's cloud
 * agents whose synced row is behind the listing and not yet asked about.
 */
function behindInstalls(userId: string, listing: CachedListing): Map<string, number> {
  const latestByInstall = new Map<string, number>()
  for (const item of listing.items) {
    if (item.kind !== 'agent' || item.runs_on === 'desktop') continue
    const latest = item.latest?.revision_number
    if (typeof latest !== 'number' || !Array.isArray(item.my_installs)) continue
    for (const install of item.my_installs) {
      if (install?.where === 'cloud' && install.install_id) latestByInstall.set(install.install_id, latest)
    }
  }
  const behind = new Map<string, number>()
  if (latestByInstall.size === 0) return behind
  const already = asked.get(userId)
  for (const row of agentRepo.listRemote(userId)) {
    const installId = row.remoteTargetId
    const latest = installId ? latestByInstall.get(installId) : undefined
    if (!installId || latest === undefined) continue
    const version = row.remoteMetadata?.bundle_version
    // A server that sends no version state draws no card: nothing to fetch for.
    if (!version) continue
    const known = version.latest_revision_number ?? version.installed_revision_number ?? 0
    if (latest <= known) continue
    if ((already?.get(installId) ?? -1) >= latest) continue
    behind.set(installId, latest)
  }
  return behind
}

/** Profiles whose listing moved while their follow-up sync ran: looked at again when it ends. */
const again = new Set<string>()
/**
 * The profile whose listings were last followed. A profile's first listing after
 * it becomes active is not followed: its activation sync runs beside it and
 * reads the same server, so a second sync would only repeat it.
 */
let followed: string | null = null

/** Only the active profile's listing: one that lands after a switch must not sync the profile left behind. */
function isActive(userId: string): boolean {
  try {
    return getProfileScopeUserId() === userId
  } catch {
    return false
  }
}

/** Decide on one landed listing; exported for tests. */
export function followListing(userId: string, listing: CachedListing): void {
  if (!isActive(userId)) return
  if (followed !== userId) {
    followed = userId
    return
  }
  if (running.has(userId)) {
    again.add(userId)
    return
  }
  const behind = behindInstalls(userId, listing)
  if (behind.size === 0) return
  const memo = asked.get(userId) ?? new Map<string, number>()
  // Remembered before the sync answers: a failed sync is not retried from here, and
  // the periodic sync (five minutes) still brings the card, late but not lost.
  for (const [installId, revision] of behind) memo.set(installId, revision)
  asked.set(userId, memo)
  running.add(userId)
  logger.info('catalog lists a newer cloud agent version; syncing remote agents', { installs: behind.size })
  void runSyncOnce(userId).finally(() => {
    running.delete(userId)
    if (!again.delete(userId) || !isActive(userId)) return
    // Against the rows the sync just wrote; the memo keeps this from repeating.
    const latest = libraryService.cached(userId)
    if (latest) followListing(userId, latest)
  })
}

/** Installed once at boot by `hub/core.ts`. */
export function installCloudUpdateFollow(): void {
  unsubscribe?.()
  unsubscribe = libraryService.onListingChanged(followListing)
}

/** Tests only. */
export function _resetCloudUpdateFollow(): void {
  unsubscribe?.()
  unsubscribe = null
  asked.clear()
  running.clear()
  again.clear()
  followed = null
}
