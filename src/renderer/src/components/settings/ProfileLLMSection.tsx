import { ManagedProviderCard } from './ManagedProviderCard'
import { useProviders, useSyncAccountConfig } from '../../hooks/useProviders'
import { unwrapIpcError } from '../../utils/ipcError'
import { SettingsInfoTip, SettingsRefreshButton, SettingsSection } from './SettingsLayout'

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
  const syncFailed = sync.error
    ? unwrapIpcError(sync.error, 'Could not refresh AI credentials.')
    : sync.data && !sync.data.success ? 'Could not refresh AI credentials from your Cinna account. Try again.' : null

  return (
    <SettingsSection
      title="Remote AI credentials"
      info={
        <SettingsInfoTip label="About remote AI credentials">
          Synced from your Cinna account; some are set by your administrator. They&apos;re ready to use
          and can&apos;t be edited here — you can enable or disable each one for this profile.
        </SettingsInfoTip>
      }
      action={<SettingsRefreshButton onClick={() => sync.mutate()} busy={sync.isPending} />}
    >
      {managed.length === 0 ? (
        <div className="rounded-lg border border-dashed border-[var(--color-border)] px-4 py-6
          text-center text-[13px] text-[var(--color-text-muted)]">
          No AI credentials have been assigned to your account yet.
        </div>
      ) : (
        managed.map((p) => <ManagedProviderCard key={p.id} provider={p} />)
      )}
      {/* Last in the section: a failed refresh moves nothing above it. */}
      {syncFailed && <p role="alert" className="text-[13px] text-[var(--color-danger)]">{syncFailed}</p>}
    </SettingsSection>
  )
}
