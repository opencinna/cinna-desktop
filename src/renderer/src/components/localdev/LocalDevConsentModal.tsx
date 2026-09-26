/**
 * "Set up local development?" — the question behind the sidebar button.
 *
 * Opened only by a click on {@link LocalDevStatusButton} while the state is
 * `consent` or `declined`. Nothing opens it on its own: remote building through
 * cinna-cli is something a user goes looking for, and a user who never clicks
 * that button is never asked. Local folder agents need none of this — their
 * engine resolves on the first turn.
 *
 * The screen has one job: say what will happen, in the two places it will
 * happen, and let the user leave. That is why the copy names both locations —
 * the app's data folder for the toolchain, and a real folder in the user's home
 * for the workspace — rather than saying "sets up local development".
 *
 * **Not now** records nothing. The question is asked only on request, so there
 * is no prompt a remembered decline would have to suppress; the button stays
 * where it was for the next time. Escape and a backdrop click mean the same.
 *
 * **Set up** records the answer and waits for main to leave `consent` — the
 * accept itself resolves only when the whole install has — then hands over to
 * the Local Development page, which shows the progress. A refused answer stays
 * on screen under the buttons, with the modal still open to try again.
 */
import { useEffect, useRef, useState } from 'react'
import { Loader2, TerminalSquare } from 'lucide-react'
import { useLocalDev } from '../../hooks/useLocalDev'
import { useLocalDevStore } from '../../stores/localDev.store'
import { useUIStore } from '../../stores/ui.store'
import { useAgentsHomeHint } from '../../hooks/useAgentsHomeHint'
import { LocalDevExplainer } from './LocalDevExplainer'

const btnSecondaryClass =
  'px-4 py-2 text-sm rounded-md border border-[var(--color-border)] text-[var(--color-text-secondary)] hover:bg-[var(--color-bg-hover)] transition-colors disabled:opacity-50'

const btnPrimaryClass =
  'px-5 py-2 text-sm rounded-md bg-[var(--color-accent)] text-white hover:opacity-90 transition-opacity disabled:opacity-50'

export function LocalDevConsentModal(): React.JSX.Element | null {
  const state = useLocalDev()
  const open = useLocalDevStore((s) => s.consentOpen)
  const offered = state.phase === 'consent' || state.phase === 'declined'
  const host = offered ? state.host : ''
  const agentsHome = useAgentsHomeHint(open && offered)
  const [starting, setStarting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // A press that began inside the dialog (selecting a folder path, say) and
  // was released over the backdrop is not a request to close.
  const pressedBackdrop = useRef(false)
  // Which Set up press a reply belongs to. Anything that ends the question —
  // a handover, a close, a profile switch — moves it, so a late reply from an
  // earlier press cannot unlock or annotate a question it was never about.
  const attempt = useRef(0)

  const close = (): void => useLocalDevStore.getState().setConsentOpen(false)

  // The question is gone. Main moved on (an accepted setup is under way), or the
  // modal was closed — by the user, or by a profile switch, which closes it in
  // the same update that changes the phase. Only a handover navigates; every
  // path clears the press, or the next opening would find its buttons locked.
  useEffect(() => {
    if (open && offered) return
    if (open) {
      useLocalDevStore.getState().setConsentOpen(false)
      if (starting) {
        useLocalDevStore.getState().setPageMode('chat')
        useUIStore.getState().setActiveView('local-development')
      }
    }
    attempt.current += 1
    setStarting(false)
    setError(null)
  }, [open, offered, starting])

  useEffect(() => {
    if (!open || starting) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.preventDefault()
        close()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, starting])

  if (!open || !offered) return null

  const setUp = (): void => {
    const press = ++attempt.current
    setStarting(true)
    setError(null)
    // Not awaited past the phase change: the effect above hands over as soon as
    // main leaves `consent`. If the state never moved, the buttons come back,
    // with the refusal (when there was one) under them.
    void useLocalDevStore
      .getState()
      .consent(host, true)
      .then((refusal) => {
        if (press !== attempt.current) return
        setStarting(false)
        setError(refusal)
      })
  }

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Set up local development"
      className="fixed inset-0 z-[100] flex items-center justify-center bg-black/50 backdrop-blur-sm"
      onMouseDown={(e) => { pressedBackdrop.current = e.target === e.currentTarget }}
      onClick={(e) => { if (!starting && pressedBackdrop.current && e.target === e.currentTarget) close() }}
    >
      <div
        className="w-[440px] max-w-[92vw] rounded-lg border border-[var(--color-border)]
          bg-[var(--color-bg-secondary)] shadow-2xl p-6"
      >
        <div className="space-y-4">
          <div className="flex flex-col items-center gap-2 text-center">
            <div className="inline-flex items-center justify-center w-12 h-12 rounded-2xl bg-[var(--color-accent)]/10">
              <TerminalSquare size={24} className="text-[var(--color-accent)]" />
            </div>
            <div className="text-sm font-semibold text-[var(--color-text)]">
              Set up local development?
            </div>
            <div className="text-[11px] text-[var(--color-text-muted)]">
              So you can build {host} agents from this machine with cinna-cli, without setting
              anything up in a terminal.
            </div>
          </div>

          <LocalDevExplainer host={host} agentsHomeHint={agentsHome} />

          <div className="flex justify-end gap-2 pt-1">
            <button type="button" disabled={starting} onClick={close} className={btnSecondaryClass}>
              Not now
            </button>
            {/* Fixed width, so "Starting…" cannot push Not now aside (UX rule 1). */}
            <button
              type="button"
              disabled={starting}
              onClick={setUp}
              className={`${btnPrimaryClass} inline-flex min-w-[112px] items-center justify-center gap-2`}
            >
              {starting && <Loader2 size={14} className="animate-spin" />}
              {starting ? 'Starting…' : 'Set up'}
            </button>
          </div>
          {error && (
            <p role="alert" className="text-[11px] text-[var(--color-danger)] break-words">
              {error}
            </p>
          )}
        </div>
      </div>
    </div>
  )
}
