import { useState } from 'react'
import { ArrowLeft, Cloud, HardDrive, Loader2, X } from 'lucide-react'
import { useRegister, useCinnaOAuthAbort } from '../../hooks/useAuth'
import {
  readSelfHostedHistory,
  writeSelfHostedHistory,
  prependSelfHostedHistory
} from '../../constants/selfHostedHistory'

interface RegisterFormProps {
  onSuccess: () => void
}

type Step = 'type-select' | 'cinna-hosting' | 'local-form' | 'cinna-waiting'

const inputClass =
  'w-full px-3 py-2 text-sm rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] text-[var(--color-text)] placeholder:text-[var(--color-text-muted)] focus:outline-none focus:ring-1 focus:ring-[var(--color-accent)]'

const btnSecondaryClass =
  'flex-1 px-3 py-2 text-sm rounded-md border border-[var(--color-border)] text-[var(--color-text-secondary)] hover:bg-[var(--color-bg-hover)] transition-colors'

const btnPrimaryCenteredClass =
  'px-6 py-2 text-sm rounded-md bg-[var(--color-accent)] text-white hover:opacity-90 transition-opacity disabled:opacity-50'

export function RegisterForm({ onSuccess }: RegisterFormProps): React.JSX.Element {
  const [step, setStep] = useState<Step>('type-select')
  const [cinnaHostingType, setCinnaHostingType] = useState<'cloud' | 'self_hosted'>('self_hosted')
  const [cinnaServerUrl, setCinnaServerUrl] = useState('')
  const [selfHostedHistory, setSelfHostedHistory] = useState<string[]>(() => readSelfHostedHistory())
  const [username, setUsername] = useState('')
  const [displayName, setDisplayName] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')

  const register = useRegister()
  const cinnaAbort = useCinnaOAuthAbort()

  const handleBack = (): void => {
    setError('')
    if (step === 'local-form') {
      setStep('type-select')
    } else if (step === 'cinna-hosting') {
      setStep('type-select')
    }
  }

  const handleTypeSelect = (type: 'local' | 'cinna'): void => {
    if (type === 'local') {
      setStep('local-form')
    } else {
      setStep('cinna-hosting')
    }
  }

  const connectSelfHosted = async (rawUrl: string): Promise<void> => {
    setError('')
    const trimmedUrl = rawUrl.trim()
    if (!trimmedUrl) {
      setError('Server URL is required')
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
      onSuccess()
    } else {
      setError(result.error ?? 'Authentication failed')
      setStep('cinna-hosting')
    }
  }

  const handleCinnaConnect = async (): Promise<void> => {
    setError('')
    if (cinnaHostingType === 'cloud') {
      // opencinna.io cloud is not yet available — handled via the inline
      // Under Development notice; this guard prevents accidental submits.
      return
    }
    await connectSelfHosted(cinnaServerUrl)
  }

  const handleRemoveHistoryEntry = (url: string): void => {
    const next = selfHostedHistory.filter((u) => u !== url)
    writeSelfHostedHistory(next)
    setSelfHostedHistory(next)
  }

  const handleLocalSubmit = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault()
    setError('')

    if (!username.trim()) {
      setError('Username is required')
      return
    }

    const result = await register.mutateAsync({
      username: username.trim(),
      displayName: displayName.trim() || username.trim(),
      password: password || undefined,
      accountType: 'local'
    })

    if (result.success) {
      onSuccess()
    } else {
      setError(result.error ?? 'Registration failed')
    }
  }

  const handleCinnaAbort = (): void => {
    cinnaAbort.mutate()
    setStep('cinna-hosting')
    setError('Authorization cancelled')
  }

  // Step 1: Account type selection — horizontal cards
  if (step === 'type-select') {
    return (
      <div className="p-5 space-y-4">
        <div className="text-sm font-semibold text-[var(--color-text)]">
          Create Account
        </div>

        <div className="flex gap-3">
          <button
            type="button"
            onClick={() => handleTypeSelect('local')}
            className="flex-1 flex flex-col items-center gap-2 p-4 rounded-lg border border-[var(--color-border)] hover:bg-[var(--color-bg-hover)] hover:border-[var(--color-text-muted)] transition-colors text-center"
          >
            <HardDrive size={22} className="text-[var(--color-text-muted)]" />
            <div>
              <div className="text-sm font-medium text-[var(--color-text)]">Local Account</div>
              <div className="text-[11px] text-[var(--color-text-muted)] mt-0.5">Data stays on this machine</div>
            </div>
          </button>

          <button
            type="button"
            onClick={() => handleTypeSelect('cinna')}
            className="flex-1 flex flex-col items-center gap-2 p-4 rounded-lg border border-[var(--color-border)] hover:bg-[var(--color-bg-hover)] hover:border-[var(--color-text-muted)] transition-colors text-center"
          >
            <Cloud size={22} className="text-[var(--color-text-muted)]" />
            <div>
              <div className="text-sm font-medium text-[var(--color-text)]">Cinna Account</div>
              <div className="text-[11px] text-[var(--color-text-muted)] mt-0.5">Connect to a Cinna server</div>
            </div>
          </button>
        </div>

      </div>
    )
  }

  // Step 2a: Cinna hosting selection
  if (step === 'cinna-hosting') {
    return (
      <div className="p-5 space-y-3">
        <button
          type="button"
          onClick={handleBack}
          className="flex items-center gap-1 text-xs text-[var(--color-text-muted)] hover:text-[var(--color-text-secondary)] transition-colors mb-1"
        >
          <ArrowLeft size={12} />
          Back
        </button>

        <div className="text-sm font-semibold text-[var(--color-text)]">
          Connect to Cinna
        </div>

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

        {error && <div className="text-xs text-red-400">{error}</div>}

        <div className="flex justify-center pt-1">
          <button
            type="button"
            onClick={handleCinnaConnect}
            disabled={register.isPending || cinnaHostingType === 'cloud'}
            className={btnPrimaryCenteredClass}
          >
            Connect
          </button>
        </div>
      </div>
    )
  }

  // Waiting for Cinna OAuth
  if (step === 'cinna-waiting') {
    return (
      <div className="p-5 space-y-4">
        <div className="flex flex-col items-center gap-3 py-6">
          <Loader2 size={28} className="text-[var(--color-accent)] animate-spin" />
          <div className="text-sm text-[var(--color-text-secondary)] text-center">
            Waiting for browser authorization...
          </div>
          <div className="text-xs text-[var(--color-text-muted)] text-center">
            Complete the sign-in in your browser to continue
          </div>
        </div>
        <button
          type="button"
          onClick={handleCinnaAbort}
          className={`w-full ${btnSecondaryClass}`}
        >
          Cancel
        </button>
      </div>
    )
  }

  // Step 2b: Local account form
  return (
    <form onSubmit={handleLocalSubmit} className="p-5 space-y-3">
      <button
        type="button"
        onClick={handleBack}
        className="flex items-center gap-1 text-xs text-[var(--color-text-muted)] hover:text-[var(--color-text-secondary)] transition-colors mb-1"
      >
        <ArrowLeft size={12} />
        Back
      </button>

      <div className="text-sm font-semibold text-[var(--color-text)]">
        Local Account
      </div>

      <div>
        <label className="block text-xs text-[var(--color-text-muted)] mb-1">Username</label>
        <input
          type="text"
          placeholder="Username"
          value={username}
          onChange={(e) => setUsername(e.target.value)}
          autoFocus
          className={inputClass}
        />
      </div>

      <div>
        <label className="block text-xs text-[var(--color-text-muted)] mb-1">Display Name</label>
        <input
          type="text"
          placeholder="Display Name (optional)"
          value={displayName}
          onChange={(e) => setDisplayName(e.target.value)}
          className={inputClass}
        />
      </div>

      <div>
        <label className="block text-xs text-[var(--color-text-muted)] mb-1">Password</label>
        <input
          type="password"
          placeholder="Password (optional)"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          className={inputClass}
        />
      </div>

      {error && <div className="text-xs text-red-400">{error}</div>}

      <div className="flex justify-center pt-1">
        <button type="submit" disabled={register.isPending} className={btnPrimaryCenteredClass}>
          {register.isPending ? 'Creating...' : 'Create'}
        </button>
      </div>
    </form>
  )
}
