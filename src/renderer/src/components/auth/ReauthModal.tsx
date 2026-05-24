/**
 * App-level modal raised when the active Cinna session is lost — stored
 * tokens were revoked, replayed, or expired and the server is now answering
 * 401/403 (surfaced as `reauth_required` / `cinna_reauth_required` errors).
 *
 * It runs the same in-place re-auth as the inline surfaces (see
 * docs/auth/cinna_accounts/reauthentication.md): the existing local profile
 * is kept, only the encrypted token pair is swapped. Visibility is driven by
 * the global {@link useReauthStore}, fed by the main-process broadcast (which
 * carries the failing account/connection) and a renderer-side fallback on the
 * QueryClient's error caches — so any failing Cinna call pops this one prompt,
 * on any screen.
 *
 * On success we invalidate every query so the surfaces that failed while the
 * session was dead recover without a reload.
 */
import { useEffect, useState } from 'react'
import { AlertTriangle, RefreshCw } from 'lucide-react'
import { useQueryClient } from '@tanstack/react-query'
import { useReauthStore } from '../../stores/reauth.store'
import { useAuthStore } from '../../stores/auth.store'
import { useCinnaReauth } from '../../hooks/useAuth'

export function ReauthModal(): React.JSX.Element | null {
  const reauthRequired = useReauthStore((s) => s.reauthRequired)
  const info = useReauthStore((s) => s.info)
  const clearReauth = useReauthStore((s) => s.clearReauth)
  const dismiss = useReauthStore((s) => s.dismiss)
  const isCinnaUser = useAuthStore((s) => s.currentUser?.type === 'cinna_user')
  const cinnaReauth = useCinnaReauth()
  const queryClient = useQueryClient()
  const [error, setError] = useState<string | null>(null)

  const open = reauthRequired && isCinnaUser

  // Primary trigger: the main process broadcasts the instant any Cinna IPC
  // call signals a reauth-required code (catalog, agent status, remote sync) —
  // whether the handler threw or returned an error shape. Independent of a
  // query's error code surviving IPC or React Query retry/observer timing
  // (the secondary QueryClient hook in App.tsx covers that). The payload names
  // the account/connection. `requireReauth` respects the 'dismissed' flag.
  useEffect(() => {
    return window.api.auth.onReauthRequired((payload) => {
      useReauthStore.getState().requireReauth(payload)
    })
  }, [])

  // Reset any prior error each time the modal opens.
  useEffect(() => {
    if (open) setError(null)
  }, [open])

  // Escape closes (treated as "Not now") — but not mid-flow.
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape' && !cinnaReauth.isPending) {
        e.preventDefault()
        dismiss()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, cinnaReauth.isPending, dismiss])

  if (!open) return null

  const handleReauth = async (): Promise<void> => {
    setError(null)
    try {
      const result = await cinnaReauth.mutateAsync()
      if (!result.success) {
        setError(result.error ?? 'Re-authentication failed')
        return
      }
      clearReauth()
      // The mutation refreshes auth/agents; recover the rest (catalog, agent
      // status, anything that failed while the session was dead).
      void queryClient.invalidateQueries()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  const handleDismiss = (): void => {
    if (cinnaReauth.isPending) return
    dismiss()
  }

  const accountLabel = info?.account ?? 'your Cinna account'
  let serverHost: string | null = null
  if (info?.serverUrl) {
    try {
      serverHost = new URL(info.serverUrl).host
    } catch {
      serverHost = info.serverUrl
    }
  }

  return (
    // z-[100] keeps this above every other overlay (logs / agent status, z-50)
    // so it truly sits over the main window no matter what's open.
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center bg-black/50 backdrop-blur-sm"
      onClick={handleDismiss}
    >
      <div
        className="w-[440px] max-w-[92vw] rounded-lg border border-[var(--color-border)]
          bg-[var(--color-bg-secondary)] shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start gap-3 px-4 pt-4">
          <div
            className="shrink-0 w-9 h-9 rounded-full flex items-center justify-center
              bg-[var(--color-danger)]/15 text-[var(--color-danger)]"
          >
            <AlertTriangle size={18} />
          </div>
          <div className="flex-1 min-w-0">
            <div className="text-sm font-semibold text-[var(--color-text)]">
              Cinna session expired
            </div>
            <div className="text-[11px] text-[var(--color-text-muted)] mt-1 leading-relaxed">
              The connection to{' '}
              <span className="font-medium text-[var(--color-text-secondary)]">{accountLabel}</span>
              {serverHost && (
                <>
                  {' '}
                  on <span className="font-medium text-[var(--color-text-secondary)]">{serverHost}</span>
                </>
              )}{' '}
              was lost — its session was revoked or expired
              {info?.source ? <> while loading {info.source}</> : null}. Re-authenticate to
              restore remote agents, the bundles catalog, and agent status. Your chats, agents,
              and settings are preserved.
            </div>
          </div>
        </div>

        {error && (
          <div className="px-4 pt-3">
            <div
              className="px-2.5 py-2 rounded-md border border-[var(--color-danger)]/40
                bg-[var(--color-danger)]/10 text-[11px] text-[var(--color-danger)]"
            >
              {error}
            </div>
          </div>
        )}

        <div className="px-4 py-4 flex items-center justify-end gap-2">
          <button
            type="button"
            onClick={handleDismiss}
            disabled={cinnaReauth.isPending}
            className="px-3 py-1.5 rounded-md text-xs font-medium
              border border-[var(--color-border)] text-[var(--color-text-secondary)]
              hover:bg-[var(--color-bg-hover)] hover:text-[var(--color-text)]
              transition-colors disabled:opacity-50"
          >
            Not now
          </button>
          <button
            type="button"
            onClick={handleReauth}
            disabled={cinnaReauth.isPending}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium
              bg-[var(--color-accent)] hover:bg-[var(--color-accent-hover)] text-white
              transition-colors disabled:opacity-50"
          >
            <RefreshCw size={12} className={cinnaReauth.isPending ? 'animate-spin' : ''} />
            {cinnaReauth.isPending ? 'Re-authenticating…' : 'Re-authenticate'}
          </button>
        </div>
      </div>
    </div>
  )
}
