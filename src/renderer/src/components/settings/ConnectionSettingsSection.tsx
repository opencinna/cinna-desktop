import { useState } from 'react'
import { RefreshCw } from 'lucide-react'
import { useAuthStore } from '../../stores/auth.store'
import { useCinnaReauth } from '../../hooks/useAuth'

/**
 * Settings → Profile → Connection. Surfaces the in-place Cinna re-auth flow
 * as a card (mirrors the Features card layout). This is the discoverable
 * entry point for re-authentication — see docs/auth/cinna_accounts/reauthentication.md.
 */
export function ConnectionSettingsSection(): React.JSX.Element {
  const currentUser = useAuthStore((s) => s.currentUser)
  const isCinnaUser = currentUser?.type === 'cinna_user'
  const needsReauth = isCinnaUser && currentUser?.hasCinnaTokens === false
  const cinnaReauth = useCinnaReauth()
  const [reauthError, setReauthError] = useState<string | null>(null)

  if (!isCinnaUser) {
    return (
      <div className="text-xs text-[var(--color-text-muted)]">
        Re-authentication is available when signed in to a Cinna account.
      </div>
    )
  }

  const handleReauth = async (): Promise<void> => {
    setReauthError(null)
    const result = await cinnaReauth.mutateAsync()
    if (!result.success) {
      setReauthError(result.error ?? 'Re-authentication failed')
    }
  }

  return (
    <div className="space-y-6">
      <section>
        <h2 className="text-xs font-semibold text-[var(--color-text-muted)] uppercase tracking-wider mb-2">
          Authentication
        </h2>
        <div className="rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] p-4">
          <div className="flex items-center gap-3">
            <div className="flex-1">
              <div className="text-xs font-medium text-[var(--color-text)]">Re-authenticate</div>
              <div className="text-[11px] text-[var(--color-text-muted)] mt-0.5 leading-relaxed">
                {needsReauth
                  ? 'Cinna session expired. Re-authenticate to restore remote agents — your chats and settings are preserved.'
                  : 'Re-link this account with a fresh Cinna session. Your chats, agents, and settings are preserved.'}
              </div>
              {reauthError && (
                <div className="text-[11px] text-[var(--color-danger)] mt-1.5">{reauthError}</div>
              )}
            </div>
            <button
              type="button"
              onClick={handleReauth}
              disabled={cinnaReauth.isPending}
              className={`shrink-0 flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium
                transition-colors disabled:opacity-50 ${
                  needsReauth
                    ? 'bg-[var(--color-accent)] hover:bg-[var(--color-accent-hover)] text-white'
                    : 'border border-[var(--color-border)] text-[var(--color-text-secondary)] hover:bg-[var(--color-bg-hover)] hover:text-[var(--color-text)]'
                }`}
              title={
                needsReauth
                  ? 'Cinna session expired — re-authenticate to restore remote agents'
                  : 'Re-link this account with a fresh Cinna session'
              }
            >
              <RefreshCw size={12} className={cinnaReauth.isPending ? 'animate-spin' : ''} />
              {cinnaReauth.isPending ? 'Re-authenticating…' : 'Re-authenticate'}
            </button>
          </div>
        </div>
      </section>
    </div>
  )
}
