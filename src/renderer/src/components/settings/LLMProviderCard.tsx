import { useState } from 'react'
import {
  Trash2,
  ChevronDown,
  Eye,
  EyeOff,
  CheckCircle,
  XCircle,
  Loader2,
  Circle,
  Star
} from 'lucide-react'
import {
  useUpsertProvider,
  useDeleteProvider,
  useTestProvider,
  useTestProviderKey
} from '../../hooks/useProviders'
import { AnimatedCollapse } from '../ui/AnimatedCollapse'

const PROVIDER_LABELS: Record<string, string> = {
  anthropic: 'Anthropic',
  openai: 'OpenAI',
  gemini: 'Google Gemini'
}

interface LLMProviderCardProps {
  provider: {
    id: string
    type: string
    name: string
    enabled: boolean
    isDefault: boolean
    defaultModelId: string | null
    hasApiKey: boolean
  }
}

export function LLMProviderCard({ provider }: LLMProviderCardProps): React.JSX.Element {
  const [expanded, setExpanded] = useState(false)
  const [apiKey, setApiKey] = useState('')
  const [showKey, setShowKey] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)
  const [showModelSelector, setShowModelSelector] = useState(false)

  const upsert = useUpsertProvider()
  const deleteProvider = useDeleteProvider()
  const testProvider = useTestProvider()
  const testKey = useTestProviderKey()

  const handleToggle = (): void => {
    upsert.mutate({
      id: provider.id,
      type: provider.type,
      name: provider.name,
      enabled: !provider.enabled,
      // If disabling and it was default, unset default
      isDefault: !provider.enabled ? provider.isDefault : false
    })
  }

  const handleToggleDefault = (): void => {
    upsert.mutate({
      id: provider.id,
      type: provider.type,
      name: provider.name,
      isDefault: !provider.isDefault
    })
  }

  const handleSave = (): void => {
    if (!apiKey) return
    setSaveError(null)
    upsert.mutate(
      {
        id: provider.id,
        type: provider.type,
        name: provider.name,
        apiKey,
        enabled: true
      },
      {
        onSuccess: () => {
          setApiKey('')
          testKey.reset()
        },
        onError: (err) => setSaveError(String(err))
      }
    )
  }

  const handleTestSaved = (): void => {
    setShowModelSelector(false)
    testProvider.mutate(provider.id)
  }

  const handleTestKey = (): void => {
    if (!apiKey) return
    testKey.mutate({ type: provider.type, apiKey })
  }

  const handleSelectModel = (): void => {
    setShowModelSelector(true)
    testProvider.mutate(provider.id)
  }

  const handleSetDefaultModel = (modelId: string | null): void => {
    upsert.mutate({
      id: provider.id,
      type: provider.type,
      name: provider.name,
      defaultModelId: modelId || null
    })
  }

  // Models only shown when user explicitly clicks "Select Model"
  const availableModels = showModelSelector
    ? (testProvider.data?.success ? testProvider.data.models : undefined)
    : undefined

  const statusColor = provider.hasApiKey && provider.enabled
    ? 'text-[var(--color-success)]'
    : provider.hasApiKey
      ? 'text-[var(--color-text-muted)]'
      : 'text-[var(--color-danger)]'

  const inputClass =
    'w-full bg-[var(--color-bg)] text-[var(--color-text)] px-2.5 py-1.5 rounded-md text-xs border border-[var(--color-border)] focus:border-[var(--color-accent)] focus:outline-none'

  return (
    <div className="rounded-lg border border-[var(--color-border)] bg-[var(--color-bg-secondary)] overflow-hidden">
      <div
        className="flex items-center gap-2 px-4 py-2.5 cursor-pointer hover:bg-[var(--color-bg-hover)] transition-colors"
        onClick={() => setExpanded(!expanded)}
      >
        <Circle size={6} className={`fill-current ${statusColor}`} />
        <div className="flex-1 min-w-0">
          <span className="font-medium text-xs">{provider.name}</span>
          <span className="text-[10px] text-[var(--color-text-muted)] ml-1.5">
            {PROVIDER_LABELS[provider.type] ?? provider.type}
          </span>
        </div>

        <button
          type="button"
          onClick={(e) => { e.stopPropagation(); handleToggleDefault() }}
          disabled={!provider.enabled}
          className={`p-1 rounded transition-colors ${
            provider.isDefault
              ? 'text-[var(--color-warning)]'
              : 'text-[var(--color-text-muted)] hover:text-[var(--color-warning)]'
          } disabled:opacity-30 disabled:cursor-not-allowed`}
          title={provider.isDefault ? 'Remove as default' : 'Set as default'}
        >
          <Star size={12} className={provider.isDefault ? 'fill-current' : ''} />
        </button>

        <button
          type="button"
          onClick={(e) => { e.stopPropagation(); handleToggle() }}
          className={`relative w-9 h-5 rounded-full transition-colors shrink-0 ${
            provider.enabled ? 'bg-[var(--color-accent)]' : 'bg-[var(--color-border)]'
          }`}
        >
          <div
            className={`absolute top-0.5 w-4 h-4 rounded-full bg-white transition-transform ${
              provider.enabled ? 'left-[18px]' : 'left-0.5'
            }`}
          />
        </button>

        <button
          type="button"
          onClick={(e) => { e.stopPropagation(); deleteProvider.mutate(provider.id) }}
          className="p-1 rounded hover:bg-[var(--color-danger)]/20 text-[var(--color-text-muted)] hover:text-[var(--color-danger)] transition-colors"
        >
          <Trash2 size={12} />
        </button>

        <div className={`p-1 text-[var(--color-text-muted)] transition-transform duration-200 ${expanded ? 'rotate-180' : ''}`}>
          <ChevronDown size={12} />
        </div>
      </div>

      <AnimatedCollapse open={expanded}>
        <div className="border-t border-[var(--color-border)] px-4 py-3 space-y-2.5">
          <div>
            <label className="block text-[10px] text-[var(--color-text-muted)] mb-0.5">
              API Key {provider.hasApiKey && <span className="text-[var(--color-success)]">(saved)</span>}
            </label>
            <div className="flex gap-1.5">
              <div className="flex-1 relative">
                <input
                  type={showKey ? 'text' : 'password'}
                  value={apiKey}
                  onChange={(e) => setApiKey(e.target.value)}
                  placeholder={provider.hasApiKey ? 'Enter new key to replace' : 'Enter API key'}
                  className={`${inputClass} pr-8`}
                />
                <button
                  type="button"
                  onClick={() => setShowKey(!showKey)}
                  className="absolute right-2 top-1/2 -translate-y-1/2 text-[var(--color-text-muted)] hover:text-[var(--color-text-secondary)]"
                >
                  {showKey ? <EyeOff size={12} /> : <Eye size={12} />}
                </button>
              </div>
              {apiKey && (
                <button
                  type="button"
                  onClick={handleTestKey}
                  disabled={testKey.isPending}
                  className="px-3 py-1.5 rounded-md text-xs font-medium border border-[var(--color-border)]
                    text-[var(--color-text-secondary)] hover:bg-[var(--color-bg-hover)]
                    disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
                >
                  Test
                </button>
              )}
              <button
                type="button"
                onClick={handleSave}
                disabled={!apiKey || upsert.isPending}
                className="px-3 py-1.5 rounded-md text-xs font-medium bg-[var(--color-accent)] hover:bg-[var(--color-accent-hover)]
                  text-white disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
              >
                Save
              </button>
            </div>
          </div>

          {/* Test result for new key */}
          {testKey.isPending && (
            <div className="flex items-center gap-1.5 text-[10px] text-[var(--color-text-muted)]">
              <Loader2 size={10} className="animate-spin" /> Validating key...
            </div>
          )}
          {testKey.data && (
            <div className="flex items-center gap-1.5 text-[10px]">
              {testKey.data.success ? (
                <>
                  <CheckCircle size={10} className="text-[var(--color-success)]" />
                  <span className="text-[var(--color-success)]">Valid key</span>
                </>
              ) : (
                <>
                  <XCircle size={10} className="text-[var(--color-danger)]" />
                  <span className="text-[var(--color-danger)] truncate">{testKey.data.error}</span>
                </>
              )}
            </div>
          )}

          {/* Save error */}
          {saveError && (
            <div className="flex items-center gap-1.5 text-[10px] text-[var(--color-danger)]">
              <XCircle size={10} />
              <span>{saveError}</span>
            </div>
          )}

          {/* Test saved key & Select model */}
          {provider.hasApiKey && !apiKey && (
            <div className="flex items-center gap-3">
              <button
                type="button"
                onClick={handleTestSaved}
                disabled={testProvider.isPending && !showModelSelector}
                className="text-[10px] text-[var(--color-accent)] hover:text-[var(--color-accent-hover)] font-medium transition-colors"
              >
                {testProvider.isPending && !showModelSelector ? (
                  <span className="flex items-center gap-1">
                    <Loader2 size={10} className="animate-spin" /> Testing...
                  </span>
                ) : (
                  'Test Connection'
                )}
              </button>

              <button
                type="button"
                onClick={handleSelectModel}
                disabled={testProvider.isPending && showModelSelector}
                className="text-[10px] text-[var(--color-accent)] hover:text-[var(--color-accent-hover)] font-medium transition-colors"
              >
                {testProvider.isPending && showModelSelector ? (
                  <span className="flex items-center gap-1">
                    <Loader2 size={10} className="animate-spin" /> Loading models...
                  </span>
                ) : (
                  'Select Model'
                )}
              </button>

              {/* Test connection result (only when not loading models) */}
              {testProvider.data && !showModelSelector && (
                <span className="flex items-center gap-1 text-[10px]">
                  {testProvider.data.success ? (
                    <>
                      <CheckCircle size={10} className="text-[var(--color-success)]" />
                      <span className="text-[var(--color-success)]">Connected</span>
                    </>
                  ) : (
                    <>
                      <XCircle size={10} className="text-[var(--color-danger)]" />
                      <span className="text-[var(--color-danger)] truncate max-w-[200px]">
                        {testProvider.data.error}
                      </span>
                    </>
                  )}
                </span>
              )}
            </div>
          )}

          {/* Model selector (shown after clicking Select Model) */}
          {showModelSelector && testProvider.data && !testProvider.data.success && (
            <div className="flex items-center gap-1.5 text-[10px]">
              <XCircle size={10} className="text-[var(--color-danger)]" />
              <span className="text-[var(--color-danger)] truncate">
                Failed to load models: {testProvider.data.error}
              </span>
            </div>
          )}
          {availableModels && availableModels.length > 0 && (
            <div>
              <label className="block text-[10px] text-[var(--color-text-muted)] mb-0.5">
                Default Model
              </label>
              <select
                value={provider.defaultModelId ?? ''}
                onChange={(e) => handleSetDefaultModel(e.target.value || null)}
                className={`${inputClass} cursor-pointer`}
              >
                <option value="">First available</option>
                {availableModels.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.name}
                  </option>
                ))}
              </select>
            </div>
          )}

          {/* Show current default model when model selector not open */}
          {!availableModels && provider.defaultModelId && (
            <div className="flex items-center gap-1.5 text-[10px] text-[var(--color-text-muted)]">
              Default model: <span className="text-[var(--color-text-secondary)]">{provider.defaultModelId}</span>
            </div>
          )}
        </div>
      </AnimatedCollapse>
    </div>
  )
}
