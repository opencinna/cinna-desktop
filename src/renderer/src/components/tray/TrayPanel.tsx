import { useEffect, useMemo, useRef, useState } from 'react'
import { RefreshCw, AlertTriangle } from 'lucide-react'
import { useRelativeNow } from '../../hooks/useRelativeNow'
import { useAgentStatus, useForceRefreshAllAgentStatuses } from '../../hooks/useAgentStatus'
import { useTrayActions } from '../../hooks/useTrayActions'
import { sortByUrgency } from '../agents/statusViews'
import { TrayStatusCard } from './TrayStatusCard'

// Keep the refresh icon spinning at least this long so an instant (cached)
// refetch still reads as a deliberate action rather than a no-op flicker.
const MIN_SPIN_MS = 500
// How long the green/red result flash holds before fading back to the default color.
const FLASH_HOLD_MS = 500

export function TrayPanel(): React.JSX.Element {
  const { data: statuses, isLoading, error } = useAgentStatus()
  const refreshAll = useForceRefreshAllAgentStatuses()
  const tray = useTrayActions()
  const now = useRelativeNow()
  const [spinning, setSpinning] = useState(false)
  const [flash, setFlash] = useState<'success' | 'error' | null>(null)
  const spinTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const flashTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(
    () => () => {
      if (spinTimer.current) clearTimeout(spinTimer.current)
      if (flashTimer.current) clearTimeout(flashTimer.current)
    },
    []
  )

  const handleRefresh = (): void => {
    if (spinning) return
    setSpinning(true)
    setFlash(null)
    const started = Date.now()
    refreshAll.mutateAsync().then(
      (res) => finishRefresh(started, res.failed === 0),
      () => finishRefresh(started, false)
    )
  }

  const finishRefresh = (started: number, ok: boolean): void => {
    const remaining = MIN_SPIN_MS - (Date.now() - started)
    spinTimer.current = setTimeout(() => {
      setSpinning(false)
      setFlash(ok ? 'success' : 'error')
      flashTimer.current = setTimeout(() => setFlash(null), FLASH_HOLD_MS)
    }, Math.max(0, remaining))
  }

  // Flash snaps to the result color (no transition in), then fades back to the
  // inherited muted color once cleared (transition only present when idle).
  const iconColor =
    flash === 'success'
      ? 'text-[var(--color-severity-ok)]'
      : flash === 'error'
        ? 'text-[var(--color-severity-error)]'
        : 'transition-colors duration-700'

  const sorted = useMemo(() => [...statuses].sort(sortByUrgency), [statuses])

  return (
    <div className="h-screen w-screen flex flex-col rounded-xl overflow-hidden border border-[var(--color-border)] bg-[var(--color-overlay-panel)] text-[var(--color-text)]">
      <div className="flex-1 overflow-y-auto p-2">
          {error ? (
            error.code === 'reauth_required' ? (
              <div className="h-full flex flex-col items-center justify-center gap-2 text-center px-4">
                <AlertTriangle size={18} className="text-[var(--color-danger)]" />
                <div className="text-xs text-[var(--color-text-secondary)]">
                  Cinna session expired. Open the app to re-authenticate.
                </div>
              </div>
            ) : (
              <div className="h-full flex items-center justify-center text-xs text-[var(--color-danger)] text-center px-4">
                {error.message}
              </div>
            )
          ) : isLoading && sorted.length === 0 ? (
            <div className="h-full flex items-center justify-center text-xs text-[var(--color-text-muted)]">
              Loading…
            </div>
          ) : sorted.length === 0 ? (
            <div className="h-full flex items-center justify-center text-xs text-[var(--color-text-muted)] text-center px-4">
              No agents have reported status yet.
            </div>
          ) : (
            <>
              <div className="flex items-center gap-2 px-1 pb-1.5">
                <span className="text-[10px] font-semibold uppercase tracking-wider text-[var(--color-text-muted)]">
                  Agents
                </span>
                <span className="text-[10px] text-[var(--color-text-muted)]/70">
                  {sorted.length}
                </span>
                <div className="flex-1" />
                <button
                  onClick={handleRefresh}
                  className="p-1 rounded text-[var(--color-text-muted)] hover:bg-[var(--color-bg-hover)] hover:text-[var(--color-text)] transition-colors"
                  title="Force refresh all from running environments"
                >
                  <RefreshCw
                    size={12}
                    className={`${spinning || isLoading ? 'animate-spin' : ''} ${iconColor}`}
                  />
                </button>
              </div>
              <div className="flex flex-col gap-1.5">
                {sorted.map((s) => (
                  <TrayStatusCard
                    key={s.agentId}
                    snapshot={s}
                    now={now}
                    onViewDetails={() => tray.openStatusDetail(s.agentId)}
                    onStartChat={() => tray.startChat(s.agentId)}
                  />
                ))}
              </div>
            </>
          )}
        </div>
    </div>
  )
}
