import { useCallback } from 'react'
import { useAuthStore } from '../../stores/auth.store'
import { useCatalogInstallStore } from '../../stores/catalogInstall.store'
import { useRefreshCatalogState } from '../../hooks/useCatalog'
import { CatalogSetupModal } from '../settings/CatalogSetupModal'

/**
 * The setup dialog for a bundle installed from the sidebar catalog, mounted
 * once at the top of the app. The install lands after the sidebar list that
 * started it may have been unmounted (switching sidebar tabs does that), so
 * the dialog cannot live in the list. It hides under any profile other than
 * the one the install ran under.
 */
export function CatalogSetupHost(): React.JSX.Element | null {
  const pending = useCatalogInstallStore((s) => s.pendingSetup)
  const setPendingSetup = useCatalogInstallStore((s) => s.setPendingSetup)
  const profileId = useAuthStore((s) => s.currentUser?.id ?? null)
  const refreshCatalogState = useRefreshCatalogState()
  const onClose = useCallback(() => setPendingSetup(null), [setPendingSetup])
  // Stable: the modal calls it from an effect keyed on the status.
  const onReady = useCallback(() => {
    setPendingSetup(null)
    refreshCatalogState()
  }, [setPendingSetup, refreshCatalogState])

  if (!pending || pending.profileId !== profileId) return null
  return (
    <CatalogSetupModal
      installId={pending.installId}
      agentName={pending.agentName}
      onClose={onClose}
      onReady={onReady}
    />
  )
}
