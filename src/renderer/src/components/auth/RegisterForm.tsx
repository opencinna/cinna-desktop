import { useState } from 'react'
import { ArrowLeft, Cloud, HardDrive, Loader2 } from 'lucide-react'
import { useRegister, useCinnaOAuthAbort } from '../../hooks/useAuth'

interface RegisterFormProps {
  onSuccess: () => void
  onCancel: () => void
}

type Step = 'type-select' | 'cinna-hosting' | 'local-form' | 'cinna-waiting'

const inputClass =
  'w-full px-3 py-2 text-sm rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] text-[var(--color-text)] placeholder:text-[var(--color-text-muted)] focus:outline-none focus:ring-1 focus:ring-[var(--color-accent)]'

const btnSecondaryClass =
  'flex-1 px-3 py-2 text-sm rounded-md border border-[var(--color-border)] text-[var(--color-text-secondary)] hover:bg-[var(--color-bg-hover)] transition-colors'

const btnPrimaryClass =
  'flex-1 px-3 py-2 text-sm rounded-md bg-[var(--color-accent)] text-white hover:opacity-90 transition-opacity disabled:opacity-50'

export function RegisterForm({ onSuccess, onCancel }: RegisterFormProps): React.JSX.Element {
  const [step, setStep] = useState<Step>('type-select')
  const [cinnaHostingType, setCinnaHostingType] = useState<'cloud' | 'self_hosted'>('cloud')
  const [cinnaServerUrl, setCinnaServerUrl] = useState('')
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

  const handleCinnaConnect = async (): Promise<void> => {
    setError('')
    if (cinnaHostingType === 'self_hosted' && !cinnaServerUrl.trim()) {
      setError('Server URL is required')
      return
    }

    setStep('cinna-waiting')

    const result = await register.mutateAsync({
      accountType: 'cinna',
      cinnaHostingType,
      cinnaServerUrl: cinnaHostingType === 'self_hosted' ? cinnaServerUrl.trim() : undefined
    })

    if (result.success) {
      onSuccess()
    } else {
      setError(result.error ?? 'Authentication failed')
      setStep('cinna-hosting')
    }
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

        <div className="pt-1">
          <button type="button" onClick={onCancel} className={`w-full ${btnSecondaryClass}`}>
            Cancel
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
        </div>

        {cinnaHostingType === 'self_hosted' && (
          <input
            type="url"
            placeholder="https://your-server.com"
            value={cinnaServerUrl}
            onChange={(e) => setCinnaServerUrl(e.target.value)}
            autoFocus
            className={inputClass}
          />
        )}

        {error && <div className="text-xs text-red-400">{error}</div>}

        <div className="flex gap-2 pt-1">
          <button type="button" onClick={onCancel} className={btnSecondaryClass}>
            Cancel
          </button>
          <button
            type="button"
            onClick={handleCinnaConnect}
            disabled={register.isPending}
            className={btnPrimaryClass}
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

      <div className="flex gap-2 pt-1">
        <button type="button" onClick={onCancel} className={btnSecondaryClass}>
          Cancel
        </button>
        <button type="submit" disabled={register.isPending} className={btnPrimaryClass}>
          {register.isPending ? 'Creating...' : 'Create'}
        </button>
      </div>
    </form>
  )
}
