import { useState, useEffect, useId, useRef } from 'react'
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
import {
  useUpsertProvider,
  useTestProviderKey,
  useOllamaDetection
} from '../../hooks/useProviders'
import {
  normaliseOllamaHost,
  requiresApiKey,
  OLLAMA_DEFAULT_HOST
} from '../../../../shared/credentials'
import { unwrapIpcError } from '../../utils/ipcError'

/**
 * Ollama is listed **unconditionally**, not only when one is detected.
 *
 * A dropdown whose entries appear as a background probe lands is a list that
 * reflows under the pointer (ux_rules rule 1), and a user who has not started
 * Ollama yet would be told nothing about why it is missing. So the option is
 * always there; detection fills in the *host* and the *model list* once the
 * option is chosen, which is work that happens inside space the form already has.
 */
const PROVIDER_TYPES = [
  { type: 'anthropic', name: 'Anthropic', description: 'Claude models (Opus, Sonnet, Haiku)' },
  { type: 'openai', name: 'OpenAI', description: 'GPT-4o, o3, o4-mini' },
  { type: 'gemini', name: 'Google Gemini', description: 'Gemini 2.5 Pro, Flash' },
  { type: 'ollama', name: 'Ollama', description: 'Models running on this machine — no API key' }
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
  /**
   * Ids for `htmlFor`. Every label on this form was a sibling of its control
   * with no association, so `Provider Type`, `API Key`, `Host` and
   * `Default Model` had **no accessible name at all** — a control that says one
   * thing to a sighted user and nothing to anyone else (rule 10). `useId`
   * rather than a literal because the form can share a page with the cards.
   */
  const fieldId = useId()

  /** The Host field's text. Only ever read for a keyless credential. */
  const [host, setHost] = useState('')
  /**
   * The host the probe is actually asked about — set on selection and on Test,
   * never on a keystroke. Re-probing per character would fire a request per
   * letter typed and move the status line under the user's hands.
   */
  const [probeHost, setProbeHost] = useState<string | null>(null)
  /** Whether the user has edited Host, so detection stops overwriting it. */
  const [hostTouched, setHostTouched] = useState(false)

  const upsert = useUpsertProvider()
  const testKey = useTestProviderKey()

  const keyless = selectedType !== null && !requiresApiKey(selectedType)
  const detection = useOllamaDetection({ enabled: keyless, host: probeHost })

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

  /**
   * Fill Host from whatever the probe found — the `OLLAMA_HOST` in the
   * environment, or the default — but never over something the user typed.
   * This is the one thing detection is for: the common case is that the answer
   * is already correct and the user only has to press Save.
   */
  useEffect(() => {
    if (!keyless || hostTouched) return
    const found = detection.data?.host
    if (found && found !== host) setHost(found)
  }, [keyless, hostTouched, detection.data?.host, host])

  const handleTest = (): void => {
    if (!selectedType) return
    if (keyless) {
      // Re-probe the host as typed. `refetch` rather than a new query key when
      // the host is unchanged, so pressing Test on the same value still asks.
      const next = host.trim() || null
      if (next === probeHost) void detection.refetch()
      else setProbeHost(next)
      return
    }
    if (!apiKey) return
    testKey.mutate({ type: selectedType, apiKey })
  }

  const handleSave = (): void => {
    if (!selectedType) return
    if (!keyless && !apiKey) return
    setSaveError(null)
    const providerName = selectedProvider?.name ?? selectedType
    upsert.mutate(
      {
        type: selectedType,
        name: providerName,
        // Sent only for a keyless type. `providerService` drops a `baseUrl` on a
        // keyed credential outright — a row holding a real key must never point
        // where the renderer says — so sending one would be sending a value that
        // is guaranteed to be ignored.
        ...(keyless
          ? { baseUrl: host.trim() || OLLAMA_DEFAULT_HOST }
          : { apiKey }),
        enabled: true,
        defaultModelId: chosenModelId
      },
      {
        onSuccess: () => onClose(),
        onError: (err) => setSaveError(unwrapIpcError(err, 'The credential could not be saved.'))
      }
    )
  }

  const inputClass =
    'w-full bg-[var(--color-bg)] text-[var(--color-text)] px-2.5 py-1.5 rounded-md text-[14px] border border-[var(--color-border)] focus:border-[var(--color-accent)] focus:outline-none'

  /**
   * Whether the last probe still describes what the Host field says.
   *
   * Hoisted out of the status line because the *models* go stale with it. The
   * status blanked on a host edit while the Default Model select went on
   * offering the previous host's models — and, through `chosenModelId`, went on
   * letting one be saved against a credential that had never listed it. Both the
   * sentence and the list answer to this one expression, so they cannot disagree
   * about which host is being described.
   *
   * Compared as normalised origins, so a trailing slash, a case change or
   * `localhost` does not blank a verdict that is still true.
   */
  const probeStale =
    keyless &&
    detection.data !== undefined &&
    normaliseOllamaHost(host) !== normaliseOllamaHost(detection.data.host)

  /**
   * The models offered as a default, from whichever probe applies to this type.
   * One select, two sources, so the shape of the form does not depend on which
   * kind of credential is being added.
   */
  const models: { id: string; name: string }[] = keyless
    ? (probeStale ? [] : (detection.data?.models ?? [])).map((m) => ({ id: m.id, name: m.id }))
    : (testKey.data?.success ? (testKey.data.models ?? []) : []).map((m) => ({
        id: m.id,
        name: m.name
      }))

  /**
   * The default model actually chosen — which is the selection *only while the
   * catalogue still offers it*.
   *
   * Derived rather than stored, so the control and the value that gets saved are
   * the same expression and cannot disagree. They did: pick a model against one
   * key, replace the key, let the test fail, and the select showed its empty
   * placeholder while `selectedDefaultModelId` still held the old id — which
   * Save then wrote. The screen said no model was chosen and the row said
   * otherwise.
   *
   * Keeping the raw selection in state and filtering here — rather than clearing
   * it when a list empties — means a list that comes back *with* the model still
   * in it (a re-test against the same key, a local server restarting) restores
   * the user's choice instead of quietly discarding it.
   */
  const chosenModelId = models.some((model) => model.id === selectedDefaultModelId)
    ? selectedDefaultModelId
    : null

  const busy = keyless ? detection.isFetching : testKey.isPending

  /**
   * Whether the Default Model row is on screen — which, once it is, it stays.
   *
   * `keepPreviousData` removed the *transient* empty state during a refetch and
   * did not fix the jump, because the mover was never the loading state: it was
   * the select **unmounting when a result carried no models**. Pressing Test on
   * a host that turns out dead answers in ~30ms and takes the row away, which
   * lifts the Cancel/Test/Save row 64px — putting Save exactly where the pointer
   * had just pressed Test (rule 1, and the one failure here with a real cost:
   * a misclick, not a wobble).
   *
   * So the row is present from the moment a provider type is chosen, for **every**
   * type, and only its contents change. Empty, it renders a disabled select that
   * says why it is empty.
   *
   * The keyed branch used to latch on instead — appearing with the first
   * successful test — which left the *same form* with two behaviours: the
   * keyless side never moved, and the keyed side dropped its button row 64px
   * about a second after a successful Test, with the pointer still resting where
   * Save was about to arrive. That was pre-existing for every provider and it
   * fires on success, which is the least harmful moment; it is fixed here anyway
   * because an asymmetry inside one surface is how the two halves drift, and
   * because the row also tells a user the Default Model step exists before they
   * have found it.
   */
  const showModelRow = selectedType !== null

  /**
   * Typed something that is not an address at all — `not a url`, a bare word.
   *
   * Distinct from "nothing is running there", which must stay saveable: a user
   * who has not started Ollama yet is entitled to add the credential now and
   * start it later. A string that cannot be turned into a URL is a different
   * thing — nothing will ever answer at it — so Save is disabled rather than
   * left to fail against `providerService`'s own guard after a round trip.
   *
   * No message is rendered from this while the user types (rule 1's "no
   * per-keystroke hints"); the disabled button is the whole signal until they
   * press Test, and the status slot then says what is wrong.
   */
  const hostInvalid =
    keyless && host.trim() !== '' && normaliseOllamaHost(host) === null

  /**
   * This host already has a credential.
   *
   * The offer row in the section consults `alreadyConfigured`; this form did
   * not, so dismissing the offer and adding Ollama by hand produced a second row
   * for the same server — two credentials both named "Ollama", which is the
   * state `ollamaService`'s duplicate check exists to prevent, and which
   * `runtimeService.findCredential` then resolves by list order. A manifest
   * saying `credential: "Ollama"` would bind to whichever row came first.
   *
   * Reported in the status slot that is already there, so the sentence costs no
   * layout, and Save is disabled — there is nothing useful a second identical
   * row could do.
   */
  const alreadyConfigured = keyless && detection.data?.alreadyConfigured === true

  const canSave = keyless
    ? !hostInvalid && !alreadyConfigured && !upsert.isPending
    : !!apiKey && !upsert.isPending

  /**
   * The one status line, in a slot that is always present.
   *
   * Rule 1: this sentence changes as a probe resolves, and it sits directly
   * above the Cancel / Test / Save row. Rendered conditionally it would push
   * those buttons down under the pointer at the moment the user is reaching for
   * them, so the slot keeps its height whether or not there is anything to say.
   */
  const status = ((): { tone: 'ok' | 'bad' | 'muted'; text: string } | null => {
    if (busy) return { tone: 'muted', text: keyless ? 'Looking for Ollama…' : 'Validating key…' }
    if (keyless) {
      if (!detection.data) return null
      // A verdict must not outlive the value it described — see `probeStale`.
      if (probeStale) return null
      if (detection.data.alreadyConfigured) {
        return { tone: 'bad', text: 'This host already has a credential' }
      }
      if (!detection.data.running) {
        // Two different failures, and the fix differs: a host that cannot be
        // parsed will never answer, while a parseable one just is not running.
        if (normaliseOllamaHost(detection.data.host) === null) {
          return { tone: 'bad', text: 'That is not a host address' }
        }
        // The host is deliberately **not** repeated here. It is in the field one
        // line above, and including it pushed the sentence to 440px inside a
        // 428px box at the 800px minimum width — clipping the instruction,
        // which is the half worth reading (rule 7).
        return { tone: 'bad', text: 'Nothing answered there — is Ollama running?' }
      }
      if (detection.data.models.length === 0) {
        return { tone: 'bad', text: 'Ollama is running but has no models pulled yet' }
      }
      const version = detection.data.version ? ` ${detection.data.version}` : ''
      return {
        tone: 'ok',
        text: `Ollama${version} — ${detection.data.models.length} model${
          detection.data.models.length === 1 ? '' : 's'
        } available`
      }
    }
    if (!testKey.data) return null
    if (!testKey.data.success) return { tone: 'bad', text: testKey.data.error ?? 'Invalid key' }
    return { tone: 'ok', text: `Valid — ${testKey.data.models?.length ?? 0} models available` }
  })()

  return (
    <div className="rounded-lg border border-[var(--color-accent)]/40 bg-[var(--color-bg-secondary)]">
      <div className="flex items-center justify-between px-4 py-2.5 border-b border-[var(--color-border)]">
        <span className="font-medium text-[14px]">Add AI Credentials</span>
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
          <label
            htmlFor={`${fieldId}-type`}
            className="block text-[12px] text-[var(--color-text-muted)] mb-0.5"
          >
            Provider Type
          </label>
          {selectedType && !dropdownOpen ? (
            <button
              type="button"
              id={`${fieldId}-type`}
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
                  id={`${fieldId}-type`}
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
                    <div className="px-3 py-2 text-[12px] text-[var(--color-text-muted)]">
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
                          setHost('')
                          setHostTouched(false)
                          setProbeHost(null)
                          setSelectedDefaultModelId(null)
                          testKey.reset()
                        }}
                        className={`w-full text-left px-3 py-2 hover:bg-[var(--color-bg-hover)] transition-colors ${
                          selectedType === p.type ? 'bg-[var(--color-bg-hover)]' : ''
                        }`}
                      >
                        <div className="text-[14px] font-medium">{p.name}</div>
                        <div className="text-[12px] text-[var(--color-text-muted)]">
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

        {/* Credential input — a key, or a host for the types that have no key */}
        {selectedType && !dropdownOpen && (
          <>
            {keyless ? (
              <div>
                <label
                  htmlFor={`${fieldId}-host`}
                  className="block text-[12px] text-[var(--color-text-muted)] mb-0.5"
                >
                  Host
                </label>
                <input
                  id={`${fieldId}-host`}
                  value={host}
                  onChange={(e) => {
                    setHost(e.target.value)
                    setHostTouched(true)
                  }}
                  placeholder={OLLAMA_DEFAULT_HOST}
                  autoFocus
                  className={inputClass}
                />
              </div>
            ) : (
              <div>
                <label
                  htmlFor={`${fieldId}-key`}
                  className="block text-[12px] text-[var(--color-text-muted)] mb-0.5"
                >
                  API Key
                </label>
                <div className="relative">
                  <input
                    id={`${fieldId}-key`}
                    type={showKey ? 'text' : 'password'}
                    value={apiKey}
                    onChange={(e) => setApiKey(e.target.value)}
                    placeholder="Paste your API key"
                    autoFocus
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
              </div>
            )}

            {/*
              Fixed-height status slot — see the `status` note above.
              `aria-live` because this is the only place a Test result is
              reported: without it, pressing Test announces nothing at all to a
              screen reader. Polite, not assertive — it is a result the user
              asked for, not an interruption.
            */}
            <div
              aria-live="polite"
              className="min-h-[1.125rem] flex items-center gap-1.5 text-[12px]"
            >
              {status && (
                <>
                  {status.tone === 'muted' ? (
                    <Loader2 size={10} className="animate-spin text-[var(--color-text-muted)]" />
                  ) : status.tone === 'ok' ? (
                    <CheckCircle size={10} className="text-[var(--color-success)]" />
                  ) : (
                    <XCircle size={10} className="text-[var(--color-danger)]" />
                  )}
                  <span
                    className={`truncate ${
                      status.tone === 'ok'
                        ? 'text-[var(--color-success)]'
                        : status.tone === 'bad'
                          ? 'text-[var(--color-danger)]'
                          : 'text-[var(--color-text-muted)]'
                    }`}
                  >
                    {status.text}
                  </span>
                </>
              )}
            </div>

            {/* Default model — same slot whichever probe filled it, and it keeps
                its footprint when a probe comes back empty. See `showModelRow`. */}
            {showModelRow && (
              <div>
                <label
                  htmlFor={`${fieldId}-model`}
                  className="block text-[12px] text-[var(--color-text-muted)] mb-0.5"
                >
                  Default Model
                </label>
                <select
                  id={`${fieldId}-model`}
                  value={chosenModelId ?? ''}
                  onChange={(e) => setSelectedDefaultModelId(e.target.value || null)}
                  disabled={models.length === 0}
                  className={`${inputClass} cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed`}
                >
                  {models.length === 0 ? (
                    <option value="">
                      {keyless ? 'No models available yet' : 'Test to list models'}
                    </option>
                  ) : (
                    <>
                      <option value="">First available</option>
                      {models.map((m) => (
                        <option key={m.id} value={m.id}>
                          {m.name}
                        </option>
                      ))}
                    </>
                  )}
                </select>
              </div>
            )}

            {/* Buttons */}
            <div className="flex justify-end gap-2 pt-1">
              <button
                type="button"
                onClick={onClose}
                className="px-3 py-1.5 rounded-md text-[14px] font-medium text-[var(--color-text-muted)]
                  hover:text-[var(--color-text-secondary)] transition-colors"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={handleTest}
                disabled={(!keyless && !apiKey) || busy}
                className="px-3 py-1.5 rounded-md text-[14px] font-medium border border-[var(--color-border)]
                  text-[var(--color-text-secondary)] hover:bg-[var(--color-bg-hover)]
                  disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
              >
                Test
              </button>
              <button
                type="button"
                onClick={handleSave}
                disabled={!canSave}
                className="px-3 py-1.5 rounded-md text-[14px] font-medium bg-[var(--color-accent)] hover:bg-[var(--color-accent-hover)]
                  text-white disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
              >
                {upsert.isPending ? (
                  <span className="flex items-center gap-1">
                    <Loader2 size={10} className="animate-spin" /> Saving...
                  </span>
                ) : (
                  'Save Credentials'
                )}
              </button>
            </div>

            {/*
              **Below** the buttons, not above them. It used to sit above, where
              a refusal arriving on the click pushed the row the user had just
              pressed down by 28.6px — rule 1's "never insert it above controls
              the user is about to click", and the click that produces this
              message is the one most likely to be repeated.
            */}
            {saveError && (
              <div className="flex items-start gap-1.5 text-[12px] text-[var(--color-danger)]">
                <XCircle size={10} className="mt-[3px] shrink-0" />
                <span>{saveError}</span>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  )
}
