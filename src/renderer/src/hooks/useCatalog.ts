/**
 * React Query hooks for the bundles catalog. Cinna-only — all queries are
 * gated on `currentUser?.type === 'cinna_user'`. The desktop never owns
 * install state; cinna-server is the source of truth, so each mutation
 * invalidates the catalog and remote-agents queries so the renderer
 * reflects the server immediately.
 */
import { useEffect } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { useAuthStore } from '../stores/auth.store'
import type {
  CatalogEntryDto,
  CatalogInstallResultDto,
  SetupCredentialSummaryDto,
  SetupStatusDto
} from '../../../shared/catalog'

export function useCatalog() {
  const isCinnaUser = useAuthStore((s) => s.currentUser?.type === 'cinna_user')
  return useQuery<CatalogEntryDto[]>({
    queryKey: ['catalog'],
    queryFn: () => window.api.catalog.list(),
    enabled: isCinnaUser,
    staleTime: 60_000
  })
}

/**
 * Quick install — POST /catalog/{bundle_id}/install with empty payload.
 * On success the catalog and remote-agents lists are invalidated so the
 * card flips to "Active" and the new install appears in the agent selector
 * without a page refresh.
 */
export function useQuickInstallBundle() {
  const queryClient = useQueryClient()
  return useMutation<CatalogInstallResultDto, Error, string>({
    mutationFn: (bundleId: string) => window.api.catalog.quickInstall(bundleId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['catalog'] })
      queryClient.invalidateQueries({ queryKey: ['agents'] })
    }
  })
}

interface SetupStatusOptions {
  installId: string | null
  /** When true, poll every 3s AND on window focus until status === 'ready'. */
  poll: boolean
}

/**
 * Setup-status query with optional 3s polling and window-focus refresh.
 * Both stop firing once the status resolves to `ready` (the modal closes
 * shortly after, but if it lingers we don't want to keep hammering the
 * server).
 */
export function useSetupStatus({ installId, poll }: SetupStatusOptions) {
  const isCinnaUser = useAuthStore((s) => s.currentUser?.type === 'cinna_user')
  const query = useQuery<SetupStatusDto>({
    queryKey: ['catalog', 'setup-status', installId],
    queryFn: () => window.api.catalog.setupStatus(installId as string),
    enabled: isCinnaUser && !!installId,
    refetchInterval: poll
      ? (q) => (q.state.data?.status === 'ready' ? false : 3000)
      : false,
    refetchOnWindowFocus: poll
  })

  const { refetch } = query
  // Extra window-focus listener: TanStack's refetchOnWindowFocus only fires
  // when the query mounts focused on the page; we also want to refetch on
  // OS-level window activations (the user tabbed to the cinna-server
  // browser tab, filled the credential, and came back).
  useEffect(() => {
    if (!poll || !installId) return
    const onFocus = (): void => {
      void refetch()
    }
    window.addEventListener('focus', onFocus)
    return () => window.removeEventListener('focus', onFocus)
  }, [poll, installId, refetch])

  return query
}

/**
 * List of user-fillable placeholder credentials for an install. Used by the
 * setup modal to resolve each `placeholder_empty` missing item's UUID so
 * the card can deep-link to `/credential/{id}` on cinna-server.
 */
export function useSetupCredentials(installId: string | null) {
  const isCinnaUser = useAuthStore((s) => s.currentUser?.type === 'cinna_user')
  return useQuery<SetupCredentialSummaryDto[]>({
    queryKey: ['catalog', 'setup-credentials', installId],
    queryFn: () => window.api.catalog.setupCredentials(installId as string),
    enabled: isCinnaUser && !!installId,
    staleTime: 30_000
  })
}

export function useCatalogServerUrl() {
  const isCinnaUser = useAuthStore((s) => s.currentUser?.type === 'cinna_user')
  return useQuery({
    queryKey: ['catalog', 'server-url'],
    queryFn: () => window.api.catalog.serverUrl(),
    enabled: isCinnaUser,
    staleTime: 5 * 60_000
  })
}
