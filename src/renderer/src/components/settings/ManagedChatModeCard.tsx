import { useState } from 'react'
import { ShieldCheck, Cloud, Star, ChevronDown } from 'lucide-react'
import {
  useSetManagedChatModeEnabled,
  useSetManagedChatModeModel
} from '../../hooks/useChatModes'
import { useModels, useProviderModels } from '../../hooks/useModels'
import { isChatCapableModelId } from '../../../../shared/modelDefaults'
import { getPreset } from '../../constants/chatModeColors'
import type { ChatModeData } from '../../constants/chatModeColors'
import { AnimatedCollapse } from '../ui/AnimatedCollapse'

interface ManagedChatModeCardProps {
  mode: ChatModeData
}

/**
 * Read-only card for an account-provisioned (Cinna-managed) chat mode. Provider
 * and default status are owned by account-config sync, so there's no
 * edit/delete — but the user gets two local, per-profile overrides that survive
 * re-sync: an enable/disable toggle (in the header) and a **model picker** (in
 * the expandable body, mirroring the regular {@link ChatModeCard} edit panel).
 * The synced `default_model` is the default; picking another stores it locally.
 * The picker lists the credential's chat-capable models. Mirrors
 * {@link ManagedProviderCard}.
 */
export function ManagedChatModeCard({ mode }: ManagedChatModeCardProps): React.JSX.Element {
  const [expanded, setExpanded] = useState(false)
  const setEnabled = useSetManagedChatModeEnabled()
  const setModel = useSetManagedChatModeModel()
  const { data: allModels } = useModels()
  const preset = getPreset(mode.colorPreset)

  const SourceIcon = mode.adminManaged ? ShieldCheck : Cloud
  const sourceLabel = mode.adminManaged
    ? 'Managed by your administrator'
    : 'From your Cinna account'

  // Models offered for this credential's provider, from the aggregate registry.
  // Hide non-chat models (embeddings/tts/etc.) but always keep the current
  // selection visible.
  const keepModel = (id: string): boolean => isChatCapableModelId(id) || id === mode.modelId
  const registryOptions = (allModels ?? []).filter(
    (m) => m.providerId === mode.providerId && keepModel(m.id)
  )

  // Fallback: when the registry has nothing for this credential (server provided
  // no list and the background fetch came up empty), pull the model list LIVE
  // from the provider using its key — only once the card is expanded.
  const needFetch = expanded && registryOptions.length === 0 && !!mode.providerId
  const providerModels = useProviderModels(mode.providerId, needFetch)
  const fetchedOptions = (providerModels.data ?? []).filter((m) => keepModel(m.id))
  const modelOptions = registryOptions.length > 0 ? registryOptions : fetchedOptions

  return (
    <div className="rounded-lg border border-[var(--color-border)] bg-[var(--color-bg-secondary)] overflow-hidden">
      <div
        className="flex items-center gap-2 px-4 py-2.5 cursor-pointer hover:bg-[var(--color-bg-hover)] transition-colors"
        onClick={() => setExpanded(!expanded)}
      >
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
          onClick={(e) => {
            e.stopPropagation()
            setEnabled.mutate({ id: mode.id, enabled: !mode.enabled })
          }}
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

        <div
          className={`p-1 text-[var(--color-text-muted)] transition-transform duration-200 ${
            expanded ? 'rotate-180' : ''
          }`}
        >
          <ChevronDown size={12} />
        </div>
      </div>

      <AnimatedCollapse open={expanded}>
        <div className="border-t border-[var(--color-border)] px-4 py-3">
          {/* Local model override — picks which model this credential uses in the app. */}
          <label className="block text-[12px] text-[var(--color-text-muted)] mb-0.5">Model</label>
          {modelOptions.length > 0 ? (
            <select
              value={mode.modelId ?? ''}
              disabled={setModel.isPending}
              onChange={(e) => setModel.mutate({ id: mode.id, modelId: e.target.value || null })}
              className="w-full bg-[var(--color-bg)] text-[var(--color-text)] px-2.5 py-1.5 rounded-md text-[14px] border border-[var(--color-border)] focus:border-[var(--color-accent)] focus:outline-none cursor-pointer disabled:opacity-50"
              title="Select the model to use with this credential (stored on this device)"
            >
              {!mode.modelId && <option value="">Select a model…</option>}
              {modelOptions.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.name}
                </option>
              ))}
            </select>
          ) : providerModels.isFetching ? (
            <p className="text-[12px] text-[var(--color-text-muted)]">Loading models…</p>
          ) : providerModels.isError ? (
            <div className="space-y-1">
              <div className="flex items-center gap-2">
                <span className="text-[12px] text-[var(--color-danger)]">
                  {(providerModels.error as Error)?.message ||
                    "Couldn't load models from the provider."}
                </span>
                <button
                  type="button"
                  onClick={() => providerModels.refetch()}
                  className="text-[12px] text-[var(--color-accent)] hover:underline shrink-0"
                >
                  Retry
                </button>
              </div>
              {(providerModels.error as { detail?: string })?.detail &&
                (providerModels.error as { detail?: string }).detail !==
                  (providerModels.error as Error)?.message && (
                  <p className="text-[11px] text-[var(--color-text-muted)] break-words whitespace-pre-wrap">
                    {(providerModels.error as { detail?: string }).detail}
                  </p>
                )}
            </div>
          ) : (
            <p className="text-[12px] text-[var(--color-text-secondary)]">
              {mode.modelId || 'No models available for this credential.'}
            </p>
          )}
        </div>
      </AnimatedCollapse>
    </div>
  )
}
