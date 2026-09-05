import { useEffect } from 'react'
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
