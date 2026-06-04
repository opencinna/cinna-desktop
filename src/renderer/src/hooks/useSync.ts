import { useCallback, useEffect, useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import type {
  SyncState,
  SyncInitResult,
  SyncUnlockRequest,
  PairingOffer,
  PairingPollResult,
  IncomingPairing,
  SyncCollection
} from '../../../shared/sync'
import { useUIStore } from '../stores/ui.store'

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

/**
 * Synced screens (Notes / Jobs) whose open should trigger a pull. A `chats`
 * open doesn't sync (chats aren't a synced collection in Phase 1).
 */
const SYNCED_TABS = new Set(['jobs', 'notes'])

/**
 * Coalesce rapid tab toggles into at most one server ping per window — the
 * steady-state 60s periodic timer already covers anything missed. Module-level
 * so it survives remounts (the timestamp is process-global, not per-component).
 */
const VIEW_PULL_THROTTLE_MS = 8_000
let lastViewPullAt = 0

/**
 * Ping the server for peer changes whenever the user opens a synced screen
 * (Notes / Jobs). Fires a full sync cycle (`syncNow` = push pending edits +
 * pull peer changes); the main process gates it to **active, unlocked Cinna
 * profiles**, so it's an inexpensive no-op otherwise. Throttled so flipping
 * between tabs doesn't hammer the backend.
 *
 * Pulled-in rows surface live via {@link useSyncEvents} (`data-changed` →
 * cache invalidation), which must be mounted app-level for this to be visible.
 */
export function useSyncOnTabOpen(enabled: boolean): void {
  const sidebarTab = useUIStore((s) => s.sidebarTab)
  useEffect(() => {
    if (!enabled) return
    if (!SYNCED_TABS.has(sidebarTab)) return
    const now = Date.now()
    if (now - lastViewPullAt < VIEW_PULL_THROTTLE_MS) return
    lastViewPullAt = now
    void window.api.sync.syncNow()
  }, [enabled, sidebarTab])
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

/**
 * Sealer step 1: drive the commit-then-reveal handshake for one inbox request —
 * post the sealer nonce, await the joiner's reveal, verify the commitment, and
 * compute the expected SAS (held in the main process). Resolves once the SAS is
 * ready for the user to transcribe; rejects on tamper/timeout/cancel.
 */
export function usePairingBeginVerify(): ReturnType<
  typeof useMutation<{ success: boolean }, Error, string>
> {
  return useMutation({
    mutationFn: (id: string) => window.api.sync.pairingBeginVerify(id)
  })
}

/**
 * Sealer step 2: submit the SAS the user transcribed from the new device. The
 * main process matches it against the computed SAS and only then seals + relays
 * the UMK; a mismatch rejects without sealing.
 */
export function usePairingConfirmVerify(): ReturnType<
  typeof useMutation<{ success: boolean }, Error, { id: string; sas: string }>
> {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: ({ id, sas }: { id: string; sas: string }) =>
      window.api.sync.pairingConfirmVerify(id, sas),
    onSettled: () => queryClient.invalidateQueries({ queryKey: SYNC_KEY })
  })
}

/** Abandon a verification begun but never confirmed, freeing the stashed key. */
export function usePairingCancelVerify(): ReturnType<
  typeof useMutation<{ success: boolean }, Error, string>
> {
  return useMutation({
    mutationFn: (id: string) => window.api.sync.pairingCancelVerify(id)
  })
}

/**
 * Sealer-side discovery: the list of incoming pairing requests a foregrounded,
 * unlocked trusted device has auto-discovered. Seeds from the inbox on mount
 * (and whenever `enabled` flips) and appends live `pairing-incoming` events.
 * `dismiss(id)` removes one once handled.
 */
export function usePairingInbox(enabled: boolean): {
  incoming: IncomingPairing[]
  dismiss: (id: string) => void
} {
  const [incoming, setIncoming] = useState<IncomingPairing[]>([])

  const dismiss = useCallback((id: string) => {
    setIncoming((list) => list.filter((p) => p.id !== id))
  }, [])

  useEffect(() => {
    if (!enabled) {
      setIncoming([])
      return
    }
    let cancelled = false
    const upsert = (p: IncomingPairing): void =>
      setIncoming((list) => (list.some((x) => x.id === p.id) ? list : [...list, p]))

    void window.api.sync.pairingInbox().then((items) => {
      if (!cancelled) for (const p of items) upsert(p)
    })

    const off = window.api.sync.onEvent((event) => {
      if (event.type === 'pairing-incoming') upsert(event.pairing)
    })
    return () => {
      cancelled = true
      off()
    }
  }, [enabled])

  return { incoming, dismiss }
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

/** Disconnect THIS device from online sync (per-device; account + peers + local
 *  data all untouched). Resolves `{ deviceRemoved }` — false if the server-side
 *  revoke couldn't complete (offline). */
export function useSyncDisconnect(): ReturnType<
  typeof useMutation<{ deviceRemoved: boolean }, Error, void>
> {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: () => window.api.sync.disconnect(),
    onSettled: () => queryClient.invalidateQueries({ queryKey: SYNC_KEY })
  })
}

/** Reconnect this device (undo a prior disconnect → pair/restore or enable). */
export function useSyncReconnect(): ReturnType<
  typeof useMutation<{ success: boolean }, Error, void>
> {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: () => window.api.sync.reconnect(),
    onSettled: () => queryClient.invalidateQueries({ queryKey: SYNC_KEY })
  })
}

/**
 * One-shot pairing-relay poll (joiner side). Not a query — the joiner drives it
 * on its own interval. Surfaces the SAS once the handshake reaches the reveal
 * step, and `done: true` once the sealed UMK arrives. Exposed here so the
 * component never reaches into `window.api` directly.
 */
export function pollPairing(code: string): Promise<PairingPollResult> {
  return window.api.sync.pairingPoll(code)
}
