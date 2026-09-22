import { publishEvent } from '../host/events'
/**
 * Periodic runner for remote agent sync. The transactional upsert/prune and
 * fetch logic live in {@link agentService.syncRemoteAgents}; this module only
 * owns the timer and the one-shot trigger used at activation.
 */
import { agentService } from '../services/agentService'
import { CinnaReauthRequired } from './../auth/cinna-oauth'
import { createLogger } from '../logger/logger'

const logger = createLogger('remote-sync')

const SYNC_INTERVAL_MS = 5 * 60 * 1000 // 5 minutes

let generation = 0
let pending: Promise<void> | null = null
let syncInterval: ReturnType<typeof setInterval> | null = null

export type RemoteSyncError = 'reauth_required' | 'sync_failed'

export interface RemoteSyncCompletePayload {
  error?: RemoteSyncError
}

/**
 * Broadcast `agents:remote-sync-complete` to the renderer so `useAgents`
 * invalidates `['agents']` and mirrors the sync error into the shared
 * sync-status cache. Exported so the on-demand `agent:sync-remote` IPC handler
 * notifies identically to this periodic runner — otherwise a renderer-triggered
 * sync (install/uninstall/bundle-update refresh) writes the DB but never tells
 * the renderer to refetch, leaving stale agent rows on screen.
 */
export function notifyRemoteSyncComplete(payload: RemoteSyncCompletePayload = {}): void {
  publishEvent('agents:remote-sync-complete', payload)
}

/**
 * Run a single sync pass and notify the renderer on completion.
 * Stops the periodic timer on re-auth-required so we don't hammer a revoked token.
 */
export async function runSyncOnce(userId: string): Promise<void> {
  const epoch = generation
  if (pending) await pending.catch(() => {})
  if (epoch !== generation) return
  const current = () => epoch === generation
  const operation = (async () => {
  try {
    await agentService.syncRemoteAgents(userId, current)
    if (!current()) return
    notifyRemoteSyncComplete()
  } catch (err) {
    if (!current()) return
    if (err instanceof CinnaReauthRequired) {
      logger.error('sync stopped: Cinna re-auth required', { userId })
      stopPeriodicSync()
      notifyRemoteSyncComplete({ error: 'reauth_required' })
      return
    }
    logger.warn('remote sync failed', { error: String(err) })
    notifyRemoteSyncComplete({ error: 'sync_failed' })
  }
  })()
  pending = operation
  try { await operation } finally { if (pending === operation) pending = null }
}

/** Start periodic sync for a user. Stops any existing interval first. */
export function startPeriodicSync(userId: string): void {
  stopPeriodicSync()
  syncInterval = setInterval(() => {
    void runSyncOnce(userId)
  }, SYNC_INTERVAL_MS)
}

/** Stop periodic sync. */
export function stopPeriodicSync(): void {
  generation++
  if (syncInterval) {
    clearInterval(syncInterval)
    syncInterval = null
  }
}
