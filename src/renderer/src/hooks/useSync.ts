import { useEffect } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import type {
  SyncState,
  SyncInitResult,
  SyncUnlockRequest,
  PairingOffer,
  SyncCollection
} from '../../../shared/sync'

/**
 * React Query layer for Cloud Sync. The renderer never touches `window.api.sync`
 * directly — components call these hooks, which own caching, invalidation, and
 * the live event subscription. Mirrors the `useChat` pattern.
 */

export const SYNC_KEY = ['sync', 'state'] as const

/** Map a synced collection to the React Query key(s) its data lives under. */
const COLLECTION_QUERY_KEYS: Record<SyncCollection, string[]> = {
  note: ['notes'],
  note_folder: ['note-folders'],
  job: ['jobs'],
  job_folder: ['job-folders']
}

export function useSyncState(enabled: boolean): ReturnType<typeof useQuery<SyncState>> {
  return useQuery({
    queryKey: SYNC_KEY,
    queryFn: () => window.api.sync.getState(),
    enabled
  })
}

/**
 * Subscribe to main-process sync events for the lifetime of the mount. A `state`
 * event seeds the sync-state cache directly; a `data-changed` event invalidates
 * the affected domain caches so synced-in jobs/notes/folders (and the derived
 * job dependency-status) appear live; anything else (status/needs-unlock/quota/
 * conflict/…) invalidates the sync-state read.
 */
export function useSyncEvents(enabled: boolean): void {
  const queryClient = useQueryClient()
  useEffect(() => {
    if (!enabled) return
    const off = window.api.sync.onEvent((event) => {
      if (event.type === 'state') {
        queryClient.setQueryData(SYNC_KEY, event.state)
        return
      }
      if (event.type === 'data-changed') {
        const keys = new Set<string>()
        for (const c of event.collections) {
          for (const k of COLLECTION_QUERY_KEYS[c] ?? []) keys.add(k)
        }
        // Invalidating the ['jobs'] root cascades to ['jobs', jobId] and
        // ['jobs', jobId, 'dep-status'] (prefix match), refreshing the
        // dependency-status surface too.
        for (const k of keys) queryClient.invalidateQueries({ queryKey: [k] })
        return
      }
      queryClient.invalidateQueries({ queryKey: SYNC_KEY })
    })
    return off
  }, [enabled, queryClient])
}

export function useSyncInit(): ReturnType<typeof useMutation<SyncInitResult, Error, void>> {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: () => window.api.sync.init(),
    onSettled: () => queryClient.invalidateQueries({ queryKey: SYNC_KEY })
  })
}

export function useSyncUnlock(): ReturnType<
  typeof useMutation<{ success: boolean }, Error, SyncUnlockRequest>
> {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (req: SyncUnlockRequest) => window.api.sync.unlock(req),
    onSettled: () => queryClient.invalidateQueries({ queryKey: SYNC_KEY })
  })
}

export function useSyncLock(): ReturnType<typeof useMutation<{ success: boolean }, Error, void>> {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: () => window.api.sync.lock(),
    onSettled: () => queryClient.invalidateQueries({ queryKey: SYNC_KEY })
  })
}

export function useSyncNow(): ReturnType<typeof useMutation<{ success: boolean }, Error, void>> {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: () => window.api.sync.syncNow(),
    onSettled: () => queryClient.invalidateQueries({ queryKey: SYNC_KEY })
  })
}

export function useAddPassphrase(): ReturnType<
  typeof useMutation<{ success: boolean }, Error, string>
> {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (passphrase: string) => window.api.sync.addPassphrase(passphrase),
    onSettled: () => queryClient.invalidateQueries({ queryKey: SYNC_KEY })
  })
}

export function usePairingStart(): ReturnType<typeof useMutation<PairingOffer, Error, void>> {
  return useMutation({ mutationFn: () => window.api.sync.pairingStart() })
}

export function usePairingScan(): ReturnType<
  typeof useMutation<{ sas: string }, Error, string>
> {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (code: string) => window.api.sync.pairingScan(code),
    onSettled: () => queryClient.invalidateQueries({ queryKey: SYNC_KEY })
  })
}

export function useRevokeDevice(): ReturnType<
  typeof useMutation<{ success: boolean }, Error, string>
> {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (deviceId: string) => window.api.sync.revokeDevice(deviceId),
    onSettled: () => queryClient.invalidateQueries({ queryKey: SYNC_KEY })
  })
}

export function useSyncWipe(): ReturnType<typeof useMutation<{ success: boolean }, Error, void>> {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: () => window.api.sync.wipe(),
    onSettled: () => queryClient.invalidateQueries({ queryKey: SYNC_KEY })
  })
}

/**
 * One-shot pairing-relay poll. Not a query — the joiner device drives it on its
 * own interval and resolves once the sealed UMK arrives. Exposed here so the
 * component never reaches into `window.api` directly.
 */
export function pollPairing(code: string): Promise<boolean> {
  return window.api.sync.pairingPoll(code)
}
