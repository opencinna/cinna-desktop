import { useState } from 'react'
import { CheckCircle, Loader2, TerminalSquare, XCircle } from 'lucide-react'
import { LocalDevExplainer } from './LocalDevExplainer'
import { LocalDevTaskList } from './LocalDevTaskList'
import { useLocalDevStore } from '../../stores/localDev.store'
import type { LocalDevState } from '../../../../shared/localDevState'

const btnSecondaryClass =
  'px-4 py-2 text-sm rounded-md border border-[var(--color-border)] text-[var(--color-text-secondary)] hover:bg-[var(--color-bg-hover)] transition-colors disabled:opacity-50'

const btnPrimaryClass =
  'px-5 py-2 text-sm rounded-md bg-[var(--color-accent)] text-white hover:opacity-90 transition-opacity disabled:opacity-50'

export interface LocalDevConsentPanelProps {
  state: LocalDevState
  /** The user has answered, or the run has finished — the caller moves on. */
  onDone: () => void
  /** Where the account workspace will go, for the consent copy. */
  agentsHomeHint: string
}

/**
 * "Set up local development?" — asked once per Cinna host, before anything is
 * downloaded or written outside the app's own data folder.
 *
 * The screen has one job: say what will happen, in the two places it will
 * happen, and let the user decline. That is why the copy names both locations —
 * the app's data folder for the toolchain, and a real folder in the user's home
 * for the workspace — rather than saying "sets up local development". A prompt
 * that does not say where it writes is a prompt nobody can answer honestly.
 *
 * Declining is remembered, so this does not come back at every launch; Settings
 * → Local Development can undo it.
 *
 * Once the answer is yes the same panel becomes the progress view, driven by
 * the reconciler's `installing` steps. Two components would mean the user
 * clicking Set up and watching the screen change under them for no reason.
 */
export function LocalDevConsentPanel({
  state,
  onDone,
  agentsHomeHint
}: LocalDevConsentPanelProps): React.JSX.Element {
  const consent = useLocalDevStore((s) => s.consent)
  const repair = useLocalDevStore((s) => s.repair)
  const [busy, setBusy] = useState(false)

  if (state.phase === 'installing') {
    const overall =
      state.percent === undefined
        ? null
        : Math.round(Math.max(0, Math.min(100, state.percent)))
    return (
      <div className="space-y-4">
        <div className="space-y-3 py-2">
          <div className="flex items-baseline justify-between gap-2">
            <div className="text-sm font-medium text-[var(--color-text)]">
              Setting up local development
            </div>
            {overall !== null && (
              <div className="text-[11px] text-[var(--color-text-muted)] tabular-nums shrink-0">
                {overall}%
              </div>
            )}
          </div>
          {overall !== null && (
            <div className="h-1 rounded-full bg-[var(--color-bg-hover)] overflow-hidden">
              <div
                className="h-full bg-[var(--color-accent)] transition-[width] duration-200"
                style={{ width: `${overall}%` }}
              />
            </div>
          )}

          {/* The per-component list, not just the current step. Watching one
              line change is no way to tell what is left — the whole point is
              seeing that Mutagen is downloading *and* that cinna-cli and the
              workspace are still ahead of it. */}
          {(state.tasks?.length ?? 0) > 0 ? (
            <LocalDevTaskList tasks={state.tasks ?? []} />
          ) : (
            <div className="flex items-center gap-2 text-sm text-[var(--color-text-secondary)]">
              <Loader2 size={14} className="text-[var(--color-accent)] animate-spin" />
              {state.step}
            </div>
          )}

          <div className="text-[11px] text-[var(--color-text-muted)]">
            This downloads a few hundred megabytes the first time. You can leave it running.
          </div>
        </div>
        {/* Leaving is always allowed. The reconciler runs in the main process
            and keeps going; the sidebar picks the progress up from here. */}
        <button type="button" onClick={onDone} className={`w-full ${btnSecondaryClass}`}>
          Continue in the background
        </button>
      </div>
    )
  }

  if (state.phase === 'attention') {
    return (
      <div className="space-y-4">
        <div className="flex flex-col items-center gap-2 text-center">
          <XCircle size={24} className="text-[var(--color-danger)]" />
          <div className="text-sm font-semibold text-[var(--color-text)]">
            Local development is not ready
          </div>
          <div className="text-[11px] text-[var(--color-text-muted)] break-words">
            {state.detail}
          </div>
          <div className="text-[11px] text-[var(--color-text-muted)]">
            You can chat and use your agents without it. Settings → Local Development can try again.
          </div>
        </div>
        <div className="flex justify-end gap-2">
          <button type="button" onClick={onDone} className={btnSecondaryClass}>
            Continue
          </button>
          <button
            type="button"
            onClick={() => {
              setBusy(true)
              void repair().finally(() => setBusy(false))
            }}
            disabled={busy}
            className={btnPrimaryClass}
          >
            Try again
          </button>
        </div>
      </div>
    )
  }

  if (state.phase === 'ready') {
    return (
      <div className="space-y-4">
        <div className="flex flex-col items-center gap-2 text-center">
          <CheckCircle size={24} className="text-[var(--color-success)]" />
          <div className="text-sm font-semibold text-[var(--color-text)]">
            Local development is ready
          </div>
          <div className="text-[11px] text-[var(--color-text-muted)] break-all">
            {state.workspacePath}
          </div>
        </div>
        <button type="button" onClick={onDone} className={`w-full ${btnPrimaryClass}`}>
          Start using Cinna
        </button>
      </div>
    )
  }

  const host = state.phase === 'consent' || state.phase === 'declined' ? state.host : ''

  return (
    <div className="space-y-4">
      <div className="flex flex-col items-center gap-2 text-center">
        <div className="inline-flex items-center justify-center w-12 h-12 rounded-2xl bg-[var(--color-accent)]/10">
          <TerminalSquare size={24} className="text-[var(--color-accent)]" />
        </div>
        <div className="text-sm font-semibold text-[var(--color-text)]">
          Set up local development?
        </div>
        <div className="text-[11px] text-[var(--color-text-muted)]">
          So you can build and run {host || 'your Cinna'} agents on this machine, without setting
          anything up in a terminal.
        </div>
      </div>

      <LocalDevExplainer host={host} agentsHomeHint={agentsHomeHint} />

      <div className="flex justify-end gap-2 pt-1">
        <button
          type="button"
          disabled={busy || !host}
          onClick={() => {
            setBusy(true)
            void consent(host, false)
              .then(onDone)
              .finally(() => setBusy(false))
          }}
          className={btnSecondaryClass}
        >
          Skip
        </button>
        <button
          type="button"
          disabled={busy || !host}
          onClick={() => {
            setBusy(true)
            void consent(host, true).finally(() => setBusy(false))
          }}
          className={btnPrimaryClass}
        >
          Set up
        </button>
      </div>
    </div>
  )
}
