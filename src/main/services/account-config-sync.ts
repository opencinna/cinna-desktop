import { publishEvent } from '../host/events'
/**
 * Periodic runner for account-config sync. The fetch + DB upsert/prune live in
 * {@link accountConfigService.syncAccountConfig}; this module owns the timer,
 * the one-shot trigger used at activation, and the renderer broadcast — directly
 * mirroring `agents/remote-sync.ts`.
 */
import { accountConfigService } from './accountConfigService'
import { brandThemeService } from './brandTheme/brandThemeService'
import { CinnaReauthRequired } from '../auth/cinna-oauth'
import { createLogger } from '../logger/logger'

const logger = createLogger('account-config-sync')

const SYNC_INTERVAL_MS = 5 * 60 * 1000 // 5 minutes

let generation = 0
let pending: Promise<void> | null = null
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
  publishEvent('providers:account-config-synced', payload)
}

/** Run a single account-config sync pass and notify the renderer on completion. */
export async function runAccountConfigSyncOnce(userId: string): Promise<void> {
  const epoch = generation
  if (pending) await pending.catch(() => {})
  if (epoch !== generation) return
  const current = () => epoch === generation
  const operation = (async () => {
  try {
    await accountConfigService.syncAccountConfig(userId, current)
    if (!current()) return
    // After the sync, which may just have made the managed default; before the
    // notification, so the renderer's refetch sees the colour.
    brandThemeService.adoptDefaultMode(userId)
    notifyAccountConfigSynced()
  } catch (err) {
    if (!current()) return
    // A cached brand still counts with the server unreachable.
    brandThemeService.adoptDefaultMode(userId)
    if (err instanceof CinnaReauthRequired) {
      logger.error('account-config sync stopped: Cinna re-auth required', { userId })
      stopAccountConfigPeriodicSync()
      notifyAccountConfigSynced({ error: 'reauth_required' })
      return
    }
    logger.warn('account-config sync failed', { error: String(err) })
    notifyAccountConfigSynced({ error: 'sync_failed' })
  }
  })()
  pending = operation
  try { await operation } finally { if (pending === operation) pending = null }
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
  generation++
  if (syncInterval) {
    clearInterval(syncInterval)
    syncInterval = null
  }
}
