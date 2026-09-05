import { useEffect, useRef } from 'react'
import { Loader2 } from 'lucide-react'
import { useLocalDev } from '../../hooks/useLocalDev'
import { useLocalDevStore } from '../../stores/localDev.store'
import { useAgentsHomeHint } from '../../hooks/useAgentsHomeHint'
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
  // The connect screen's checkbox may already have answered for this host,
  // with main still turning that answer into an install. Asking again in that
  // window is the flicker `answeredHosts` exists to prevent.
  const answeredHosts = useLocalDevStore((s) => s.answeredHosts)
  const agentsHome = useAgentsHomeHint()

  // Held in a ref because the callers pass an inline arrow: as a dependency it
  // changes identity on every render, which would restart the grace timer below
  // each time and could keep it from ever firing.
  const done = useRef(onDone)
  done.current = onDone

  // Nothing to ask: leave immediately rather than flashing a panel.
  useEffect(() => {
    if (state.phase === 'unsupported' || state.phase === 'declined') done.current()
  }, [state.phase])

  const alreadyAnswered = state.phase === 'consent' && answeredHosts.includes(state.host)

  // Still waiting on the first reconcile answer, or on main acting on an answer
  // already given — do not hold first run hostage for either.
  useEffect(() => {
    if (state.phase !== 'idle' && !alreadyAnswered) return
    const timer = setTimeout(() => done.current(), IDLE_GRACE_MS)
    return () => clearTimeout(timer)
  }, [state.phase, alreadyAnswered])

  if (
    state.phase === 'idle' ||
    state.phase === 'unsupported' ||
    state.phase === 'declined' ||
    alreadyAnswered
  ) {
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
