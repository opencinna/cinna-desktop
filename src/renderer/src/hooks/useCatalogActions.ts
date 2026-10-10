import { useCallback, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { useApplyBundleUpdate } from './useAgents'
import { useUninstallBundle } from './useCatalog'
import { useCatalogInstall, type CatalogInstallError } from './useCatalogInstall'
import { useGetFromLibrary, useUpdateShared } from './useSharing'
import { useOpenAgentPage } from './useOpenAgentPage'
import { landCatalogInstall } from '../stores/catalogInstall.store'
import type { AgentShareResult } from '../../../shared/agentSharing'
import { shareRefusalSentence } from '../utils/shareText'
import { unwrapIpcError } from '../utils/ipcError'
import { CATALOG_TEXT } from '../utils/catalogItems'
import type {
  CatalogEntryView,
  CloudInstallActions,
  CloudUninstallActions,
  CloudUpdateActions,
  DesktopAgentActions
} from '../components/agents/CatalogItemViews'

export interface CatalogActions {
  /** Get (the quick install) and Open of a cloud agent. */
  install: CloudInstallActions
  /** The last cloud install's failure, app-wide (the store's). */
  installError: CatalogInstallError | null
  cloudUpdate: CloudUpdateActions
  uninstall: CloudUninstallActions
  desktop: DesktopAgentActions
  /** The failure that belongs in this item's tile or detail, if any. */
  errorFor: (view: CatalogEntryView) => string | null
  /**
   * Forget this visit's failures — the surface opening or closing. An update
   * still running keeps going, and keeps its state.
   */
  clearErrors: () => void
}

/**
 * Every action the catalog offers on an item — a cloud agent's Get, Update,
 * Open and Uninstall, a desktop agent's Get, Update and Open — owned by the
 * surface that hosts the catalog rather than by the list that shows the
 * buttons, so closing the catalog dialog mid-action loses nothing. The cloud
 * install runs in its store; the rest are mutations here, read by their own
 * state rather than by callbacks a closed dialog would drop.
 *
 * Each action that ends on an agent lands the user on its page, and calls
 * `onLanded` first so the host can close what covers it (the dialog). The
 * cloud install's landing — open the agent, raise its setup dialog when its
 * credentials are incomplete — touches only stores, so it runs even when the
 * host was unmounted mid-install; `onLanded` only while it is still mounted.
 */
export function useCatalogActions({ onLanded }: { onLanded: () => void }): CatalogActions {
  const queryClient = useQueryClient()
  const openAgentPage = useOpenAgentPage()
  const catalogInstall = useCatalogInstall({
    onInstalled: () => onLanded(),
    onInstalledDetached: (agentId, result) => landCatalogInstall(queryClient, agentId, result)
  })
  const { clearError: clearInstallError } = catalogInstall

  /**
   * A cloud agent's Update (apply the catalog's latest version to the
   * install). Its busy state and failure are read from the mutation itself.
   */
  const applyCloudUpdate = useApplyBundleUpdate()
  const cloudUpdate: CloudUpdateActions = {
    updatingInstallId: applyCloudUpdate.isPending ? (applyCloudUpdate.variables ?? null) : null,
    error:
      applyCloudUpdate.isError && applyCloudUpdate.variables
        ? {
            installId: applyCloudUpdate.variables,
            message:
              (applyCloudUpdate.error as { code?: string }).code === 'reauth_required'
                ? 'Cinna session expired — re-authenticate to update.'
                : unwrapIpcError(applyCloudUpdate.error, 'Update failed.')
          }
        : null,
    onUpdate: (installId) => applyCloudUpdate.mutate(installId)
  }

  /** Removing a cloud install, read from the mutation like the update. */
  const uninstallBundle = useUninstallBundle()
  const { reset: resetUninstall } = uninstallBundle
  const uninstall: CloudUninstallActions = {
    uninstallingInstallId: uninstallBundle.isPending ? (uninstallBundle.variables ?? null) : null,
    error:
      uninstallBundle.isError && uninstallBundle.variables
        ? {
            installId: uninstallBundle.variables,
            message: unwrapIpcError(uninstallBundle.error, CATALOG_TEXT.uninstallFailed)
          }
        : null,
    // A mutate-level callback: it closes the confirm that asked, and is
    // rightly dropped when that surface has gone.
    onUninstall: (installId, onUninstalled) => uninstallBundle.mutate(installId, { onSuccess: onUninstalled }),
    clearError: () => {
      if (!uninstallBundle.isPending) resetUninstall()
    }
  }

  /**
   * Desktop agents' Get and Update, with hook-level callbacks: the landing on
   * the agent page — a store write — happens even if the host closed. A
   * refusal belongs to the tile it came from.
   */
  const [libraryError, setLibraryError] = useState<DesktopAgentActions['error']>(null)
  const refusalText = (result: AgentShareResult): string =>
    shareRefusalSentence(result.refusal ?? 'failed', result.detail)
  const getFromLibrary = useGetFromLibrary({
    onResult: (result, repoId) => {
      if (result.done && result.agentId) {
        onLanded()
        openAgentPage({ id: result.agentId })
      } else if (!result.done) {
        setLibraryError({ repoId, message: refusalText(result) })
      }
    }
  })
  const [updatingRepoId, setUpdatingRepoId] = useState<string | null>(null)
  const updateShared = useUpdateShared({
    onResult: (result, agentId) => {
      // Combining needs the agent page's two-button choice, which the page
      // offers from its status line; take the user there.
      if (result.refusal === 'diverged_conflict') {
        onLanded()
        openAgentPage({ id: agentId })
      } else if (!result.done && updatingRepoId) {
        setLibraryError({ repoId: updatingRepoId, message: refusalText(result) })
      }
    }
  })

  const { isPending: updatePending, reset: resetCloudUpdate } = applyCloudUpdate
  const clearErrors = useCallback((): void => {
    clearInstallError()
    setLibraryError(null)
    // A finished update's failure belongs to this visit; one still running keeps going.
    if (!updatePending) resetCloudUpdate()
  }, [clearInstallError, updatePending, resetCloudUpdate])

  const desktop: DesktopAgentActions = {
    gettingRepoId: getFromLibrary.isPending ? (getFromLibrary.variables ?? null) : null,
    updatingAgentId: updateShared.isPending ? (updateShared.variables ?? null) : null,
    error: libraryError,
    onGet: (repoId) => {
      setLibraryError(null)
      getFromLibrary.mutate(repoId, {
        onError: (err) => setLibraryError({ repoId, message: unwrapIpcError(err) })
      })
    },
    onUpdate: (agent) => {
      if (!agent.localAgentId) return
      setLibraryError(null)
      setUpdatingRepoId(agent.repoId)
      updateShared.mutate(agent.localAgentId, {
        onError: (err) => setLibraryError({ repoId: agent.repoId, message: unwrapIpcError(err) })
      })
    },
    onOpenLocal: (agentId) => {
      clearErrors()
      onLanded()
      openAgentPage({ id: agentId })
    }
  }

  const install: CloudInstallActions = {
    installingBundleId: catalogInstall.installingBundleId,
    onInstall: catalogInstall.install,
    onOpen: (agentId) => {
      clearErrors()
      onLanded()
      openAgentPage({ id: agentId })
    }
  }

  const installError = catalogInstall.error
  const errorFor = (view: CatalogEntryView): string | null => catalogErrorFor(view, installError, cloudUpdate, desktop)

  return { install, installError, cloudUpdate, uninstall, desktop, errorFor, clearErrors }
}

/** The failure that belongs in one item's tile or detail: its install's, its update's or its Get's. */
export function catalogErrorFor(
  view: CatalogEntryView,
  installError: CatalogInstallError | null,
  cloudUpdate: CloudUpdateActions | undefined,
  desktop: DesktopAgentActions | undefined
): string | null {
  if (view.kind === 'cloud_agent') {
    if (installError?.bundleId === view.item.id) return installError.message
    const installId = view.cloud?.installId
    if (installId && cloudUpdate?.error?.installId === installId) return cloudUpdate.error.message
    return null
  }
  if (view.kind === 'desktop_agent' && view.desktop && desktop?.error?.repoId === view.desktop.repoId) {
    return desktop.error.message
  }
  return null
}
