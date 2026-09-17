import { create } from 'zustand'
import type { QueryClient } from '@tanstack/react-query'
import { createLogger } from './logger.store'
import { useAuthStore } from './auth.store'
import { useUIStore } from './ui.store'
import { unwrapIpcError } from '../utils/ipcError'
import { unwrapCatalogOutcome, type CatalogInstallResultDto } from '../../../shared/catalog'

const log = createLogger('catalog-install')

/** An install that failed, and which bundle it was for — so it lands in that tile. */
export interface CatalogInstallError {
  bundleId: string
  message: string
}

/** An installed bundle whose credentials are incomplete, waiting for the setup dialog. */
export interface PendingCatalogSetup {
  installId: string
  agentName: string
  /** The profile the install ran under; the dialog hides under any other. */
  profileId: string
}

export type CatalogInstallCompletion = (agentId: string, result: CatalogInstallResultDto) => void

export interface CatalogInstallRequest {
  bundleId: string
  /** The app's query client. It outlives every component, so the install can too. */
  queryClient: QueryClient
  onInstalled: CatalogInstallCompletion
}

interface CatalogInstallStore {
  /** Bundle id whose install is in flight (spinner), or null. */
  installingBundleId: string | null
  /** Last install error (cleared on the next install attempt). */
  error: CatalogInstallError | null
  pendingSetup: PendingCatalogSetup | null
  clearError: () => void
  setPendingSetup: (pending: PendingCatalogSetup | null) => void
  /** Install a bundle, then hand the resulting local agent to `onInstalled`. */
  install: (request: CatalogInstallRequest) => void
}

/**
 * One install at a time, app-wide. Module-level rather than state: a second
 * click in the same tick sees stale state, and the sidebar catalog and the
 * chat picker are separate callers that must never run two installs at once.
 */
let inFlight = false

const activeProfileId = (): string | null => useAuthStore.getState().currentUser?.id ?? null

/**
 * One-click install of a catalog bundle, ending in a local agent id.
 *
 *  1. `catalog.quickInstall` — the server installs the bundle (links any
 *     matching credentials / publisher-provided keys).
 *  2. `agents.syncRemote` — **awaited**, so the new install is in the local
 *     `agents` table before it is read back (the periodic sync is 5 minutes).
 *     It reports failure as data, not by throwing.
 *  3. Invalidate + `fetchQuery(['agents'])`, find `remoteTargetId ===
 *     installId`, and hand its id to `onInstalled`.
 *
 * A store, not component state: the sidebar list that starts an install is
 * unmounted when the user switches sidebar tabs, and the landing must still
 * happen. An install that finishes under a different profile than it started
 * under is dropped — its agent belongs to the other account.
 */
export const useCatalogInstallStore = create<CatalogInstallStore>((set) => ({
  installingBundleId: null,
  error: null,
  pendingSetup: null,
  clearError: () => set({ error: null }),
  setPendingSetup: (pendingSetup) => set({ pendingSetup }),
  install: ({ bundleId, queryClient, onInstalled }) => {
    if (inFlight) return
    inFlight = true
    const profileId = activeProfileId()
    set({ error: null, installingBundleId: bundleId })
    const profileChanged = (): boolean => {
      if (activeProfileId() === profileId) return false
      log.info('profile changed during catalog install; dropping the result', { bundleId })
      return true
    }
    void (async () => {
      try {
        log.info('catalog quick install', { bundleId })
        const result = unwrapCatalogOutcome(await window.api.catalog.quickInstall(bundleId))
        // Unlike `useRefreshCatalogState` (which fires syncRemote
        // fire-and-forget), we must AWAIT the sync so the new install is in
        // the local `agents` table before we read it back.
        const sync = await window.api.agents.syncRemote()
        queryClient.invalidateQueries({ queryKey: ['catalog'] })
        if (profileChanged()) return
        if (!sync.success) {
          const message =
            sync.code === 'reauth_required'
              ? 'Installed, but your Cinna session expired before it could be added — re-authenticate and it will appear.'
              : `Installed, but it could not be added to your agents yet: ${unwrapIpcError(sync.error, 'sync failed.')}`
          log.warn('remote sync failed after catalog install', {
            bundleId,
            installId: result.installId,
            code: sync.code
          })
          set({ error: { bundleId, message } })
          return
        }
        // Cache mutation stays inside React Query's flow — invalidate then
        // fetchQuery — rather than a direct setQueryData that would race the
        // `agents:remote-sync-complete` broadcast's own invalidation.
        queryClient.invalidateQueries({ queryKey: ['agents'] })
        const agents = await queryClient.fetchQuery({
          queryKey: ['agents'],
          queryFn: () => window.api.agents.list()
        })
        if (profileChanged()) return
        const installed = agents.find((a) => a.remoteTargetId === result.installId)
        if (installed) {
          log.info('catalog install complete', {
            bundleId,
            installId: result.installId,
            agentId: installed.id
          })
          onInstalled(installed.id, result)
        } else {
          log.warn('installed bundle not found in agent list after sync', {
            bundleId,
            installId: result.installId
          })
          set({
            error: {
              bundleId,
              message: 'Installed — it will appear in your agents after the next sync.'
            }
          })
        }
      } catch (err) {
        if (profileChanged()) return
        const code = (err as { code?: string } | null)?.code
        const msg = unwrapIpcError(err, 'Install failed.')
        log.error('quick install failed', { bundleId, error: msg })
        set({
          error: {
            bundleId,
            message:
              code === 'reauth_required'
                ? 'Cinna session expired — re-authenticate in Settings to install.'
                : msg.slice(0, 160)
          }
        })
      } finally {
        inFlight = false
        set({ installingBundleId: null })
      }
    })()
  }
}))

/**
 * The sidebar's landing for a finished install. Touches only stores and the
 * query client, so it runs whether or not the list that started it is still
 * mounted: open the agent, then — as Settings → Catalog does — raise the setup
 * dialog (rendered by `CatalogSetupHost`) if its credentials are incomplete. A
 * failed status check counts as needing setup: the dialog polls and offers the
 * server link, which is the way out either way.
 */
export function landCatalogInstall(
  queryClient: QueryClient,
  agentId: string,
  result: CatalogInstallResultDto
): void {
  const profileId = activeProfileId()
  if (profileId === null) return
  const ui = useUIStore.getState()
  ui.setAgentPageMode('chat')
  ui.setActiveExternalAgentId(agentId)
  ui.setActiveView('external-agent')
  void (async () => {
    let ready = false
    try {
      const status = await queryClient.fetchQuery({
        queryKey: ['catalog', 'setup-status', result.installId],
        queryFn: () => window.api.catalog.setupStatus(result.installId)
      })
      ready = status.status === 'ready'
    } catch {
      ready = false
    }
    if (ready) return
    if (activeProfileId() !== profileId) {
      log.info('profile changed before the setup check finished; not raising setup', {
        installId: result.installId
      })
      return
    }
    useCatalogInstallStore
      .getState()
      .setPendingSetup({ installId: result.installId, agentName: result.agentName, profileId })
  })()
}
