import { useState, useEffect, useRef } from 'react'
import {
  X,
  Eye,
  EyeOff,
  CheckCircle,
  XCircle,
  Loader2,
  Search,
  ChevronDown
} from 'lucide-react'
import { useUpsertProvider, useTestProviderKey } from '../../hooks/useProviders'

const PROVIDER_TYPES = [
  { type: 'anthropic', name: 'Anthropic', description: 'Claude models (Opus, Sonnet, Haiku)' },
  { type: 'openai', name: 'OpenAI', description: 'GPT-4o, o3, o4-mini' },
  { type: 'gemini', name: 'Google Gemini', description: 'Gemini 2.5 Pro, Flash' }
]

interface LLMProviderFormProps {
  onClose: () => void
}

export function LLMProviderForm({ onClose }: LLMProviderFormProps): React.JSX.Element {
  const [selectedType, setSelectedType] = useState<string | null>(null)
  const [search, setSearch] = useState('')
  const [dropdownOpen, setDropdownOpen] = useState(true)
  const [apiKey, setApiKey] = useState('')
  const [showKey, setShowKey] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)
  const [selectedDefaultModelId, setSelectedDefaultModelId] = useState<string | null>(null)
  const dropdownRef = useRef<HTMLDivElement>(null)

  const upsert = useUpsertProvider()
  const testKey = useTestProviderKey()

  const filtered = PROVIDER_TYPES.filter(
    (p) =>
      p.name.toLowerCase().includes(search.toLowerCase()) ||
      p.description.toLowerCase().includes(search.toLowerCase())
  )

  const selectedProvider = PROVIDER_TYPES.find((p) => p.type === selectedType)

  // Close dropdown on outside click
  useEffect(() => {
    const handler = (e: MouseEvent): void => {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
        setDropdownOpen(false)
      }
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [])

  const handleTest = (): void => {
    if (!selectedType || !apiKey) return
    testKey.mutate({ type: selectedType, apiKey })
  }

  const handleSave = (): void => {
    if (!selectedType || !apiKey) return
    setSaveError(null)
    const providerName = selectedProvider?.name ?? selectedType
    upsert.mutate(
      {
        type: selectedType,
        name: providerName,
        apiKey,
        enabled: true,
        defaultModelId: selectedDefaultModelId
      },
      {
        onSuccess: () => onClose(),
        onError: (err) => setSaveError(String(err))
      }
    )
  }

  const inputClass =
    'w-full bg-[var(--color-bg)] text-[var(--color-text)] px-2.5 py-1.5 rounded-md text-xs border border-[var(--color-border)] focus:border-[var(--color-accent)] focus:outline-none'

  return (
    <div className="rounded-lg border border-[var(--color-accent)]/40 bg-[var(--color-bg-secondary)]">
      <div className="flex items-center justify-between px-4 py-2.5 border-b border-[var(--color-border)]">
        <span className="font-medium text-xs">Add LLM Provider</span>
        <button
          type="button"
          onClick={onClose}
          className="p-1 rounded hover:bg-[var(--color-bg-hover)] text-[var(--color-text-muted)] transition-colors"
        >
          <X size={12} />
        </button>
      </div>

      <div className="px-4 py-3 space-y-2.5">
        {/* Provider type selector */}
        <div ref={dropdownRef} className="relative">
          <label className="block text-[10px] text-[var(--color-text-muted)] mb-0.5">
            Provider Type
          </label>
          {selectedType && !dropdownOpen ? (
            <button
              type="button"
              onClick={() => {
                setDropdownOpen(true)
                setSearch('')
              }}
              className={`${inputClass} flex items-center justify-between text-left`}
            >
              <span>{selectedProvider?.name}</span>
              <ChevronDown size={12} className="text-[var(--color-text-muted)]" />
            </button>
          ) : (
            <>
              <div className="relative">
                <Search
                  size={12}
                  className="absolute left-2.5 top-1/2 -translate-y-1/2 text-[var(--color-text-muted)]"
                />
                <input
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  onFocus={() => setDropdownOpen(true)}
                  placeholder="Search providers..."
                  autoFocus
                  className={`${inputClass} pl-7`}
                />
              </div>
              {dropdownOpen && (
                <div className="absolute z-10 w-full mt-1 rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] shadow-lg overflow-hidden">
                  {filtered.length === 0 ? (
                    <div className="px-3 py-2 text-[10px] text-[var(--color-text-muted)]">
                      No providers match
                    </div>
                  ) : (
                    filtered.map((p) => (
                      <button
                        type="button"
                        key={p.type}
                        onClick={() => {
                          setSelectedType(p.type)
                          setDropdownOpen(false)
                          setSearch('')
                          setApiKey('')
                          setSelectedDefaultModelId(null)
                          testKey.reset()
                        }}
                        className={`w-full text-left px-3 py-2 hover:bg-[var(--color-bg-hover)] transition-colors ${
                          selectedType === p.type ? 'bg-[var(--color-bg-hover)]' : ''
                        }`}
                      >
                        <div className="text-xs font-medium">{p.name}</div>
                        <div className="text-[10px] text-[var(--color-text-muted)]">
                          {p.description}
                        </div>
                      </button>
                    ))
                  )}
                </div>
              )}
            </>
          )}
        </div>

        {/* API key input - shown after type selected */}
        {selectedType && !dropdownOpen && (
          <>
            <div>
              <label className="block text-[10px] text-[var(--color-text-muted)] mb-0.5">
                API Key
              </label>
              <div className="relative">
                <input
                  type={showKey ? 'text' : 'password'}
                  value={apiKey}
                  onChange={(e) => setApiKey(e.target.value)}
                  placeholder="Paste your API key"
                  autoFocus
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
            </div>

            {/* Test result */}
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
                    <span className="text-[var(--color-success)]">
                      Valid - {testKey.data.models?.length ?? 0} models available
                    </span>
                  </>
                ) : (
                  <>
                    <XCircle size={10} className="text-[var(--color-danger)]" />
                    <span className="text-[var(--color-danger)] truncate">{testKey.data.error}</span>
                  </>
                )}
              </div>
            )}

            {/* Default model selector - shown after successful test */}
            {testKey.data?.success && testKey.data.models && testKey.data.models.length > 0 && (
              <div>
                <label className="block text-[10px] text-[var(--color-text-muted)] mb-0.5">
                  Default Model
                </label>
                <select
                  value={selectedDefaultModelId ?? ''}
                  onChange={(e) => setSelectedDefaultModelId(e.target.value || null)}
                  className={`${inputClass} cursor-pointer`}
                >
                  <option value="">First available</option>
                  {testKey.data.models.map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.name}
                    </option>
                  ))}
                </select>
              </div>
            )}

            {/* Error display */}
            {saveError && (
              <div className="flex items-center gap-1.5 text-[10px] text-[var(--color-danger)]">
                <XCircle size={10} />
                <span>{saveError}</span>
              </div>
            )}

            {/* Buttons */}
            <div className="flex justify-end gap-2 pt-1">
              <button
                type="button"
                onClick={onClose}
                className="px-3 py-1.5 rounded-md text-xs font-medium text-[var(--color-text-muted)]
                  hover:text-[var(--color-text-secondary)] transition-colors"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={handleTest}
                disabled={!apiKey || testKey.isPending}
                className="px-3 py-1.5 rounded-md text-xs font-medium border border-[var(--color-border)]
                  text-[var(--color-text-secondary)] hover:bg-[var(--color-bg-hover)]
                  disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
              >
                Test
              </button>
              <button
                type="button"
                onClick={handleSave}
                disabled={!apiKey || upsert.isPending}
                className="px-3 py-1.5 rounded-md text-xs font-medium bg-[var(--color-accent)] hover:bg-[var(--color-accent-hover)]
                  text-white disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
              >
                {upsert.isPending ? (
                  <span className="flex items-center gap-1">
                    <Loader2 size={10} className="animate-spin" /> Saving...
                  </span>
                ) : (
                  'Save Provider'
                )}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  )
}
