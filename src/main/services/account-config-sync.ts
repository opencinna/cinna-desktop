/**
 * Periodic runner for account-config sync. The fetch + DB upsert/prune live in
 * {@link accountConfigService.syncAccountConfig}; this module owns the timer,
 * the one-shot trigger used at activation, and the renderer broadcast — directly
 * mirroring `agents/remote-sync.ts`.
 */
import { accountConfigService } from './accountConfigService'
import { CinnaReauthRequired } from '../auth/cinna-oauth'
import { getMainWindow } from '../index'
import { createLogger } from '../logger/logger'

const logger = createLogger('account-config-sync')

const SYNC_INTERVAL_MS = 5 * 60 * 1000 // 5 minutes

let syncInterval: ReturnType<typeof setInterval> | null = null

export type AccountConfigSyncError = 'reauth_required' | 'sync_failed'

export interface AccountConfigSyncCompletePayload {
  error?: AccountConfigSyncError
}

/**
 * Broadcast `providers:account-config-synced` so `useProviders` / `useChatModes`
 * invalidate their caches. Exported so the on-demand sync + the managed
 * enable/disable IPC handlers notify identically to this periodic runner.
 */
export function notifyAccountConfigSynced(
  payload: AccountConfigSyncCompletePayload = {}
): void {
  const win = getMainWindow()
  if (win && !win.isDestroyed()) {
    win.webContents.send('providers:account-config-synced', payload)
  }
}

/** Run a single account-config sync pass and notify the renderer on completion. */
export async function runAccountConfigSyncOnce(userId: string): Promise<void> {
  try {
    await accountConfigService.syncAccountConfig(userId)
    notifyAccountConfigSynced()
  } catch (err) {
    if (err instanceof CinnaReauthRequired) {
      logger.error('account-config sync stopped: Cinna re-auth required', { userId })
      stopAccountConfigPeriodicSync()
      notifyAccountConfigSynced({ error: 'reauth_required' })
      return
    }
    logger.warn('account-config sync failed', { error: String(err) })
    notifyAccountConfigSynced({ error: 'sync_failed' })
  }
}

/** Start periodic account-config sync for a user. Stops any existing interval first. */
export function startAccountConfigPeriodicSync(userId: string): void {
  stopAccountConfigPeriodicSync()
  syncInterval = setInterval(() => {
    void runAccountConfigSyncOnce(userId)
  }, SYNC_INTERVAL_MS)
}

/** Stop periodic account-config sync. */
export function stopAccountConfigPeriodicSync(): void {
  if (syncInterval) {
    clearInterval(syncInterval)
    syncInterval = null
  }
}
