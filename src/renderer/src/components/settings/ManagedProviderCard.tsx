import { Circle, ShieldCheck, Cloud } from 'lucide-react'

const PROVIDER_LABELS: Record<string, string> = {
  anthropic: 'Anthropic',
  openai: 'OpenAI',
  gemini: 'Google Gemini',
  openai_compatible: 'OpenAI-compatible'
}

interface ManagedProviderCardProps {
  provider: {
    id: string
    type: string
    name: string
    defaultModelId: string | null
    adminManaged: boolean
    unsupported: boolean
  }
}

/**
 * Read-only card for an account-provisioned (Cinna-managed) LLM provider. The
 * key/model are owned by account-config sync, and the provider has no standalone
 * on/off — it's always available and usability is controlled by the chat mode
 * that references it. Purely informational here (the `adminManaged` flag
 * distinguishes admin-provisioned from the user's own Cinna credential).
 */
export function ManagedProviderCard({ provider }: ManagedProviderCardProps): React.JSX.Element {
  const SourceIcon = provider.adminManaged ? ShieldCheck : Cloud
  const sourceLabel = provider.adminManaged
    ? 'Managed by your administrator'
    : 'From your Cinna account'

  return (
    <div className="rounded-lg border border-[var(--color-border)] bg-[var(--color-bg-secondary)] overflow-hidden">
      <div className="flex items-center gap-2 px-4 py-2.5">
        <Circle
          size={6}
          className={`fill-current ${
            provider.unsupported ? 'text-[var(--color-text-muted)]' : 'text-[var(--color-success)]'
          }`}
        />
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-1.5">
            <span className="font-medium text-[14px]">{provider.name}</span>
            <span className="text-[12px] text-[var(--color-text-muted)]">
              {PROVIDER_LABELS[provider.type] ?? provider.type}
            </span>
            {provider.unsupported && (
              <span
                className="text-[10px] font-medium px-1.5 py-0.5 rounded
                  bg-[var(--color-danger)]/15 text-[var(--color-danger)]"
                title="This is an OAuth token (sk-ant-oat…) for the Claude apps — it can't be used for API calls in this app."
              >
                Not supported
              </span>
            )}
          </div>
          <div className="flex items-center gap-1 text-[11px] text-[var(--color-text-muted)] mt-0.5">
            <SourceIcon size={9} />
            <span>{sourceLabel}</span>
            {provider.defaultModelId && (
              <span className="text-[var(--color-text-secondary)]">· {provider.defaultModelId}</span>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
