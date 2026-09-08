import { useState } from 'react'
import { Plus, Loader2, XCircle } from 'lucide-react'
import { LLMProviderCard } from './LLMProviderCard'
import { LLMProviderForm } from './LLMProviderForm'
import { useProviders, useUpsertProvider, useOllamaDetection } from '../../hooks/useProviders'
import { unwrapIpcError } from '../../utils/ipcError'

export function LLMSettingsSection(): React.JSX.Element {
  const { data: providers } = useProviders()
  const [showAddLLM, setShowAddLLM] = useState(false)
  const [addError, setAddError] = useState<string | null>(null)

  // Account-provisioned (managed) providers live in the Profile group's
  // "LLM Providers" section — keep this Default-scope section to user-created ones.
  const own = (providers ?? []).filter((p) => !p.managed)

  const detection = useOllamaDetection()
  const addOllama = useUpsertProvider()

  /**
   * Whether to offer the one-click add.
   *
   * Suppressed **by host**, via `alreadyConfigured`, which compares normalised
   * origins in main. There was a second suppression here — "the user has any
   * Ollama credential at all" — added because the probe is cached for fifteen
   * seconds and the row would otherwise linger for a moment after its own button
   * had worked. That is now handled properly, by invalidating the detection
   * query when a credential is written, and the type-wide check has been removed
   * because it was answering a different and wronger question: a credential
   * saved once against a mistyped port would have permanently hidden the offer
   * that would have found the real server.
   */
  const offerOllama = detection.data?.running === true && !detection.data.alreadyConfigured

  const handleAddOllama = (): void => {
    if (!detection.data) return
    setAddError(null)
    addOllama.mutate(
      {
        type: 'ollama',
        name: 'Ollama',
        baseUrl: detection.data.host,
        enabled: true,
        defaultModelId: null
      },
      { onError: (err) => setAddError(unwrapIpcError(err, 'Ollama could not be added.')) }
    )
  }

  return (
    <div className="space-y-3">
      {own.map((p) => (
        <LLMProviderCard key={p.id} provider={p} />
      ))}

      {showAddLLM ? (
        <LLMProviderForm onClose={() => setShowAddLLM(false)} />
      ) : (
        <button
          onClick={() => setShowAddLLM(true)}
          className="w-full flex items-center justify-center gap-1.5 px-3 py-2.5 rounded-lg
            border border-dashed border-[var(--color-border)] text-[14px]
            text-[var(--color-text-muted)] hover:text-[var(--color-text-secondary)]
            hover:border-[var(--color-text-muted)] transition-colors"
        >
          <Plus size={14} />
          Add AI Credentials
        </button>
      )}

      {/*
        The offer sits **last**, below the Add button, and that placement is the
        whole reason it is allowed to appear asynchronously: the probe resolves a
        moment after the section mounts, and anywhere above this it would push
        the cards and the Add button down under a pointer already moving toward
        them (ux_rules rule 1). Nothing follows it, so its arrival moves nothing.

        It is not a banner in the sense rule 2 forbids: it says nothing about
        health, appears only when there is something the user can act on that
        they have not already done, and carries the action that resolves it.
      */}
      {offerOllama && (
        <div className="flex items-center gap-3 px-4 py-2.5 rounded-lg border border-[var(--color-border)] bg-[var(--color-bg-secondary)]">
          <div className="flex-1 min-w-0">
            <div className="text-[14px] font-medium">Ollama is running on this machine</div>
            <div className="text-[13px] text-[var(--color-text-muted)] truncate">
              {detection.data && detection.data.models.length > 0
                ? `${detection.data.models.length} local model${
                    detection.data.models.length === 1 ? '' : 's'
                  } at ${detection.data.host}`
                : `No models pulled yet at ${detection.data?.host}`}
            </div>
          </div>
          <button
            type="button"
            onClick={handleAddOllama}
            disabled={addOllama.isPending}
            className="shrink-0 px-3 py-1.5 rounded-md text-[13px] font-medium border border-[var(--color-border)]
              text-[var(--color-accent)] hover:bg-[var(--color-bg-hover)]
              disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
          >
            {addOllama.isPending ? (
              <span className="flex items-center gap-1">
                <Loader2 size={12} className="animate-spin" /> Adding…
              </span>
            ) : (
              'Add Ollama'
            )}
          </button>
        </div>
      )}

      {addError && (
        <div className="flex items-center gap-1.5 text-[13px] text-[var(--color-danger)]">
          <XCircle size={12} />
          <span>{addError}</span>
        </div>
      )}
    </div>
  )
}
