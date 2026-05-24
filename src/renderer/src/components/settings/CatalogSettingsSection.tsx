/**
 * Settings → Profile → Catalog. Lists agent bundles published on the
 * connected cinna-server and lets the user one-click install them.
 *
 * Quick install always submits an empty payload (cinna-server applies
 * the same defaults the install form would use) — the bundle becomes
 * an Active install on the next catalog refetch. If the runtime gate
 * comes back as `needs_setup` / `publisher_broken`, we open the
 * {@link CatalogSetupModal} so the user fills the draft credentials on
 * the server; the modal polls and auto-closes when it goes ready.
 */
import { useEffect, useState } from 'react'
import { RefreshCw, AlertTriangle } from 'lucide-react'
import { useCatalog, useQuickInstallBundle } from '../../hooks/useCatalog'
import { useAuthStore } from '../../stores/auth.store'
import { useCinnaReauth } from '../../hooks/useAuth'
import { useQueryClient } from '@tanstack/react-query'
import { CatalogCard } from './CatalogCard'
import { CatalogSetupModal } from './CatalogSetupModal'

interface ActiveSetup {
  installId: string
  agentName: string
}

export function CatalogSettingsSection(): React.JSX.Element {
  const currentUser = useAuthStore((s) => s.currentUser)
  const isCinnaUser = currentUser?.type === 'cinna_user'
  const catalog = useCatalog()
  const queryClient = useQueryClient()
  const quickInstall = useQuickInstallBundle()
  const cinnaReauth = useCinnaReauth()
  const [reauthError, setReauthError] = useState<string | null>(null)
  const [pendingBundleId, setPendingBundleId] = useState<string | null>(null)
  const [activeSetup, setActiveSetup] = useState<ActiveSetup | null>(null)
  const [toast, setToast] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null)

  useEffect(() => {
    if (!toast) return
    const t = setTimeout(() => setToast(null), 4000)
    return () => clearTimeout(t)
  }, [toast])

  if (!isCinnaUser) {
    return (
      <div className="text-[14px] text-[var(--color-text-muted)]">
        The bundles catalog is available when signed in to a Cinna account.
      </div>
    )
  }

  const handleInstall = async (bundleId: string, displayName: string): Promise<void> => {
    if (pendingBundleId) return
    setPendingBundleId(bundleId)
    try {
      const result = await quickInstall.mutateAsync(bundleId)
      // Check the runtime gate. If everything's green we're done; otherwise
      // open the setup modal so the user fixes drafts on the web. Go through
      // queryClient.fetchQuery so the modal's `useSetupStatus` reads from
      // cache on first render instead of re-fetching.
      let status: 'ready' | 'needs_setup' | 'publisher_broken' = 'ready'
      try {
        const s = await queryClient.fetchQuery({
          queryKey: ['catalog', 'setup-status', result.installId],
          queryFn: () => window.api.catalog.setupStatus(result.installId)
        })
        status = s.status
      } catch {
        // Treat a failed status check as "needs check" — open the modal so the
        // user can see the polling and the open-on-server fallback link.
        status = 'needs_setup'
      }
      if (status === 'ready') {
        setToast({ kind: 'ok', text: `${result.agentName} installed` })
      } else {
        setActiveSetup({ installId: result.installId, agentName: result.agentName })
      }
    } catch (err) {
      const code = (err as { code?: string } | null)?.code
      if (code === 'reauth_required') {
        setToast({
          kind: 'err',
          text: `Cinna session expired — re-authenticate to install ${displayName}.`
        })
      } else {
        const msg = err instanceof Error ? err.message : String(err)
        setToast({ kind: 'err', text: `Install failed: ${msg.slice(0, 160)}` })
      }
    } finally {
      setPendingBundleId(null)
    }
  }

  const handleReauth = async (): Promise<void> => {
    setReauthError(null)
    const result = await cinnaReauth.mutateAsync()
    if (!result.success) {
      setReauthError(result.error ?? 'Re-authentication failed')
      return
    }
    void catalog.refetch()
  }

  const handleModalReady = (): void => {
    if (!activeSetup) return
    setToast({ kind: 'ok', text: `${activeSetup.agentName} is ready` })
    setActiveSetup(null)
    queryClient.invalidateQueries({ queryKey: ['catalog'] })
    queryClient.invalidateQueries({ queryKey: ['agents'] })
  }

  const entries = catalog.data ?? []
  const errorCode = (catalog.error as { code?: string } | null)?.code

  return (
    <div>
      <div className="flex items-center justify-between mb-2">
        <span className="text-[12px] text-[var(--color-text-muted)]">
          Published bundles on your Cinna account
        </span>
        <button
          onClick={() => catalog.refetch()}
          disabled={catalog.isFetching}
          className="flex items-center gap-1 text-[12px] text-[var(--color-accent)] hover:text-[var(--color-accent-hover)] font-medium transition-colors disabled:opacity-50"
        >
          <RefreshCw size={10} className={catalog.isFetching ? 'animate-spin' : ''} />
          {catalog.isFetching ? 'Refreshing…' : 'Refresh'}
        </button>
      </div>

      {catalog.error && (
        <div
          className="flex items-start gap-2 px-2.5 py-2 mb-2 rounded-md
            border border-[var(--color-danger)]/40 bg-[var(--color-danger)]/10
            text-[12px] text-[var(--color-text-secondary)]"
        >
          <AlertTriangle size={12} className="mt-0.5 shrink-0 text-[var(--color-danger)]" />
          <div className="flex-1 min-w-0">
            <div>
              {errorCode === 'reauth_required'
                ? 'Cinna session expired. Re-authenticate to load the catalog.'
                : 'Failed to load the catalog. Try again, or check the logger overlay (⌘`).'}
            </div>
            {errorCode === 'reauth_required' && (
              <>
                <button
                  onClick={handleReauth}
                  disabled={cinnaReauth.isPending}
                  className="mt-1.5 inline-flex items-center gap-1 px-2 py-1 rounded-md text-[12px] font-medium
                    bg-[var(--color-accent)] hover:bg-[var(--color-accent-hover)] text-white transition-colors
                    disabled:opacity-50"
                >
                  <RefreshCw size={10} className={cinnaReauth.isPending ? 'animate-spin' : ''} />
                  {cinnaReauth.isPending ? 'Re-authenticating…' : 'Re-authenticate'}
                </button>
                {reauthError && (
                  <div className="mt-1.5 text-[12px] text-[var(--color-danger)]">{reauthError}</div>
                )}
              </>
            )}
          </div>
        </div>
      )}

      {catalog.isLoading && (
        <div className="text-[12px] text-[var(--color-text-muted)] py-2">Loading catalog…</div>
      )}

      {!catalog.isLoading && !catalog.error && entries.length === 0 && (
        <div className="text-[12px] text-[var(--color-text-muted)] py-2">
          No bundles are visible to your account yet.
        </div>
      )}

      <div className="space-y-2">
        {entries.map((entry) => (
          <CatalogCard
            key={entry.bundleId}
            entry={entry}
            installing={pendingBundleId === entry.bundleId}
            disabled={pendingBundleId !== null && pendingBundleId !== entry.bundleId}
            onInstall={() => void handleInstall(entry.bundleId, entry.displayName)}
          />
        ))}
      </div>

      {toast && (
        <div
          className={`fixed bottom-4 right-4 px-3 py-2 rounded-md text-[14px] shadow-lg border z-40 ${
            toast.kind === 'ok'
              ? 'border-[var(--color-success)]/40 bg-[var(--color-success)]/15 text-[var(--color-text-secondary)]'
              : 'border-[var(--color-danger)]/40 bg-[var(--color-danger)]/15 text-[var(--color-text-secondary)]'
          }`}
        >
          {toast.text}
        </div>
      )}

      {activeSetup && (
        <CatalogSetupModal
          installId={activeSetup.installId}
          agentName={activeSetup.agentName}
          onClose={() => setActiveSetup(null)}
          onReady={handleModalReady}
        />
      )}
    </div>
  )
}
