/**
 * React Query hooks for the bundles catalog. Cinna-only — all queries are
 * gated on `currentUser?.type === 'cinna_user'`. The desktop never owns
 * install state; cinna-server is the source of truth, so each mutation
 * invalidates the catalog and remote-agents queries so the renderer
 * reflects the server immediately.
 */
import { useCallback, useEffect } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { useAuthStore } from '../stores/auth.store'
import type {
  CatalogEntryDto,
  CatalogInstallResultDto,
  InstallContextDto,
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
 * After any catalog state-changing operation (install today; future
 * uninstall, setup-status flipping to ready, manual refresh) refresh the
 * catalog query AND sync remote agents into the local DB. Both halves are
 * needed: the local `agents` table is only filled by the 5-minute periodic
 * remote sync, so without the explicit `syncRemote()` the freshly-installed
 * agent wouldn't appear in the `@` picker until the next periodic tick.
 * Invalidating `['agents']` directly is intentionally NOT done here — the
 * sync's `agents:remote-sync-complete` broadcast handles that downstream
 * (see `useAgents`), avoiding a stale-read race during the sync window.
 */
export function useRefreshCatalogState() {
  const queryClient = useQueryClient()
  return useCallback(() => {
    queryClient.invalidateQueries({ queryKey: ['catalog'] })
    void window.api.agents.syncRemote()
  }, [queryClient])
}

/**
 * Quick install — POST /catalog/{bundle_id}/install with empty payload.
 * On success the shared catalog-state refresh runs so the card flips to
 * "Active" and the new install appears in the agent selector without a
 * page refresh.
 */
export function useQuickInstallBundle() {
  const refreshCatalogState = useRefreshCatalogState()
  return useMutation<CatalogInstallResultDto, Error, string>({
    mutationFn: (bundleId: string) => window.api.catalog.quickInstall(bundleId),
    onSuccess: refreshCatalogState
  })
}

/**
 * Uninstall — `POST /agents/{installId}/uninstall` on cinna-server. On
 * success runs the shared catalog-state refresh so the card flips back to
 * uninstalled and the remote-agent sync drops the row immediately. Errors
 * are surfaced to the caller (CatalogCard renders a toast); we deliberately
 * don't show a global toast here because the card needs to keep the
 * confirmation modal open so the user sees the error in context.
 */
export function useUninstallBundle() {
  const refreshCatalogState = useRefreshCatalogState()
  return useMutation<{ success: true }, Error, string>({
    mutationFn: (installId: string) => window.api.catalog.uninstall(installId),
    onSuccess: refreshCatalogState
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

/**
 * Per-bundle install-context preview. Lazy by design: the catalog query is
 * cheap (one list call), but `install-context` runs the auto-prefill matcher
 * for *every* required credential on the server, so we only fetch when the
 * caller actually needs the per-spec match data — typically when the catalog
 * card is expanded and the bundle isn't already installed. Cached for 60s so
 * collapsing/re-expanding the same card doesn't re-hit the server.
 */
export function useInstallContext(bundleId: string, enabled: boolean) {
  const isCinnaUser = useAuthStore((s) => s.currentUser?.type === 'cinna_user')
  return useQuery<InstallContextDto>({
    queryKey: ['catalog', 'install-context', bundleId],
    queryFn: () => window.api.catalog.installContext(bundleId),
    enabled: isCinnaUser && enabled,
    staleTime: 60_000
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
