import { useEffect, useState } from 'react'
import { Loader2 } from 'lucide-react'
import { useLocalDev } from '../../hooks/useLocalDev'
import { LocalDevConsentPanel } from './LocalDevConsentPanel'

/**
 * How long to wait for the reconciler to say something before giving up and
 * letting the user into the app.
 *
 * The reconcile is kicked off by the main process when the account activates,
 * so this screen arrives before its first answer — a short wait is the honest
 * thing. But it is a *courtesy* step: local development is not required to use
 * Cinna, and a server that never answers must not leave a new user staring at a
 * spinner on their first run.
 */
const IDLE_GRACE_MS = 8_000

export interface LocalDevOnboardingStepProps {
  /** Move on — the user answered, skipped, or there was nothing to ask. */
  onDone: () => void
}

/**
 * The local-development step of first run, for a user who just connected a
 * Cinna account.
 *
 * It renders only when there is genuinely something to say. `unsupported` (this
 * server does not offer it, or this account lacks the role) and `declined` both
 * mean "nothing to ask" and fall straight through — telling a new user about a
 * feature they cannot have, on the screen that is supposed to be getting out of
 * their way, is not information, it is an obstacle.
 */
export function LocalDevOnboardingStep({
  onDone
}: LocalDevOnboardingStepProps): React.JSX.Element {
  const state = useLocalDev()
  const [agentsHome, setAgentsHome] = useState('')

  useEffect(() => {
    let cancelled = false
    void window.api.localAgents
      .rootsList()
      .then((roots) => {
        if (cancelled) return
        const home = roots.find((r) => r.isDefault) ?? roots[0]
        // `Cloud` is the kit contract's `workshop.cloud_dir`; it is spelled out
        // here only as a hint in consent copy, and the main process resolves
        // the real path from the contract when it creates the folder.
        if (home) setAgentsHome(`${home.path}/Cloud`)
      })
      .catch(() => undefined)
    return () => {
      cancelled = true
    }
  }, [])

  // Nothing to ask: leave immediately rather than flashing a panel.
  useEffect(() => {
    if (state.phase === 'unsupported' || state.phase === 'declined') onDone()
  }, [state.phase, onDone])

  // Still waiting on the first reconcile answer — do not hold first run hostage.
  useEffect(() => {
    if (state.phase !== 'idle') return
    const timer = setTimeout(onDone, IDLE_GRACE_MS)
    return () => clearTimeout(timer)
  }, [state.phase, onDone])

  if (state.phase === 'idle' || state.phase === 'unsupported' || state.phase === 'declined') {
    return (
      <div className="flex flex-col items-center gap-3 py-8">
        <Loader2 size={28} className="text-[var(--color-accent)] animate-spin" />
        <div className="text-sm text-[var(--color-text-secondary)]">Preparing your account…</div>
      </div>
    )
  }

  return (
    <LocalDevConsentPanel state={state} onDone={onDone} agentsHomeHint={agentsHome} />
  )
}
