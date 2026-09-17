import { useCallback, useMemo, useState } from 'react'
import { useCatalog } from './useCatalog'
import { useCatalogInstall } from './useCatalogInstall'
import type { CatalogPickerItem } from '../components/agents/AgentPickerModal'

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
 * The install itself is {@link useCatalogInstall} (quick install → awaited
 * remote sync → find the synced agent); its local id goes to `onInstalled` so
 * the owner selects it — the card flips from a Catalog Install card to a
 * selected capability.
 *
 * We deliberately skip the `setup-status` check the settings catalog does: if
 * credentials are incomplete the agent auto-replies "setup not complete" on
 * the first message, so the in-chat flow stays a single click.
 */
export function useCatalogPicker(onInstalled: (agentId: string) => void): CatalogPicker {
  const { data: catalog } = useCatalog()
  // Component-bound: if the picker is gone when the install lands, there is
  // nothing to select the agent in, and dropping the selection is right.
  const { installingBundleId, install: startInstall, error } = useCatalogInstall({
    onInstalled: (agentId) => onInstalled(agentId)
  })
  // The install error is app-wide; this picker shows only the one for the
  // install it started, not a failure left behind by the sidebar catalog.
  const [startedBundleId, setStartedBundleId] = useState<string | null>(null)
  const install = useCallback(
    (bundleId: string): void => {
      setStartedBundleId(bundleId)
      startInstall(bundleId)
    },
    [startInstall]
  )

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

  return {
    catalogItems,
    installingBundleId,
    install,
    error: error !== null && error.bundleId === startedBundleId ? error.message : null
  }
}
