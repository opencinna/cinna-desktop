import { useEffect, useMemo, useState } from 'react'
import { X, RefreshCw, AlertTriangle } from 'lucide-react'
import { useUIStore } from '../../stores/ui.store'
import { useAuthStore } from '../../stores/auth.store'
import { useCinnaReauth } from '../../hooks/useAuth'
import { useRelativeNow } from '../../hooks/useRelativeNow'
import { useAgentStatus, useForceRefreshAgentStatus } from '../../hooks/useAgentStatus'
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
  const refreshingAgentId = forceRefresh.isPending ? forceRefresh.variables ?? null : null
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
          <DetailView
            snapshot={detail}
            now={now}
            refreshing={refreshingAgentId === detail.agentId}
            onRefresh={() => forceRefresh.mutate(detail.agentId)}
            onBack={() => setDetailAgentId(null)}
            onStartChat={() => handleStartChat(detail.agentId)}
          />
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
                onClick={() => refetch()}
                className="p-1 rounded text-[var(--color-text-muted)] hover:bg-[var(--color-bg-hover)] hover:text-[var(--color-text)] transition-colors"
                title="Refresh all"
              >
                <RefreshCw size={12} className={isLoading ? 'animate-spin' : ''} />
              </button>
            </div>

            <div className="flex-1 overflow-y-auto px-4 pb-4">
              {error ? (
                error.code === 'reauth_required' ? (
                  <ReauthErrorPanel onRetry={refetch} />
                ) : (
                  <div className="h-full flex items-center justify-center text-xs text-[var(--color-danger)]">
                    {error.message}
                  </div>
                )
              ) : isLoading && sorted.length === 0 ? (
                <div className="h-full flex items-center justify-center text-xs text-[var(--color-text-muted)]">
                  Loading…
                </div>
              ) : sorted.length === 0 ? (
                <div className="h-full flex items-center justify-center text-xs text-[var(--color-text-muted)]">
                  No agents have reported status yet.
                </div>
              ) : (
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
              )}
            </div>
          </>
        )}
      </div>
    </div>
  )
}
