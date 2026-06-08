import { useCallback, useMemo, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { useCatalog } from './useCatalog'
import { createLogger } from '../stores/logger.store'
import type { CatalogPickerItem } from '../components/agents/AgentPickerModal'

const log = createLogger('catalog-picker')

export interface CatalogPicker {
  /** Not-yet-installed bundles for the picker's Catalog section. */
  catalogItems: CatalogPickerItem[]
  /** Bundle id whose quick-install is currently in flight (spinner). */
  installingBundleId: string | null
  /** Quick-install a bundle, then select the resulting agent. */
  install: (bundleId: string) => void
  /** Last install error (cleared on the next install attempt). */
  error: string | null
}

/**
 * Backs the picker's "Catalog" section: surfaces every visible cinna-server
 * bundle the user hasn't installed yet and runs a seamless quick install
 * directly from the new-chat / add-agents modal.
 *
 * The install flow mirrors `CatalogSettingsSection` minus the setup gate:
 *
 *  1. `catalog.quickInstall` — server installs the bundle (links any matching
 *     credentials / publisher-provided keys; see [[bundles-catalog]]).
 *  2. `agents.syncRemote` — pull the new install into the local `agents` table
 *     immediately instead of waiting for the 5-minute periodic sync.
 *  3. Find the freshly-synced agent (`remoteTargetId === installId`) and hand
 *     its local id to `onInstalled` so the owner selects it — the card flips
 *     from a Catalog Install card to a selected capability.
 *
 * We deliberately skip the `setup-status` check the settings catalog does: if
 * credentials are incomplete the agent auto-replies "setup not complete" on
 * the first message, so the in-chat flow stays a single click.
 */
export function useCatalogPicker(onInstalled: (agentId: string) => void): CatalogPicker {
  const queryClient = useQueryClient()
  const { data: catalog } = useCatalog()
  const [installingBundleId, setInstallingBundleId] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const catalogItems = useMemo<CatalogPickerItem[]>(
    () =>
      (catalog ?? [])
        .filter((e) => !e.isInstalled)
        .map((e) => ({
          bundleId: e.bundleId,
          name: e.displayName,
          description: e.description,
          meta: e.publisherName ?? e.publisherHandle ?? null,
          email: e.publisherEmail
        })),
    [catalog]
  )

  const install = useCallback(
    (bundleId: string): void => {
      if (installingBundleId) return
      setError(null)
      setInstallingBundleId(bundleId)
      void (async () => {
        try {
          log.info('catalog quick install', { bundleId })
          const result = await window.api.catalog.quickInstall(bundleId)
          // Unlike `useRefreshCatalogState` (which fires syncRemote
          // fire-and-forget), we must AWAIT the sync so the new install is in
          // the local `agents` table before we read it back to select it.
          // Cache mutation stays inside React Query's flow — invalidate then
          // fetchQuery — rather than a direct setQueryData that would race the
          // `agents:remote-sync-complete` broadcast's own invalidation.
          await window.api.agents.syncRemote()
          queryClient.invalidateQueries({ queryKey: ['catalog'] })
          queryClient.invalidateQueries({ queryKey: ['agents'] })
          const agents = await queryClient.fetchQuery({
            queryKey: ['agents'],
            queryFn: () => window.api.agents.list()
          })
          const installed = agents.find((a) => a.remoteTargetId === result.installId)
          if (installed) {
            log.info('catalog install complete', {
              bundleId,
              installId: result.installId,
              agentId: installed.id
            })
            onInstalled(installed.id)
          } else {
            log.warn('installed bundle not found in agent list after sync', {
              bundleId,
              installId: result.installId
            })
          }
        } catch (err) {
          const code = (err as { code?: string } | null)?.code
          const msg = err instanceof Error ? err.message : String(err)
          log.error('quick install failed', { bundleId, error: msg })
          setError(
            code === 'reauth_required'
              ? 'Cinna session expired — re-authenticate in Settings to install.'
              : `Install failed: ${msg.slice(0, 160)}`
          )
        } finally {
          setInstallingBundleId(null)
        }
      })()
    },
    [installingBundleId, queryClient, onInstalled]
  )

  return { catalogItems, installingBundleId, install, error }
}
