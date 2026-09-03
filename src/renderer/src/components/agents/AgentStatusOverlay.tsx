import { useEffect, useMemo, useState } from 'react'
import { X, RefreshCw, AlertTriangle } from 'lucide-react'
import { useUIStore } from '../../stores/ui.store'
import { useAuthStore } from '../../stores/auth.store'
import { useCinnaReauth } from '../../hooks/useAuth'
import { useRelativeNow } from '../../hooks/useRelativeNow'
import {
  useAgentStatus,
  useForceRefreshAgentStatus,
  useForceRefreshAllAgentStatuses
} from '../../hooks/useAgentStatus'
import { StatusCard, DetailView, sortByUrgency } from './statusViews'

const FADE_MS = 350

function ReauthErrorPanel({ onRetry }: { onRetry: () => void }): React.JSX.Element {
  const currentUser = useAuthStore((s) => s.currentUser)
  const cinnaReauth = useCinnaReauth()
  const [localError, setLocalError] = useState<string | null>(null)

  const handleReauth = async (): Promise<void> => {
    if (!currentUser) return
    setLocalError(null)
    const result = await cinnaReauth.mutateAsync()
    if (result.success) {
      onRetry()
    } else {
      setLocalError(result.error ?? 'Re-authentication failed')
    }
  }

  return (
    <div className="h-full flex flex-col items-center justify-center gap-3 text-center px-6">
      <AlertTriangle size={20} className="text-[var(--color-danger)]" />
      <div className="text-xs text-[var(--color-text-secondary)] max-w-sm">
        Cinna session expired. Re-authenticate to refresh agent status — your chats and settings will be preserved.
      </div>
      <button
        onClick={handleReauth}
        disabled={cinnaReauth.isPending}
        className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium
          bg-[var(--color-accent)] hover:bg-[var(--color-accent-hover)] text-white transition-colors
          disabled:opacity-50"
      >
        <RefreshCw size={12} className={cinnaReauth.isPending ? 'animate-spin' : ''} />
        {cinnaReauth.isPending ? 'Re-authenticating…' : 'Re-authenticate'}
      </button>
      {localError && (
        <div className="text-[10px] text-[var(--color-danger)] max-w-sm">{localError}</div>
      )}
    </div>
  )
}

/**
 * The same reauth affordance as {@link ReauthErrorPanel}, laid out as a strip so
 * it can sit *above* a populated grid instead of replacing it. Which one renders
 * is decided by whether there is anything to show — see the note on
 * `degradedBanner` below.
 */
function ReauthErrorStrip({ onRetry }: { onRetry: () => void }): React.JSX.Element {
  const currentUser = useAuthStore((s) => s.currentUser)
  const cinnaReauth = useCinnaReauth()
  const [localError, setLocalError] = useState<string | null>(null)

  const handleReauth = async (): Promise<void> => {
    if (!currentUser) return
    setLocalError(null)
    const result = await cinnaReauth.mutateAsync()
    if (result.success) onRetry()
    else setLocalError(result.error ?? 'Re-authentication failed')
  }

  return (
    <div className="mb-3 flex items-center gap-2 rounded-md border border-[color-mix(in_srgb,var(--color-danger)_45%,transparent)] bg-[color-mix(in_srgb,var(--color-danger)_10%,transparent)] px-3 py-2">
      <AlertTriangle size={14} className="shrink-0 text-[var(--color-danger)]" />
      <div className="min-w-0 flex-1 text-xs text-[var(--color-text-secondary)]">
        Cinna session expired — the agents below are the ones on this machine.
        Your Cinna agents are not being updated.
        {localError && (
          <span className="block text-[10px] text-[var(--color-danger)]">{localError}</span>
        )}
      </div>
      <button
        onClick={handleReauth}
        disabled={cinnaReauth.isPending}
        className="shrink-0 inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md text-[11px] font-medium
          bg-[var(--color-accent)] hover:bg-[var(--color-accent-hover)] text-white transition-colors
          disabled:opacity-50"
      >
        <RefreshCw size={11} className={cinnaReauth.isPending ? 'animate-spin' : ''} />
        {cinnaReauth.isPending ? 'Re-authenticating…' : 'Re-authenticate'}
      </button>
    </div>
  )
}

/** A failure that must stay visible while rows below it are still worth seeing. */
function FailureStrip({ message }: { message: string }): React.JSX.Element {
  return (
    <div className="mb-3 flex items-start gap-2 rounded-md border border-[color-mix(in_srgb,var(--color-danger)_45%,transparent)] bg-[color-mix(in_srgb,var(--color-danger)_10%,transparent)] px-3 py-2">
      <AlertTriangle size={14} className="mt-0.5 shrink-0 text-[var(--color-danger)]" />
      <div className="min-w-0 text-xs text-[var(--color-danger)] break-words">{message}</div>
    </div>
  )
}

/**
 * Every failure this overlay can be showing, in one component, rendered
 * **identically by both render paths** — the grid and `DetailView`.
 *
 * It is a component rather than a line duplicated into each branch because the
 * defect it repairs was shaped exactly that way: the per-agent refresh error was
 * added to the grid branch and not to the detail branch, so the one refresh
 * button the tray links straight to (`useTrayActions.openStatusDetail` opens the
 * overlay *into* DetailView) was the one that could not report a failure. That
 * is a shape that repeats every time someone adds a fourth strip, and only a
 * shared component makes it impossible — a prop threaded into `DetailView`
 * would push overlay-level failure state into a presenter in `statusViews.tsx`
 * and would still leave two places to remember.
 *
 * The batch failure is shown on the detail view too, deliberately **not**
 * narrowed to remote agents even though a folder agent's snapshot is unaffected
 * by the Cinna leg. Erring toward saying too much is the right direction here:
 * the tray is the surface people check instead of opening the app, and a detail
 * card reached from it with no failure surface at all is the same defect class
 * as the one this fixes.
 */
function FailureStrips({
  reauthNeeded,
  error,
  perAgentError,
  onReauthRetry
}: {
  reauthNeeded: boolean
  error: { message: string } | null
  perAgentError: string | null
  onReauthRetry: () => void
}): React.JSX.Element | null {
  if (!reauthNeeded && !error && !perAgentError) return null
  return (
    <>
      {reauthNeeded && <ReauthErrorStrip onRetry={onReauthRetry} />}
      {error && !reauthNeeded && <FailureStrip message={error.message} />}
      {perAgentError && <FailureStrip message={perAgentError} />}
    </>
  )
}

export function AgentStatusOverlay(): React.JSX.Element | null {
  const {
    agentStatusOpen,
    setAgentStatusOpen,
    setActiveView,
    setPendingAgentId,
    agentStatusDetailId: detailAgentId,
    setAgentStatusDetailId: setDetailAgentId
  } = useUIStore()
  const { data: statuses, isLoading, error, refetch } = useAgentStatus()
  const forceRefresh = useForceRefreshAgentStatus()
  const refreshAll = useForceRefreshAllAgentStatuses()
  const refreshingAgentId = forceRefresh.isPending ? forceRefresh.variables ?? null : null
  // Reauth can surface from the background poll (query error) or from a bulk
  // "Refresh all" where one agent reported the session expired.
  const reauthNeeded = error?.code === 'reauth_required' || refreshAll.data?.reauthRequired === true
  const handleReauthRetry = (): void => {
    refreshAll.reset()
    refetch()
  }
  const now = useRelativeNow()
  // Keep the overlay mounted long enough to fade out after the store flips to
  // closed. `visible` drives the opacity; `mounted` gates the DOM.
  const [mounted, setMounted] = useState(agentStatusOpen)
  const [visible, setVisible] = useState(agentStatusOpen)

  useEffect(() => {
    if (agentStatusOpen) {
      setMounted(true)
      // Wait a frame so the browser paints opacity:0 before transitioning to 1.
      const id = requestAnimationFrame(() => setVisible(true))
      return () => cancelAnimationFrame(id)
    }
    setVisible(false)
    const t = setTimeout(() => setMounted(false), FADE_MS)
    return () => clearTimeout(t)
  }, [agentStatusOpen])

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape' && agentStatusOpen) {
        e.preventDefault()
        if (detailAgentId) setDetailAgentId(null)
        else setAgentStatusOpen(false)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [agentStatusOpen, detailAgentId, setAgentStatusOpen])

  // Reset detail view when overlay closes
  useEffect(() => {
    if (!agentStatusOpen) setDetailAgentId(null)
  }, [agentStatusOpen])

  const sorted = useMemo(() => [...statuses].sort(sortByUrgency), [statuses])

  const detail = detailAgentId ? sorted.find((s) => s.agentId === detailAgentId) : null

  // A per-agent Refresh that failed. `useForceRefreshAgentStatus` resolves to
  // `{success:false}` rather than rejecting (IPC error codes do not survive a
  // thrown invoke), and until now the only consumer was an `onSuccess` that
  // early-returned on it — so a card's Refresh button spun, stopped, and said
  // nothing. That is the surface a folder agent's broken `status_refresh_command`
  // lands on, so it had to stop being silent for this phase to mean anything;
  // it repairs the remote path on the way past.
  const refreshResult = forceRefresh.data
  const perAgentError = forceRefresh.isPending
    ? null
    : forceRefresh.isError
      ? 'Could not refresh that agent.'
      : refreshResult && !refreshResult.success
        ? refreshResult.error ?? 'Could not refresh that agent.'
        : null

  // Which shape the failure takes is decided by whether there is anything left
  // to look at, and *only* by that. With rows on screen a full-panel error would
  // hide good data — a folder agent's status is read from local disk and is
  // unaffected by anything the Cinna leg does, and even for a remote-only user a
  // single transient poll failure used to blank a panel full of valid cached
  // snapshots. With nothing on screen the error is the whole answer and stays
  // full-panel, exactly as before. Nothing is softened either way: the same
  // message, the same colour, the same reauth button.
  const degraded = sorted.length > 0

  // Status list is derived server-side from agents the user owns (and
  // client-side filtered through `agentRepo.listRemote`), so any agentId we
  // receive is already in the local DB — no existence check needed.
  const handleStartChat = (agentId: string): void => {
    setAgentStatusOpen(false)
    setDetailAgentId(null)
    setActiveView('chat')
    setPendingAgentId(agentId)
  }

  if (!mounted) return null

  return (
    <div
      className={`fixed inset-0 z-50 flex items-stretch justify-stretch bg-[var(--color-overlay-backdrop)] backdrop-blur-sm transition-opacity ease-out ${
        visible ? 'opacity-100' : 'opacity-0'
      }`}
      style={{ padding: '5vmin', transitionDuration: `${FADE_MS}ms` }}
      onClick={() => setAgentStatusOpen(false)}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="relative flex-1 flex flex-col rounded-xl overflow-hidden border border-[var(--color-border)] bg-[var(--color-overlay-panel)] backdrop-blur-md shadow-2xl"
      >
        <button
          onClick={() => setAgentStatusOpen(false)}
          className="absolute top-2 right-2 z-10 p-1.5 rounded-md text-[var(--color-text-muted)] hover:bg-[var(--color-bg-hover)] hover:text-[var(--color-text)] transition-colors"
          title="Close"
        >
          <X size={14} />
        </button>
        {detail ? (
          <div className="flex-1 flex flex-col overflow-hidden">
            <div className="px-4 pt-3 empty:hidden">
              <FailureStrips
                reauthNeeded={reauthNeeded}
                error={error}
                perAgentError={perAgentError}
                onReauthRetry={handleReauthRetry}
              />
            </div>
            <DetailView
              snapshot={detail}
              now={now}
              refreshing={refreshingAgentId === detail.agentId}
              onRefresh={() => forceRefresh.mutate(detail.agentId)}
              onBack={() => setDetailAgentId(null)}
              onStartChat={() => handleStartChat(detail.agentId)}
            />
          </div>
        ) : (
          <>
            <div className="flex items-center gap-2 px-4 pt-3 pb-2 pr-12">
              <span className="text-[10px] font-semibold uppercase tracking-wider text-[var(--color-text-muted)]">
                Agents
              </span>
              {sorted.length > 0 && (
                <span className="text-[10px] text-[var(--color-text-muted)]/70">{sorted.length}</span>
              )}
              <div className="flex-1" />
              <button
                onClick={() => refreshAll.mutate()}
                disabled={refreshAll.isPending}
                className="p-1 rounded text-[var(--color-text-muted)] hover:bg-[var(--color-bg-hover)] hover:text-[var(--color-text)] transition-colors disabled:opacity-50"
                title="Refresh all — wakes Cinna environments; re-reads local agents' STATUS.md"
              >
                <RefreshCw
                  size={12}
                  className={isLoading || refreshAll.isPending ? 'animate-spin' : ''}
                />
              </button>
            </div>

            <div className="flex-1 overflow-y-auto px-4 pb-4">
              {reauthNeeded && !degraded ? (
                <ReauthErrorPanel onRetry={handleReauthRetry} />
              ) : error && !degraded ? (
                <div className="h-full flex items-center justify-center text-xs text-[var(--color-danger)]">
                  {error.message}
                </div>
              ) : isLoading && sorted.length === 0 ? (
                <div className="h-full flex items-center justify-center text-xs text-[var(--color-text-muted)]">
                  Loading…
                </div>
              ) : sorted.length === 0 ? (
                <div className="h-full flex items-center justify-center text-xs text-[var(--color-text-muted)]">
                  No agents have reported status yet.
                </div>
              ) : (
                <>
                  <FailureStrips
                    reauthNeeded={reauthNeeded}
                    error={error}
                    perAgentError={perAgentError}
                    onReauthRetry={handleReauthRetry}
                  />
                <div className="grid gap-3 grid-cols-[repeat(auto-fill,minmax(260px,1fr))]">
                  {sorted.map((s) => (
                    <StatusCard
                      key={s.agentId}
                      snapshot={s}
                      now={now}
                      refreshing={refreshingAgentId === s.agentId}
                      onRefresh={() => forceRefresh.mutate(s.agentId)}
                      onViewDetails={() => setDetailAgentId(s.agentId)}
                      onStartChat={() => handleStartChat(s.agentId)}
                    />
                  ))}
                </div>
                </>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  )
}
