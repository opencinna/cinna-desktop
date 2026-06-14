import { RefreshCw } from 'lucide-react'
import { ManagedProviderCard } from './ManagedProviderCard'
import { useProviders, useSyncAccountConfig } from '../../hooks/useProviders'

/**
 * Profile-scoped LLM providers: account-provisioned (Cinna-managed) keys the
 * admin assigned to this user. Read-only — the user can only toggle each on/off
 * locally + trigger a re-sync. Mirrors the Default-scope LLM Providers section
 * but for managed rows, the same way Remote Agents mirror local agents.
 */
export function ProfileLLMSection(): React.JSX.Element {
  const { data: providers } = useProviders()
  const sync = useSyncAccountConfig()

  const managed = (providers ?? []).filter((p) => p.managed)

  return (
    <div className="space-y-3">
      <div className="flex items-start justify-between gap-2">
        <p className="text-[13px] text-[var(--color-text-muted)] leading-relaxed">
          These LLM providers are managed by your account administrator. They&apos;re ready to use
          and can&apos;t be edited here — you can enable or disable each one for this profile.
        </p>
        <button
          type="button"
          onClick={() => sync.mutate()}
          disabled={sync.isPending}
          className="flex items-center gap-1 shrink-0 mt-0.5 text-[11px] text-[var(--color-text-muted)]
            hover:text-[var(--color-text-secondary)] disabled:opacity-50 transition-colors"
        >
          <RefreshCw size={11} className={sync.isPending ? 'animate-spin' : ''} />
          Sync
        </button>
      </div>

      {managed.length === 0 ? (
        <div className="rounded-lg border border-dashed border-[var(--color-border)] px-4 py-6
          text-center text-[13px] text-[var(--color-text-muted)]">
          No providers have been assigned to your account yet.
        </div>
      ) : (
        managed.map((p) => <ManagedProviderCard key={p.id} provider={p} />)
      )}
    </div>
  )
}
