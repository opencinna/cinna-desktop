import { useState } from 'react'
import {
  ArrowLeft,
  CheckCircle,
  Cloud,
  ExternalLink,
  Eye,
  EyeOff,
  HardDrive,
  KeyRound,
  Loader2,
  Server,
  Sparkles,
  XCircle,
  X
} from 'lucide-react'
import { useRegister, useCinnaOAuthAbort } from '../../hooks/useAuth'
import { useTestProviderKey, useUpsertProvider } from '../../hooks/useProviders'
import { useUpsertChatMode } from '../../hooks/useChatModes'
import {
  readSelfHostedHistory,
  writeSelfHostedHistory,
  prependSelfHostedHistory
} from '../../constants/selfHostedHistory'
import { pickDefaultModelId } from '../../../../shared/modelDefaults'

interface OnboardingScreenProps {
  onComplete: () => void
}

type Step =
  | 'welcome'
  | 'provider-type'
  | 'provider-key'
  | 'cinna-hosting'
  | 'cinna-waiting'

type ProviderType = 'anthropic' | 'openai' | 'gemini'

interface ProviderOption {
  type: ProviderType
  name: string
  description: string
  colorPreset: string
  pricingUrl?: string
  apiKeyUrl?: string
}

const PROVIDER_OPTIONS: ProviderOption[] = [
  {
    type: 'anthropic',
    name: 'Anthropic',
    description: 'Claude models (Opus, Sonnet, Haiku)',
    colorPreset: 'amber',
    pricingUrl: 'https://claude.com/pricing#api',
    apiKeyUrl: 'https://platform.claude.com/settings/keys'
  },
  {
    type: 'openai',
    name: 'OpenAI',
    description: 'ChatGPT (pro, mini, reasoning)',
    colorPreset: 'emerald',
    pricingUrl: 'https://openai.com/api/pricing/',
    apiKeyUrl: 'https://platform.openai.com/api-keys'
  },
  {
    type: 'gemini',
    name: 'Google Gemini',
    description: 'Gemini (pro, flash)',
    colorPreset: 'sky',
    pricingUrl: 'https://ai.google.dev/gemini-api/docs/pricing',
    apiKeyUrl: 'https://aistudio.google.com/app/api-keys'
  }
]


const inputClass =
  'w-full px-3 py-2 text-sm rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] text-[var(--color-text)] placeholder:text-[var(--color-text-muted)] focus:outline-none focus:ring-1 focus:ring-[var(--color-accent)]'

const btnSecondaryClass =
  'px-4 py-2 text-sm rounded-md border border-[var(--color-border)] text-[var(--color-text-secondary)] hover:bg-[var(--color-bg-hover)] transition-colors disabled:opacity-50'

const btnPrimaryClass =
  'px-5 py-2 text-sm rounded-md bg-[var(--color-accent)] text-white hover:opacity-90 transition-opacity disabled:opacity-50'

export function OnboardingScreen({ onComplete }: OnboardingScreenProps): React.JSX.Element {
  const [step, setStep] = useState<Step>('welcome')

  // Path A — Personal credentials
  const [selectedProvider, setSelectedProvider] = useState<ProviderOption | null>(null)
  const [apiKey, setApiKey] = useState('')
  const [showKey, setShowKey] = useState(false)
  const [selectedModelId, setSelectedModelId] = useState<string | null>(null)
  const [providerError, setProviderError] = useState<string | null>(null)

  // Path B — Cinna server
  const [cinnaHostingType, setCinnaHostingType] = useState<'cloud' | 'self_hosted'>('self_hosted')
  const [cinnaServerUrl, setCinnaServerUrl] = useState('')
  const [selfHostedHistory, setSelfHostedHistory] = useState<string[]>(() =>
    readSelfHostedHistory()
  )
  const [cinnaError, setCinnaError] = useState('')

  const testKey = useTestProviderKey()
  const upsertProvider = useUpsertProvider()
  const upsertChatMode = useUpsertChatMode()
  const register = useRegister()
  const cinnaAbort = useCinnaOAuthAbort()

  // Drop any stale test result so the "Save & start" button can't proceed
  // against an outdated validation. Called whenever the inputs that feed
  // testKey change (the API key or the selected provider).
  const resetTestState = (): void => {
    testKey.reset()
    setSelectedModelId(null)
    setProviderError(null)
  }

  const handleSkip = (): void => {
    onComplete()
  }

  // ─── Path A handlers ──────────────────────────────────────────────────────
  const handleSelectProvider = (provider: ProviderOption): void => {
    setSelectedProvider(provider)
    setApiKey('')
    resetTestState()
    setStep('provider-key')
  }

  const handleApiKeyChange = (value: string): void => {
    setApiKey(value)
    resetTestState()
  }

  const handleTestKey = (): void => {
    if (!selectedProvider || !apiKey.trim()) return
    setProviderError(null)
    testKey.mutate({ type: selectedProvider.type, apiKey: apiKey.trim() })
  }

  const handleSaveAndFinish = async (): Promise<void> => {
    if (!selectedProvider || !apiKey.trim()) return
    if (!testKey.data?.success) return
    setProviderError(null)

    const models = testKey.data.models ?? []
    // No explicit pick → choose a generally-available default, skipping
    // access-gated tiers (Fable/Mythos) that list first but the account may not
    // be able to call (would 404 on the first chat).
    const modelId = selectedModelId ?? pickDefaultModelId(models.map((m) => m.id))

    // Provider creation is the load-bearing step — without it, the user can't
    // chat at all. Block on its failure.
    let providerId: string
    try {
      const result = await upsertProvider.mutateAsync({
        type: selectedProvider.type,
        name: selectedProvider.name,
        apiKey: apiKey.trim(),
        enabled: true,
        defaultModelId: modelId
      })
      providerId = result.id
    } catch (err) {
      setProviderError(err instanceof Error ? err.message : String(err))
      return
    }

    // Default chat mode is a convenience — if it fails we still drop the user
    // into the app rather than stranding them on the onboarding screen with a
    // half-created account. They can configure a mode later from Settings.
    try {
      await upsertChatMode.mutateAsync({
        name: 'Default',
        providerId,
        modelId,
        mcpProviderIds: [],
        colorPreset: selectedProvider.colorPreset,
        isDefault: true
      })
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn('Onboarding: default chat mode creation failed', err)
    }

    onComplete()
  }

  // ─── Path B handlers ──────────────────────────────────────────────────────
  const connectSelfHosted = async (rawUrl: string): Promise<void> => {
    setCinnaError('')
    const trimmedUrl = rawUrl.trim()
    if (!trimmedUrl) {
      setCinnaError('Server URL is required')
      return
    }
    setCinnaServerUrl(trimmedUrl)
    setStep('cinna-waiting')

    const result = await register.mutateAsync({
      accountType: 'cinna',
      cinnaHostingType: 'self_hosted',
      cinnaServerUrl: trimmedUrl
    })

    if (result.success) {
      const next = prependSelfHostedHistory(selfHostedHistory, trimmedUrl)
      writeSelfHostedHistory(next)
      setSelfHostedHistory(next)
      onComplete()
    } else {
      setCinnaError(result.error ?? 'Authentication failed')
      setStep('cinna-hosting')
    }
  }

  const handleCinnaConnect = (): void => {
    if (cinnaHostingType === 'cloud') return
    void connectSelfHosted(cinnaServerUrl)
  }

  const handleCinnaAbort = (): void => {
    cinnaAbort.mutate()
    setStep('cinna-hosting')
    setCinnaError('Authorization cancelled')
  }

  const handleRemoveHistoryEntry = (url: string): void => {
    const next = selfHostedHistory.filter((u) => u !== url)
    writeSelfHostedHistory(next)
    setSelfHostedHistory(next)
  }

  // ─── Rendering ────────────────────────────────────────────────────────────
  const renderStep = (): React.JSX.Element => {
    if (step === 'welcome') {
      return (
        <div className="space-y-6">
          <div className="text-center space-y-2">
            <div className="inline-flex items-center justify-center w-14 h-14 rounded-2xl bg-[var(--color-accent)]/10">
              <Sparkles size={28} className="text-[var(--color-accent)]" />
            </div>
            <div className="text-lg font-semibold text-[var(--color-text)]">
              Welcome to Cinna
            </div>
            <div className="text-xs text-[var(--color-text-muted)]">
              Pick how you want to start chatting
            </div>
            <div className="text-[11px] text-[var(--color-text-muted)]">
              You can always configure that later
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <button
              type="button"
              onClick={() => setStep('provider-type')}
              className="flex flex-col items-center text-center gap-2 p-4 rounded-lg border border-[var(--color-border)] hover:bg-[var(--color-bg-hover)] hover:border-[var(--color-text-muted)] transition-colors"
            >
              <KeyRound size={22} className="text-[var(--color-text-muted)]" />
              <div>
                <div className="text-sm font-medium text-[var(--color-text)]">API key</div>
                <div className="text-[11px] text-[var(--color-text-muted)] mt-0.5">
                  Use your own API key from a provider (Anthropic, OpenAI, Google)
                </div>
              </div>
            </button>

            <button
              type="button"
              onClick={() => setStep('cinna-hosting')}
              className="flex flex-col items-center text-center gap-2 p-4 rounded-lg border border-[var(--color-border)] hover:bg-[var(--color-bg-hover)] hover:border-[var(--color-text-muted)] transition-colors"
            >
              <Server size={22} className="text-[var(--color-text-muted)]" />
              <div>
                <div className="text-sm font-medium text-[var(--color-text)]">Cinna Server</div>
                <div className="text-[11px] text-[var(--color-text-muted)] mt-0.5">
                  Connect to a Cinna instance and use your agents right away
                </div>
              </div>
            </button>
          </div>

          <div className="text-center">
            <button
              type="button"
              onClick={handleSkip}
              className="text-xs text-[var(--color-text-muted)] hover:text-[var(--color-text-secondary)] transition-colors"
            >
              Skip for now
            </button>
          </div>
        </div>
      )
    }

    if (step === 'provider-type') {
      return (
        <div className="space-y-4">
          <button
            type="button"
            onClick={() => setStep('welcome')}
            className="flex items-center gap-1 text-xs text-[var(--color-text-muted)] hover:text-[var(--color-text-secondary)] transition-colors"
          >
            <ArrowLeft size={12} />
            Back
          </button>

          <div className="text-sm font-semibold text-[var(--color-text)]">AI provider</div>

          <div className="space-y-2">
            {PROVIDER_OPTIONS.map((p) => (
              <button
                key={p.type}
                type="button"
                onClick={() => handleSelectProvider(p)}
                className="w-full text-left p-3 rounded-lg border border-[var(--color-border)] hover:bg-[var(--color-bg-hover)] hover:border-[var(--color-text-muted)] transition-colors"
              >
                <div className="text-sm font-medium text-[var(--color-text)]">{p.name}</div>
                <div className="text-[11px] text-[var(--color-text-muted)]">{p.description}</div>
              </button>
            ))}
          </div>
        </div>
      )
    }

    if (step === 'provider-key' && selectedProvider) {
      const testResult = testKey.data
      const models = testResult?.success ? testResult.models ?? [] : []
      const canSave = testResult?.success && !!apiKey.trim() && !upsertProvider.isPending

      return (
        <div className="space-y-4">
          <button
            type="button"
            onClick={() => setStep('provider-type')}
            className="flex items-center gap-1 text-xs text-[var(--color-text-muted)] hover:text-[var(--color-text-secondary)] transition-colors"
          >
            <ArrowLeft size={12} />
            Back
          </button>

          <div>
            <div className="text-sm font-semibold text-[var(--color-text)]">
              {selectedProvider.name} API key
            </div>
            <div className="text-[11px] text-[var(--color-text-muted)] mt-0.5">
              {selectedProvider.description}
            </div>
          </div>

          <div className="space-y-1.5">
            <label className="block text-[11px] text-[var(--color-text-muted)]">API Key</label>
            <div className="relative">
              <input
                type={showKey ? 'text' : 'password'}
                value={apiKey}
                onChange={(e) => handleApiKeyChange(e.target.value)}
                placeholder="Paste your API key"
                autoFocus
                className={`${inputClass} pr-9`}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && apiKey.trim() && !testKey.isPending) {
                    e.preventDefault()
                    handleTestKey()
                  }
                }}
              />
              <button
                type="button"
                onClick={() => setShowKey(!showKey)}
                className="absolute right-2 top-1/2 -translate-y-1/2 text-[var(--color-text-muted)] hover:text-[var(--color-text-secondary)]"
                aria-label={showKey ? 'Hide key' : 'Show key'}
              >
                {showKey ? <EyeOff size={14} /> : <Eye size={14} />}
              </button>
            </div>
            {(selectedProvider.apiKeyUrl || selectedProvider.pricingUrl) && (
              <div className="space-y-0.5 text-[11px] text-[var(--color-text-muted)]">
                {selectedProvider.apiKeyUrl && (
                  <div>
                    Where to create an API key?{' '}
                    <a
                      href={selectedProvider.apiKeyUrl}
                      target="_blank"
                      rel="noreferrer noopener"
                      className="inline-flex items-center gap-0.5 text-[var(--color-accent)] hover:underline"
                    >
                      {selectedProvider.apiKeyUrl.replace(/^https?:\/\//, '')}
                      <ExternalLink size={10} />
                    </a>
                  </div>
                )}
                {selectedProvider.pricingUrl && (
                  <div>
                    See current model prices at{' '}
                    <a
                      href={selectedProvider.pricingUrl}
                      target="_blank"
                      rel="noreferrer noopener"
                      className="inline-flex items-center gap-0.5 text-[var(--color-accent)] hover:underline"
                    >
                      {selectedProvider.pricingUrl.replace(/^https?:\/\//, '')}
                      <ExternalLink size={10} />
                    </a>
                  </div>
                )}
              </div>
            )}
          </div>

          {testKey.isPending && (
            <div className="flex items-center gap-1.5 text-xs text-[var(--color-text-muted)]">
              <Loader2 size={12} className="animate-spin" />
              Validating key…
            </div>
          )}

          {testResult && !testKey.isPending && (
            <div className="flex items-start gap-1.5 text-xs">
              {testResult.success ? (
                <>
                  <CheckCircle
                    size={14}
                    className="text-[var(--color-success)] mt-0.5 shrink-0"
                  />
                  <span className="text-[var(--color-success)]">
                    Key valid — {testResult.models?.length ?? 0} models available
                  </span>
                </>
              ) : (
                <>
                  <XCircle size={14} className="text-[var(--color-danger)] mt-0.5 shrink-0" />
                  <span className="text-[var(--color-danger)] break-words">
                    {testResult.error ?? 'Invalid API key'}
                  </span>
                </>
              )}
            </div>
          )}

          {testResult?.success && models.length > 0 && (
            <div className="space-y-1.5">
              <label className="block text-[11px] text-[var(--color-text-muted)]">
                Default model
              </label>
              <select
                value={selectedModelId ?? ''}
                onChange={(e) => setSelectedModelId(e.target.value || null)}
                className={`${inputClass} cursor-pointer`}
              >
                <option value="">
                  Recommended (
                  {models.find((m) => m.id === pickDefaultModelId(models.map((x) => x.id)))?.name ??
                    models[0]?.name}
                  )
                </option>
                {models.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.name}
                  </option>
                ))}
              </select>
            </div>
          )}

          {providerError && (
            <div className="flex items-center gap-1.5 text-xs text-[var(--color-danger)]">
              <XCircle size={12} />
              <span className="break-words">{providerError}</span>
            </div>
          )}

          <div className="flex justify-end gap-2 pt-1">
            <button
              type="button"
              onClick={handleTestKey}
              disabled={!apiKey.trim() || testKey.isPending}
              className={btnSecondaryClass}
            >
              Test
            </button>
            <button
              type="button"
              onClick={handleSaveAndFinish}
              disabled={!canSave}
              className={btnPrimaryClass}
            >
              {upsertProvider.isPending || upsertChatMode.isPending ? (
                <span className="flex items-center gap-1.5">
                  <Loader2 size={12} className="animate-spin" />
                  Saving…
                </span>
              ) : (
                'Save & start'
              )}
            </button>
          </div>
        </div>
      )
    }

    if (step === 'cinna-hosting') {
      return (
        <div className="space-y-4">
          <button
            type="button"
            onClick={() => setStep('welcome')}
            className="flex items-center gap-1 text-xs text-[var(--color-text-muted)] hover:text-[var(--color-text-secondary)] transition-colors"
          >
            <ArrowLeft size={12} />
            Back
          </button>

          <div className="text-sm font-semibold text-[var(--color-text)]">Connect to Cinna</div>

          <div className="flex gap-3">
            <button
              type="button"
              onClick={() => setCinnaHostingType('self_hosted')}
              className={`flex-1 flex flex-col items-center gap-2 p-4 rounded-lg border transition-colors text-center ${
                cinnaHostingType === 'self_hosted'
                  ? 'border-[var(--color-accent)] bg-[var(--color-accent)]/5'
                  : 'border-[var(--color-border)] hover:bg-[var(--color-bg-hover)]'
              }`}
            >
              <HardDrive size={20} className="text-[var(--color-text-muted)]" />
              <div>
                <div className="text-sm font-medium text-[var(--color-text)]">Self-Hosted</div>
                <div className="text-[11px] text-[var(--color-text-muted)]">Your own server</div>
              </div>
            </button>

            <button
              type="button"
              onClick={() => setCinnaHostingType('cloud')}
              className={`flex-1 flex flex-col items-center gap-2 p-4 rounded-lg border transition-colors text-center ${
                cinnaHostingType === 'cloud'
                  ? 'border-[var(--color-accent)] bg-[var(--color-accent)]/5'
                  : 'border-[var(--color-border)] hover:bg-[var(--color-bg-hover)]'
              }`}
            >
              <Cloud size={20} className="text-[var(--color-text-muted)]" />
              <div>
                <div className="text-sm font-medium text-[var(--color-text)]">Cloud</div>
                <div className="text-[11px] text-[var(--color-text-muted)]">opencinna.io</div>
              </div>
            </button>
          </div>

          {cinnaHostingType === 'cloud' && (
            <div className="rounded-md border border-[var(--color-border)] bg-[var(--color-bg-hover)] px-3 py-2 text-xs text-[var(--color-text-secondary)]">
              <span className="font-medium text-[var(--color-text)]">Under Development.</span>{' '}
              opencinna.io cloud accounts are not available yet. For now, please use a self-hosted
              Cinna server.
            </div>
          )}

          {cinnaHostingType === 'self_hosted' && (
            <>
              <input
                type="url"
                placeholder="https://your-server.com"
                value={cinnaServerUrl}
                onChange={(e) => setCinnaServerUrl(e.target.value)}
                autoFocus
                className={inputClass}
              />

              {selfHostedHistory.length > 0 && (
                <div className="space-y-1">
                  <div className="text-[11px] text-[var(--color-text-muted)]">Recent servers</div>
                  <ul className="space-y-1">
                    {selfHostedHistory.map((url) => (
                      <li key={url}>
                        <div
                          role="button"
                          tabIndex={0}
                          onClick={() => connectSelfHosted(url)}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter' || e.key === ' ') {
                              e.preventDefault()
                              connectSelfHosted(url)
                            }
                          }}
                          title={`Connect to ${url}`}
                          aria-label={`Connect to ${url}`}
                          className="group w-full flex items-center gap-2 px-3 py-2 text-sm rounded-md border border-[var(--color-border)] text-[var(--color-text-secondary)] hover:bg-[var(--color-bg-hover)] hover:text-[var(--color-text)] focus:outline-none focus:ring-1 focus:ring-[var(--color-accent)] transition-colors cursor-pointer"
                        >
                          <span className="flex-1 truncate text-left">{url}</span>
                          <button
                            type="button"
                            onClick={(e) => {
                              e.stopPropagation()
                              handleRemoveHistoryEntry(url)
                            }}
                            onKeyDown={(e) => e.stopPropagation()}
                            title="Remove from history"
                            aria-label={`Remove ${url} from history`}
                            className="opacity-0 group-hover:opacity-100 focus:opacity-100 p-0.5 rounded text-[var(--color-text-muted)] hover:text-[var(--color-text)] transition-opacity"
                          >
                            <X size={14} />
                          </button>
                        </div>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </>
          )}

          {cinnaError && <div className="text-xs text-[var(--color-danger)]">{cinnaError}</div>}

          <div className="flex justify-end pt-1">
            <button
              type="button"
              onClick={handleCinnaConnect}
              disabled={register.isPending || cinnaHostingType === 'cloud'}
              className={btnPrimaryClass}
            >
              Connect
            </button>
          </div>
        </div>
      )
    }

    if (step === 'cinna-waiting') {
      return (
        <div className="space-y-4">
          <div className="flex flex-col items-center gap-3 py-6">
            <Loader2 size={28} className="text-[var(--color-accent)] animate-spin" />
            <div className="text-sm text-[var(--color-text-secondary)] text-center">
              Waiting for browser authorization…
            </div>
            <div className="text-xs text-[var(--color-text-muted)] text-center">
              Complete the sign-in in your browser to continue
            </div>
          </div>
          <button type="button" onClick={handleCinnaAbort} className={`w-full ${btnSecondaryClass}`}>
            Cancel
          </button>
        </div>
      )
    }

    return <></>
  }

  return (
    <div className="h-full flex flex-col items-center justify-center bg-[var(--color-bg)] px-4">
      <div className="titlebar fixed top-0 left-0 right-0 h-10" />

      <div className="w-full max-w-[28rem] rounded-xl border border-[var(--color-border)] bg-[var(--color-bg-secondary)] shadow-lg p-6">
        {renderStep()}
      </div>
    </div>
  )
}
