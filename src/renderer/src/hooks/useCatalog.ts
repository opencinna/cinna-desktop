/**
 * React Query hooks for the bundles catalog. Cinna-only — all queries are
 * gated on `currentUser?.type === 'cinna_user'`. The desktop never owns
 * install state; cinna-server is the source of truth, so each mutation
 * invalidates the catalog and remote-agents queries so the renderer
 * reflects the server immediately.
 */
import { useCallback, useEffect } from 'react'
import { useQuery, useMutation, useQueryClient, type QueryClient } from '@tanstack/react-query'
import { useAuthStore } from '../stores/auth.store'
import { isReauthRequiredError } from '../stores/reauth.store'
import { INBOX_QUERY_KEY } from './useInbox'
import { LOCAL_AGENTS_KEY } from './useLocalAgents'
import type {
  CatalogEntryDto,
  CatalogInstallResultDto,
  InstallContextDto,
  SetupCredentialSummaryDto,
  SetupStatusDto
} from '../../../shared/catalog'
import { unwrapCatalogOutcome } from '../../../shared/catalog'
import type { CatalogItemDetail, CatalogItemsListing } from '../../../shared/catalogItems'

export function useCatalog() {
  const isCinnaUser = useAuthStore((s) => s.currentUser?.type === 'cinna_user')
  return useQuery<CatalogEntryDto[]>({
    queryKey: ['catalog'],
    queryFn: async () => unwrapCatalogOutcome(await window.api.catalog.list()),
    enabled: isCinnaUser,
    // An expired session does not heal on retry; show Re-authenticate now.
    retry: (failures, err) => !isReauthRequiredError(err) && failures < 3,
    staleTime: 60_000
  })
}

/**
 * The catalog dialog's list: every item of every kind from main's cached
 * `GET /catalog/items` — the listing team sharing reads too. Keyed by
 * profile, since a list read under one account is not the next one's; under
 * `['catalog']`, so every install, update and Refresh that invalidates the
 * catalog re-reads it. `refresh` is the dialog opening: main lists again then,
 * and on every re-read while the dialog is open.
 */
export function catalogItemsKey(profileId: string | null): readonly unknown[] {
  return ['catalog', 'items', profileId] as const
}

/** One item's versions, read while the dialog shows its detail. */
export function catalogItemKey(profileId: string | null, uuid: string): readonly unknown[] {
  return ['catalog', 'item', profileId, uuid] as const
}

export function useCatalogItems(options: { refresh?: boolean } = {}) {
  const profileId = useAuthStore((s) => s.currentUser?.id ?? null)
  const isCinnaUser = useAuthStore((s) => s.currentUser?.type === 'cinna_user')
  const refresh = options.refresh === true
  return useQuery<CatalogItemsListing | null>({
    queryKey: catalogItemsKey(profileId),
    queryFn: async () => unwrapCatalogOutcome(await window.api.catalog.items(refresh)),
    enabled: isCinnaUser,
    staleTime: 60_000,
    refetchOnMount: refresh ? 'always' : true,
    retry: (failures, err) => !isReauthRequiredError(err) && failures < 2
  })
}

/**
 * Bring the catalog's items up to main's cached listing **without listing
 * again**: main has just refreshed it (that is what its events mean), so a
 * plain invalidation — whose re-read lists again while the dialog is open —
 * would fetch the same listing twice. Only when a read is cached; a profile
 * switch while the answer is on its way drops it.
 */
export async function readCatalogItemsFromCache(queryClient: QueryClient): Promise<void> {
  const profileId = useAuthStore.getState().currentUser?.id ?? null
  const key = catalogItemsKey(profileId)
  if (queryClient.getQueryState(key) === undefined) return
  try {
    const value = unwrapCatalogOutcome(await window.api.catalog.items(false))
    if ((useAuthStore.getState().currentUser?.id ?? null) !== profileId) return
    queryClient.setQueryData(key, value)
  } catch {
    // The next open or Refresh lists again; nothing to say now.
  }
}

/**
 * Re-read the folder agents after main's cached listing moved. Their catalog
 * Skills rows carry `latestRevision` / `updatable` (and an own skill its shared
 * version), which main folds in from that listing on every `local-agent:get`
 * and `list` — not from the folder, so no folder push follows a new version.
 * The list and every open agent page (`['local-agent', id]`); the events carry
 * no payload saying which kind of item moved, so this runs on each one.
 */
export function invalidateLocalAgentsAfterListing(queryClient: QueryClient): void {
  void queryClient.invalidateQueries({ queryKey: LOCAL_AGENTS_KEY })
  void queryClient.invalidateQueries({ queryKey: ['local-agent'] })
}

/**
 * Subscribe to main's `catalog:items-changed` for the app's lifetime: an item
 * the dialog shows moved (a cloud agent installed, a skill's new version).
 * Re-reads the dialog's items from main's cache, the Inbox (whose cloud
 * "Update available" cards read the same listing) and the folder agents (whose
 * Skills rows show Update from it) — never the sharing reads, which only
 * `sharing:changed` touches. Mount once, beside `useSharingWatch`.
 */
export function useCatalogItemsWatch(): void {
  const queryClient = useQueryClient()
  useEffect(() => {
    return window.api.catalog.onItemsChanged(() => {
      void readCatalogItemsFromCache(queryClient)
      void queryClient.invalidateQueries({ queryKey: INBOX_QUERY_KEY })
      invalidateLocalAgentsAfterListing(queryClient)
    })
  }, [queryClient])
}

/**
 * One item with its versions (`GET /catalog/items/{uuid}`), fetched when the
 * detail opens and kept for as long as the dialog is open — the dialog drops
 * these queries when it closes, so the next visit reads afresh.
 */
export function useCatalogItemDetail(uuid: string | null) {
  const profileId = useAuthStore((s) => s.currentUser?.id ?? null)
  const isCinnaUser = useAuthStore((s) => s.currentUser?.type === 'cinna_user')
  return useQuery<CatalogItemDetail>({
    queryKey: catalogItemKey(profileId, uuid ?? ''),
    queryFn: async () => unwrapCatalogOutcome(await window.api.catalog.item(uuid as string)),
    enabled: isCinnaUser && uuid !== null,
    staleTime: Infinity,
    retry: (failures, err) => !isReauthRequiredError(err) && failures < 1
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
    mutationFn: async (bundleId: string) =>
      unwrapCatalogOutcome(await window.api.catalog.quickInstall(bundleId)),
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
