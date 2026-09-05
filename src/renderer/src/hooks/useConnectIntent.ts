import { useEffect } from 'react'
import { useConnectIntentStore } from '../stores/connectIntent.store'
import type { ConnectIntent } from '../../../shared/connectIntent'

/**
 * The pending `cinna://connect?server=…` deep link, or null.
 *
 * Hydrates from main on first use and stays subscribed for the app's lifetime:
 * the link can arrive at any moment (the user clicks the landing page's button
 * while Cinna is already open) and it can also have arrived *before* the
 * renderer existed, which is the cold-launch case the whole feature is for.
 */
export function useConnectIntent(): {
  intent: ConnectIntent | null
  consume: () => void
} {
  const intent = useConnectIntentStore((s) => s.intent)
  const subscribe = useConnectIntentStore((s) => s.subscribe)
  const consume = useConnectIntentStore((s) => s.consume)

  useEffect(() => {
    void subscribe()
  }, [subscribe])

  return { intent, consume }
}
