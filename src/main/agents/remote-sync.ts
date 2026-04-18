/**
 * Periodic runner for remote agent sync. The transactional upsert/prune and
 * fetch logic live in {@link agentService.syncRemoteAgents}; this module only
 * owns the timer and the one-shot trigger used at activation.
 */
import { agentService } from '../services/agentService'
import { CinnaReauthRequired } from './../auth/cinna-oauth'
import { getMainWindow } from '../index'
import { createLogger } from '../logger/logger'

const logger = createLogger('remote-sync')

const SYNC_INTERVAL_MS = 5 * 60 * 1000 // 5 minutes

let syncInterval: ReturnType<typeof setInterval> | null = null

export type RemoteSyncError = 'reauth_required' | 'sync_failed'

export interface RemoteSyncCompletePayload {
  error?: RemoteSyncError
}

function notifyRenderer(payload: RemoteSyncCompletePayload = {}): void {
  const win = getMainWindow()
  if (win && !win.isDestroyed()) {
    win.webContents.send('agents:remote-sync-complete', payload)
  }
}

/**
 * Run a single sync pass and notify the renderer on completion.
 * Stops the periodic timer on re-auth-required so we don't hammer a revoked token.
 */
export async function runSyncOnce(userId: string): Promise<void> {
  try {
    await agentService.syncRemoteAgents(userId)
    notifyRenderer()
  } catch (err) {
    if (err instanceof CinnaReauthRequired) {
      logger.error('sync stopped: Cinna re-auth required', { userId })
      stopPeriodicSync()
      notifyRenderer({ error: 'reauth_required' })
      return
    }
    logger.warn('remote sync failed', { error: String(err) })
    notifyRenderer({ error: 'sync_failed' })
  }
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
  if (syncInterval) {
    clearInterval(syncInterval)
    syncInterval = null
  }
}
