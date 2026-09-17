import { useCallback, useEffect, useRef } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import {
  useCatalogInstallStore,
  type CatalogInstallCompletion,
  type CatalogInstallError
} from '../stores/catalogInstall.store'

export type { CatalogInstallError } from '../stores/catalogInstall.store'

export interface CatalogInstall {
  /** Bundle id whose install is in flight (spinner), or null — from any caller. */
  installingBundleId: string | null
  /** Install a bundle. Ignored while any install, from any surface, is running. */
  install: (bundleId: string) => void
  /** Last install error (cleared on the next install attempt). */
  error: CatalogInstallError | null
  clearError: () => void
}

export interface CatalogInstallCallbacks {
  /**
   * Runs only if this component is still mounted when the install finishes —
   * for component state (select the new capability, close a dialog).
   */
  onInstalled?: CatalogInstallCompletion
  /**
   * Runs whether or not this component is still mounted. It must touch only
   * stores and the query client (see `landCatalogInstall`).
   */
  onInstalledDetached?: CatalogInstallCompletion
}

/**
 * A thin view over {@link useCatalogInstallStore}: the install and its state
 * live in the store, so they outlive the component that started them, and one
 * app-wide guard keeps the sidebar catalog and the chat picker from running
 * two installs at once.
 */
export function useCatalogInstall({
  onInstalled,
  onInstalledDetached
}: CatalogInstallCallbacks): CatalogInstall {
  const queryClient = useQueryClient()
  const installingBundleId = useCatalogInstallStore((s) => s.installingBundleId)
  const error = useCatalogInstallStore((s) => s.error)
  const clearError = useCatalogInstallStore((s) => s.clearError)
  const mounted = useRef(true)
  const onInstalledRef = useRef(onInstalled)
  const detachedRef = useRef(onInstalledDetached)
  useEffect(() => {
    onInstalledRef.current = onInstalled
    detachedRef.current = onInstalledDetached
  }, [onInstalled, onInstalledDetached])
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])

  const install = useCallback(
    (bundleId: string): void => {
      // Captured now, both of them: a completion belongs to the surface as it
      // was when clicked. The chat picker's callback is bound to the chat on
      // screen, and ChatInput switches chats without remounting.
      const detached = detachedRef.current
      const attached = onInstalledRef.current
      useCatalogInstallStore.getState().install({
        bundleId,
        queryClient,
        onInstalled: (agentId, result) => {
          detached?.(agentId, result)
          if (mounted.current) attached?.(agentId, result)
        }
      })
    },
    [queryClient]
  )

  return { installingBundleId, install, error, clearError }
}
