import { useState } from 'react'
import { Plus } from 'lucide-react'
import { LLMProviderCard } from './LLMProviderCard'
import { LLMProviderForm } from './LLMProviderForm'
import { useProviders } from '../../hooks/useProviders'

export function LLMSettingsSection(): React.JSX.Element {
  const { data: providers } = useProviders()
  const [showAddLLM, setShowAddLLM] = useState(false)

  return (
    <div className="space-y-3">
      {(providers ?? []).map((p) => (
        <LLMProviderCard key={p.id} provider={p} />
      ))}

      {showAddLLM ? (
        <LLMProviderForm onClose={() => setShowAddLLM(false)} />
      ) : (
        <button
          onClick={() => setShowAddLLM(true)}
          className="w-full flex items-center justify-center gap-1.5 px-3 py-2.5 rounded-lg
            border border-dashed border-[var(--color-border)] text-xs
            text-[var(--color-text-muted)] hover:text-[var(--color-text-secondary)]
            hover:border-[var(--color-text-muted)] transition-colors"
        >
          <Plus size={14} />
          Add LLM Provider
        </button>
      )}
    </div>
  )
}
