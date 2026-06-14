import { ManagedChatModeCard } from './ManagedChatModeCard'
import { useChatModes } from '../../hooks/useChatModes'

/**
 * Profile-scoped chat modes: the default mode account-config sync materializes
 * per provisioned credential. Read-only — toggle on/off per profile only. The
 * account default (starred) takes precedence over the local default while this
 * account is active, and these modes appear in the chat composer's mode picker
 * just like Default-scope modes.
 */
export function ProfileChatModesSection(): React.JSX.Element {
  const { data: modes } = useChatModes()
  const managed = (modes ?? []).filter((m) => m.managed)

  return (
    <div className="space-y-3">
      <p className="text-[13px] text-[var(--color-text-muted)] leading-relaxed">
        These chat modes come from your account&apos;s managed providers. They&apos;re available in
        the chat mode picker and can&apos;t be edited here — you can enable or disable each one for
        this profile.
      </p>

      {managed.length === 0 ? (
        <div className="rounded-lg border border-dashed border-[var(--color-border)] px-4 py-6
          text-center text-[13px] text-[var(--color-text-muted)]">
          No managed chat modes yet — they appear once a provider is assigned to your account.
        </div>
      ) : (
        managed.map((m) => <ManagedChatModeCard key={m.id} mode={m} />)
      )}
    </div>
  )
}
