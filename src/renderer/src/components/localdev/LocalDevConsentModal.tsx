/**
 * The local-development consent question, for an install that is past first run.
 *
 * Two ways to arrive here: an existing user updates to a build that has this
 * feature, or their server starts offering it. Either way the question has to
 * be asked once — nothing is downloaded or written to the home directory
 * without an answer — and a modal is the only surface an already-running app
 * has for a question the user did not go looking for.
 *
 * It shows for `consent` and nothing else. Progress, failures and the ready
 * state all belong to the sidebar button and Settings, which are there to be
 * glanced at; a modal that reappeared for every step would be an app that
 * interrupts you to tell you it is busy.
 *
 * Escape and a backdrop click are **not** wired to a silent dismissal, unlike
 * the connect-intent modal: dismissing this one has to record an answer, or the
 * same modal returns on the next reconcile. Skip is the dismissal.
 */
import { useEffect, useState } from 'react'
import { useLocalDev } from '../../hooks/useLocalDev'
import { LocalDevConsentPanel } from './LocalDevConsentPanel'

export function LocalDevConsentModal(): React.JSX.Element | null {
  const state = useLocalDev()
  const [agentsHome, setAgentsHome] = useState('')
  // Closed once answered, so the progress that follows does not keep the modal
  // up — `installing` is the sidebar's job.
  const [answered, setAnswered] = useState(false)

  useEffect(() => {
    if (state.phase !== 'consent') return
    let cancelled = false
    void window.api.localAgents
      .rootsList()
      .then((roots) => {
        if (cancelled) return
        const home = roots.find((r) => r.isDefault) ?? roots[0]
        if (home) setAgentsHome(`${home.path}/Cloud`)
      })
      .catch(() => undefined)
    return () => {
      cancelled = true
    }
  }, [state.phase])

  // A later reconcile that lands back on `consent` (the user reset it in
  // Settings) is a new question, not the one already answered.
  useEffect(() => {
    if (state.phase === 'consent') setAnswered(false)
  }, [state.phase])

  if (state.phase !== 'consent' || answered) return null

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Set up local development"
      className="fixed inset-0 z-[100] flex items-center justify-center bg-black/50 backdrop-blur-sm"
    >
      <div
        className="w-[440px] max-w-[92vw] rounded-lg border border-[var(--color-border)]
          bg-[var(--color-bg-secondary)] shadow-2xl p-6"
      >
        <LocalDevConsentPanel
          state={state}
          onDone={() => setAnswered(true)}
          agentsHomeHint={agentsHome}
        />
      </div>
    </div>
  )
}
