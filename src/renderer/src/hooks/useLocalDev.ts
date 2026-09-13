import { useEffect } from 'react'
import { useMutation, useQuery } from '@tanstack/react-query'
import { unwrapIpcError } from '../utils/ipcError'
import { useLocalDevStore } from '../stores/localDev.store'
import type { LocalDevState } from '../../../shared/localDevState'

/**
 * The active profile's local-development state, subscribed for the app's
 * lifetime.
 *
 * The transitions that matter here — a first-run install, a token that expired
 * overnight, a server that bumped its pinned versions — all happen while nobody
 * is looking at a particular screen, so the subscription belongs wherever the
 * app is mounted rather than in the card that renders it. Same reason
 * `useEngineWatch` sits in `Shell`.
 */
export function useLocalDev(): LocalDevState {
  const state = useLocalDevStore((s) => s.state)
  const subscribe = useLocalDevStore((s) => s.subscribe)
  useEffect(() => {
    void subscribe()
  }, [subscribe])
  return state
}

/** Shared desktop installation; profile transitions can finish or replace its setup. */
export function useManagedLocalDevCli() {
  const { phase } = useLocalDev()
  const query = useQuery({
    queryKey: ['managed-local-dev-cli'],
    queryFn: () => window.api.localDev.getManagedCli()
  })
  const { refetch } = query
  useEffect(() => {
    void refetch()
  }, [phase, refetch])
  return query
}

/** Turn IPC failures into the same inline refusal as a conflicting PATH entry. */
export function useAddManagedCliToPath() {
  return useMutation({
    mutationFn: async (): Promise<{ ok: boolean; path?: string; reason?: string }> => {
      try {
        return await window.api.localDev.addToPath()
      } catch (error) {
        return { ok: false, reason: unwrapIpcError(error, 'The link could not be created.') }
      }
    }
  })
}
