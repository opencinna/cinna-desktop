import { ShieldCheck, Cloud, Star } from 'lucide-react'
import { useSetManagedChatModeEnabled } from '../../hooks/useChatModes'
import { getPreset } from '../../constants/chatModeColors'
import type { ChatModeData } from '../../constants/chatModeColors'

interface ManagedChatModeCardProps {
  mode: ChatModeData
}

/**
 * Read-only card for an account-provisioned (Cinna-managed) chat mode. Provider,
 * model, and default status are owned by account-config sync, so there's no
 * edit/delete — only a local enable/disable toggle (per-profile override that
 * survives re-sync). Mirrors {@link ManagedProviderCard}.
 */
export function ManagedChatModeCard({ mode }: ManagedChatModeCardProps): React.JSX.Element {
  const setEnabled = useSetManagedChatModeEnabled()
  const preset = getPreset(mode.colorPreset)

  const SourceIcon = mode.adminManaged ? ShieldCheck : Cloud
  const sourceLabel = mode.adminManaged
    ? 'Managed by your administrator'
    : 'From your Cinna account'

  return (
    <div className="rounded-lg border border-[var(--color-border)] bg-[var(--color-bg-secondary)] overflow-hidden">
      <div className="flex items-center gap-2 px-4 py-2.5">
        <div className="w-3 h-3 rounded-full shrink-0" style={{ backgroundColor: preset.border }} />
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-1.5">
            <span className="font-medium text-[14px]">{mode.name}</span>
            {mode.isDefault && (
              <Star size={11} className="fill-current text-[var(--color-warning)]" />
            )}
          </div>
          <div className="flex items-center gap-1 text-[11px] text-[var(--color-text-muted)] mt-0.5">
            <SourceIcon size={9} />
            <span>{sourceLabel}</span>
            {mode.modelId && (
              <span className="text-[var(--color-text-secondary)]">· {mode.modelId}</span>
            )}
          </div>
        </div>

        <button
          type="button"
          disabled={setEnabled.isPending}
          onClick={() => setEnabled.mutate({ id: mode.id, enabled: !mode.enabled })}
          className={`relative w-9 h-5 rounded-full transition-colors shrink-0 disabled:opacity-50 ${
            mode.enabled ? 'bg-[var(--color-accent)]' : 'bg-[var(--color-border)]'
          }`}
          title={mode.enabled ? 'Disable for this profile' : 'Enable'}
        >
          <div
            className={`absolute top-0.5 w-4 h-4 rounded-full bg-white transition-transform ${
              mode.enabled ? 'left-[18px]' : 'left-0.5'
            }`}
          />
        </button>
      </div>
    </div>
  )
}
