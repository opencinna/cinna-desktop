/**
 * The `cinna://connect` confirm step, over an app that is already set up.
 *
 * A fresh install sees the same panel as an onboarding step (there is nothing
 * to sit on top of yet); an install with an account sees it here. Both render
 * {@link ConnectIntentPanel}, so "the link never connects anything without a
 * confirmation" is one component's property rather than two screens' habit.
 *
 * Escape and a backdrop click both mean "not now" — declining a link the user
 * did not expect must be the easiest thing on the screen. There is no
 * mid-flight lock-out because the panel takes over its own surface once the
 * browser round trip starts.
 */
import { useEffect } from 'react'
import { useConnectIntent } from '../../hooks/useConnectIntent'
import { ConnectIntentPanel } from './ConnectIntentPanel'

export function ConnectIntentModal(): React.JSX.Element | null {
  const { intent, consume } = useConnectIntent()

  useEffect(() => {
    if (!intent) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.preventDefault()
        consume()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [intent, consume])

  if (!intent) return null

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Connect to a Cinna server"
      className="fixed inset-0 z-[100] flex items-center justify-center bg-black/50 backdrop-blur-sm"
      onClick={consume}
    >
      <div
        className="w-[440px] max-w-[92vw] rounded-lg border border-[var(--color-border)]
          bg-[var(--color-bg-secondary)] shadow-2xl p-6"
        onClick={(e) => e.stopPropagation()}
      >
        <ConnectIntentPanel intent={intent} onDone={() => consume()} />
      </div>
    </div>
  )
}
