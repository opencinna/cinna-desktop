/**
 * What local development is actually doing, as a checklist.
 *
 * Opened from the sidebar's status button. The button itself can only say
 * "working" or "needs you"; this is where the two questions a spinner cannot
 * answer live — *how far along is it* and *which part broke*. On a first run
 * over a slow connection the toolchain is a few hundred megabytes, so "still
 * working" and "wedged" look identical from the outside for minutes at a time,
 * and that is precisely when someone force-quits an app that was fine.
 *
 * It renders `state.tasks` and nothing else. No local timers, no inferred
 * progress: the main process owns the run, and a second opinion here would
 * eventually disagree with the thing actually doing the work.
 */
import { useEffect } from 'react'
import { createPortal } from 'react-dom'
import { AlertTriangle, RefreshCw, X } from 'lucide-react'
import { useLocalDev } from '../../hooks/useLocalDev'
import { useLocalDevStore } from '../../stores/localDev.store'
import { LocalDevTaskList } from './LocalDevTaskList'

export interface LocalDevDetailModalProps {
  onClose: () => void
}

const btnSecondaryClass =
  'px-3 py-1.5 text-xs rounded-md border border-[var(--color-border)] text-[var(--color-text-secondary)] hover:bg-[var(--color-bg-hover)] transition-colors disabled:opacity-50'

export function LocalDevDetailModal({ onClose }: LocalDevDetailModalProps): React.JSX.Element {
  const state = useLocalDev()
  const repair = useLocalDevStore((s) => s.repair)
  const openWorkspace = useLocalDevStore((s) => s.openWorkspace)

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.preventDefault()
        onClose()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const tasks = state.tasks ?? []
  const percent =
    state.phase === 'installing' && state.percent !== undefined
      ? Math.round(Math.max(0, Math.min(100, state.percent)))
      : state.phase === 'ready'
        ? 100
        : null

  // Rendered through a portal to `document.body`, not in place.
  //
  // The button that opens this lives in the sidebar, and two ancestors there
  // establish a containing block for `position: fixed`: `.app-sidebar-wrap` has
  // `will-change: width, transform, opacity` for the collapse animation, and in
  // dark theme `.app-sidebar` has a `backdrop-filter`. Either is enough to make
  // `fixed inset-0` mean "fill the sidebar card" instead of "fill the window",
  // which is exactly where this modal first appeared. A portal is the fix; do
  // not "simplify" it away.
  return createPortal(
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Local development status"
      className="fixed inset-0 z-[100] flex items-center justify-center bg-black/50 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        className="w-[420px] max-w-[92vw] rounded-lg border border-[var(--color-border)]
          bg-[var(--color-bg-secondary)] shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-5 pt-4 pb-2">
          <div className="text-sm font-semibold text-[var(--color-text)]">Local development</div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="p-1 rounded text-[var(--color-text-muted)] hover:text-[var(--color-text)] hover:bg-[var(--color-bg-hover)] transition-colors"
          >
            <X size={14} />
          </button>
        </div>

        <div className="px-5 pb-2">
          {state.phase === 'installing' && (
            <div className="space-y-1.5">
              <div className="flex items-baseline justify-between gap-2">
                <span className="text-[12px] text-[var(--color-text-secondary)] break-words">
                  {state.step}
                </span>
                {percent !== null && (
                  <span className="text-[11px] text-[var(--color-text-muted)] tabular-nums shrink-0">
                    {percent}%
                  </span>
                )}
              </div>
              {percent !== null && (
                <div className="h-1 rounded-full bg-[var(--color-bg-hover)] overflow-hidden">
                  <div
                    className="h-full bg-[var(--color-accent)] transition-[width] duration-200"
                    style={{ width: `${percent}%` }}
                  />
                </div>
              )}
            </div>
          )}

          {state.phase === 'ready' && (
            <div className="text-[12px] text-[var(--color-text-secondary)]">
              Ready. Agent work can run on this machine.
            </div>
          )}

          {state.phase === 'attention' && (
            <div className="flex items-start gap-2">
              <AlertTriangle
                size={14}
                className="mt-0.5 shrink-0 text-[var(--color-severity-warning)]"
              />
              <div className="text-[12px] text-[var(--color-text)] break-words">
                {state.detail}
              </div>
            </div>
          )}
        </div>

        {tasks.length > 0 ? (
          <div className="px-5 py-2">
            <LocalDevTaskList tasks={tasks} />
          </div>
        ) : (
          // Before the first reconcile there is genuinely nothing to report,
          // and inventing five pending rows would imply work is queued when
          // none is.
          <div className="px-5 py-3 text-[12px] text-[var(--color-text-muted)]">
            Nothing has been set up yet.
          </div>
        )}

        <div className="flex justify-end gap-2 px-5 pb-4 pt-1">
          {state.phase === 'ready' && (
            <button
              type="button"
              onClick={() => void openWorkspace()}
              className={btnSecondaryClass}
            >
              Open folder
            </button>
          )}
          {state.phase !== 'installing' && (
            <button type="button" onClick={() => void repair()} className={btnSecondaryClass}>
              <span className="inline-flex items-center gap-1.5">
                <RefreshCw size={12} /> Repair
              </span>
            </button>
          )}
        </div>
      </div>
    </div>,
    document.body
  )
}
