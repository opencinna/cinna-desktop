import { useId, useState } from 'react'
import {
  Trash2,
  ChevronDown,
  Eye,
  EyeOff,
  CheckCircle,
  XCircle,
  Loader2,
  Circle
} from 'lucide-react'
import {
  useUpsertProvider,
  useDeleteProvider,
  useTestProvider,
  useTestProviderKey
} from '../../hooks/useProviders'
import { AnimatedCollapse } from '../ui/AnimatedCollapse'
import { unwrapIpcError } from '../../utils/ipcError'
import {
  isCredentialUsable,
  normaliseOllamaHost,
  requiresApiKey,
  OLLAMA_DEFAULT_HOST
} from '../../../../shared/credentials'

const PROVIDER_LABELS: Record<string, string> = {
  anthropic: 'Anthropic',
  openai: 'OpenAI',
  gemini: 'Google Gemini',
  ollama: 'Ollama'
}

interface LLMProviderCardProps {
  provider: {
    id: string
    type: string
    name: string
    enabled: boolean
    defaultModelId: string | null
    hasApiKey: boolean
    /** The Ollama host, or a gateway URL. Null for the first-party providers. */
    baseUrl?: string | null
    unsupported?: boolean
  }
}

export function LLMProviderCard({ provider }: LLMProviderCardProps): React.JSX.Element {
  const [expanded, setExpanded] = useState(false)
  /**
   * Ids for `htmlFor` — and `useId` is not optional here the way it is on the
   * form: a settings page renders one of these per credential, so literal ids
   * would collide and each label would point at the first card's field.
   */
  const fieldId = useId()
  const [apiKey, setApiKey] = useState('')
  /**
   * A keyless credential's host, editable in place. Seeded from the row rather
   * than left blank: this field is not "enter a new value to replace the old
   * one" like the key above it — the current value is not a secret, so showing
   * it is both possible and the only way to *edit* rather than retype it.
   */
  const [host, setHost] = useState(provider.baseUrl ?? OLLAMA_DEFAULT_HOST)
  const [showKey, setShowKey] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)
  const [showModelSelector, setShowModelSelector] = useState(false)

  const upsert = useUpsertProvider()
  const deleteProvider = useDeleteProvider()
  const testProvider = useTestProvider()
  const testKey = useTestProviderKey()

  /** No API key by construction — the credential is a host (Ollama). */
  const keyless = !requiresApiKey(provider.type)
  const typeLabel = PROVIDER_LABELS[provider.type] ?? provider.type
  /**
   * The host without its scheme — `127.0.0.1:11599` — because the scheme is the
   * same on every row and the port is the whole of what differs.
   */
  const hostLabel = (provider.baseUrl ?? OLLAMA_DEFAULT_HOST).replace(/^https?:\/\//i, '')
  const subLabel = keyless
    ? hostLabel
    : typeLabel.toLowerCase() === provider.name.trim().toLowerCase()
      ? null
      : typeLabel

  /**
   * A host that will never resolve, so Save is disabled rather than left to be
   * refused by main after a round trip.
   *
   * The same rule as the Add form's, and it belongs in both: this card is the
   * *other* place a user types a host, and it had neither the check nor the
   * layout fix — a refusal arriving here pushed the Test Connection row down at
   * the moment of the click. Fixing one screen and not the other is how the two
   * come to behave differently for the same input.
   */
  const hostInvalid = keyless && host.trim() !== '' && normaliseOllamaHost(host) === null

  const handleToggle = (): void => {
    upsert.mutate({
      id: provider.id,
      type: provider.type,
      name: provider.name,
      enabled: !provider.enabled
    })
  }

  const handleSave = (): void => {
    if (keyless ? !host.trim() : !apiKey) return
    setSaveError(null)
    upsert.mutate(
      {
        id: provider.id,
        type: provider.type,
        name: provider.name,
        ...(keyless ? { baseUrl: host.trim() } : { apiKey }),
        enabled: true
      },
      {
        onSuccess: () => {
          setApiKey('')
          testKey.reset()
          // The connection verdict is about a *row*, and this call just replaced
          // it — so the sentence naming the old host ("Ollama isn't answering at
          // …:11599") must not survive a save that moved the credential to
          // …:11434. No comparison and no normalising needed: a successful save
          // is definitionally the end of what the previous test described.
          testProvider.reset()
        },
        onError: (err) => setSaveError(unwrapIpcError(err, 'The credential could not be saved.'))
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

  /**
   * The dot. Danger means "this credential cannot be used" — which for a keyed
   * provider is a missing key, and for a keyless one is never true: there is no
   * key to be missing, and whether Ollama is *running* is a live fact this card
   * reports through Test Connection rather than asserting in a dot that would go
   * red every time the user quit Ollama.
   */
  const statusColor = isCredentialUsable(provider)
    ? provider.enabled
      ? 'text-[var(--color-success)]'
      : 'text-[var(--color-text-muted)]'
    : 'text-[var(--color-danger)]'

  const inputClass =
    'w-full bg-[var(--color-bg)] text-[var(--color-text)] px-2.5 py-1.5 rounded-md text-[14px] border border-[var(--color-border)] focus:border-[var(--color-accent)] focus:outline-none'

  return (
    <div className="rounded-lg border border-[var(--color-border)] bg-[var(--color-bg-secondary)] overflow-hidden">
      <div
        className="flex items-center gap-2 px-4 py-2.5 cursor-pointer hover:bg-[var(--color-bg-hover)] transition-colors"
        onClick={() => setExpanded(!expanded)}
      >
        <Circle size={6} className={`fill-current ${statusColor}`} />
        <div className="flex-1 min-w-0">
          <span className="font-medium text-[14px]">{provider.name}</span>
          {/*
            The sub-line says whatever distinguishes this credential from its
            siblings, which is a different thing for the two kinds.
            
            For a **keyless** credential it is the host. Two Ollama rows are now
            reachable in one click by design — a mistyped port saved once, plus
            the offered real one — and with only a name they were indistinguishable
            in the list, in the chat-mode picker, and to
            `runtimeService.findCredential`, which resolves a manifest's
            `credential: "Ollama"` by list order. The host is the only thing that
            tells them apart, and it was visible only after expanding the card.
            
            For a **keyed** one it is the type, and only when it says something
            the name does not: every credential created from the picker takes the
            provider's display name, so this used to render "Ollama Ollama" and
            "Anthropic Anthropic" — a sub-line repeating its title exactly
            (rule 7). It still earns its place on a renamed credential.
          */}
          {subLabel && (
            <span className="text-[12px] text-[var(--color-text-muted)] ml-1.5">{subLabel}</span>
          )}
        </div>

        <button
          type="button"
          role="switch"
          aria-checked={provider.enabled}
          aria-label={`${provider.enabled ? 'Disable' : 'Enable'} ${provider.name}`}
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
          aria-label={`Delete ${provider.name}`}
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
          {/* The credential itself: a key to replace, or a host to edit */}
          <div>
            <label
              htmlFor={`${fieldId}-credential`}
              className="block text-[12px] text-[var(--color-text-muted)] mb-0.5"
            >
              {keyless ? (
                'Host'
              ) : (
                <>
                  API Key{' '}
                  {provider.hasApiKey && (
                    <span className="text-[var(--color-success)]">(saved)</span>
                  )}
                </>
              )}
            </label>
            <div className="flex gap-1.5">
              {keyless ? (
                <input
                  id={`${fieldId}-credential`}
                  value={host}
                  onChange={(e) => setHost(e.target.value)}
                  placeholder={OLLAMA_DEFAULT_HOST}
                  className={`${inputClass} flex-1`}
                />
              ) : (
                <div className="flex-1 relative">
                  <input
                    id={`${fieldId}-credential`}
                    type={showKey ? 'text' : 'password'}
                    value={apiKey}
                    onChange={(e) => setApiKey(e.target.value)}
                    placeholder={provider.hasApiKey ? 'Enter new key to replace' : 'Enter API key'}
                    className={`${inputClass} pr-8`}
                  />
                  <button
                    type="button"
                    aria-label={showKey ? 'Hide the API key' : 'Show the API key'}
                    onClick={() => setShowKey(!showKey)}
                    className="absolute right-2 top-1/2 -translate-y-1/2 text-[var(--color-text-muted)] hover:text-[var(--color-text-secondary)]"
                  >
                    {showKey ? <EyeOff size={12} /> : <Eye size={12} />}
                  </button>
                </div>
              )}
              {!keyless && (
                <button
                  type="button"
                  onClick={handleTestKey}
                  disabled={!apiKey || testKey.isPending}
                  className="px-3 py-1.5 rounded-md text-[14px] font-medium border border-[var(--color-border)]
                    text-[var(--color-text-secondary)] hover:bg-[var(--color-bg-hover)]
                    disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
                >
                  Test
                </button>
              )}
              <button
                type="button"
                onClick={handleSave}
                disabled={
                  (keyless ? !host.trim() || hostInvalid : !apiKey) || upsert.isPending
                }
                className="px-3 py-1.5 rounded-md text-[14px] font-medium bg-[var(--color-accent)] hover:bg-[var(--color-accent-hover)]
                  text-white disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
              >
                Save
              </button>
            </div>
          </div>

          {/* Test result for new key */}
          {testKey.isPending && (
            <div className="flex items-center gap-1.5 text-[12px] text-[var(--color-text-muted)]">
              <Loader2 size={10} className="animate-spin" /> Validating key...
            </div>
          )}
          {testKey.data && (
            <div className="flex items-start gap-1.5 text-[12px]">
              {testKey.data.success ? (
                <>
                  <CheckCircle size={10} className="text-[var(--color-success)]" />
                  <span className="text-[var(--color-success)]">Valid key</span>
                </>
              ) : (
                <>
                  <XCircle size={10} className="text-[var(--color-danger)] mt-[3px] shrink-0" />
                  <span className="text-[var(--color-danger)]">{testKey.data.error}</span>
                </>
              )}
            </div>
          )}

          {/*
            Rendered whenever the credential is usable — **not** gated on the key
            field being empty.

            It used to be, and the effect was that a single keystroke in the API
            Key field deleted this entire row, while the inline Test button
            appeared beside the field: two layout changes on the first character
            typed, which is rule 1's flagship case. Both controls are now always
            present and merely disabled when they have nothing to act on, so
            typing changes what is enabled and never what is there.
          */}
          {isCredentialUsable(provider) && (
            <div className="flex items-center gap-3">
              <button
                type="button"
                onClick={handleTestSaved}
                disabled={testProvider.isPending && !showModelSelector}
                className="text-[12px] text-[var(--color-accent)] hover:text-[var(--color-accent-hover)] font-medium transition-colors"
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
                className="text-[12px] text-[var(--color-accent)] hover:text-[var(--color-accent-hover)] font-medium transition-colors"
              >
                {testProvider.isPending && showModelSelector ? (
                  <span className="flex items-center gap-1">
                    <Loader2 size={10} className="animate-spin" /> Loading models...
                  </span>
                ) : (
                  'Select Model'
                )}
              </button>

              {/* Success is short enough to sit inline; a failure is not — see below. */}
              {testProvider.data?.success && !showModelSelector && (
                <span className="flex items-center gap-1 text-[12px]">
                  <CheckCircle size={10} className="text-[var(--color-success)]" />
                  <span className="text-[var(--color-success)]">Connected</span>
                </span>
              )}
            </div>
          )}

          {/*
            A failed connection gets its own line, full width, below the controls
            that triggered it.

            It used to share the row inside `truncate max-w-[200px]`, which was
            survivable only while the message was a bare `fetch failed`. Now that
            the adapter's real sentence reaches here — "Ollama isn't answering at
            http://127.0.0.1:11434 — start it with 'ollama serve'" — 200px would
            clip away the half that tells the user what to do (rule 7). Below the
            row rather than in it, so its arrival moves no control (rule 1).
          */}
          {testProvider.data && !testProvider.data.success && !showModelSelector && (
            <div className="flex items-start gap-1.5 text-[12px] text-[var(--color-danger)]">
              <XCircle size={10} className="mt-[3px] shrink-0" />
              <span>{testProvider.data.error}</span>
            </div>
          )}

          {/* Model selector (shown after clicking Select Model) */}
          {showModelSelector && testProvider.data && !testProvider.data.success && (
            <div className="flex items-start gap-1.5 text-[12px] text-[var(--color-danger)]">
              <XCircle size={10} className="mt-[3px] shrink-0" />
              <span>{testProvider.data.error}</span>
            </div>
          )}
          {availableModels && availableModels.length > 0 && (
            <div>
              <label
                htmlFor={`${fieldId}-model`}
                className="block text-[12px] text-[var(--color-text-muted)] mb-0.5"
              >
                Default Model
              </label>
              <select
                id={`${fieldId}-model`}
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
            <div className="flex items-center gap-1.5 text-[12px] text-[var(--color-text-muted)]">
              Default model: <span className="text-[var(--color-text-secondary)]">{provider.defaultModelId}</span>
            </div>
          )}

          {/*
            Last in the card, below every control. It used to sit directly under
            the Save button and above the Test Connection row, so a refusal moved
            the controls at the moment of the click — and the click that produces
            this message is the one most likely to be repeated (rule 1, and rule
            12's "messages below the control, in a slot that does not push the
            next section down").
          */}
          {saveError && (
            <div className="flex items-start gap-1.5 text-[12px] text-[var(--color-danger)]">
              <XCircle size={10} className="mt-[3px] shrink-0" />
              <span>{saveError}</span>
            </div>
          )}
        </div>
      </AnimatedCollapse>
    </div>
  )
}
