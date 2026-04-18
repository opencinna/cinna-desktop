import { useState } from 'react'
import { Lock } from 'lucide-react'
import { useLogin } from '../../hooks/useAuth'

interface PasswordUnlockFormProps {
  userId: string
  userName: string
  onSuccess: () => void
  footer?: React.ReactNode
}

export function PasswordUnlockForm({
  userId,
  userName,
  onSuccess,
  footer
}: PasswordUnlockFormProps): React.JSX.Element {
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const login = useLogin()

  const initial = userName.charAt(0).toUpperCase() || '?'

  const handleSubmit = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault()
    setError('')

    const result = await login.mutateAsync({ userId, password })
    if (result.success) {
      onSuccess()
    } else {
      setError(result.error ?? 'Invalid password')
    }
  }

  return (
    <div className="w-72 space-y-6">
      <div className="flex flex-col items-center gap-3">
        <div className="w-16 h-16 rounded-full bg-[var(--color-accent)] flex items-center justify-center">
          <span className="text-2xl font-bold text-white">{initial}</span>
        </div>
        <div className="text-sm font-semibold text-[var(--color-text)]">
          {userName || 'User'}
        </div>
      </div>

      <form onSubmit={handleSubmit} className="space-y-3">
        <div className="relative">
          <Lock
            size={14}
            className="absolute left-2.5 top-1/2 -translate-y-1/2 text-[var(--color-text-muted)]"
          />
          <input
            type="password"
            placeholder="Enter password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoFocus
            className="w-full pl-8 pr-3 py-2 text-sm rounded-lg border border-[var(--color-border)] bg-[var(--color-bg-secondary)] text-[var(--color-text)] placeholder:text-[var(--color-text-muted)] focus:outline-none focus:ring-2 focus:ring-[var(--color-accent)]"
          />
        </div>

        {error && <div className="text-xs text-red-400 text-center">{error}</div>}

        <button
          type="submit"
          disabled={login.isPending}
          className="w-full py-2 text-sm rounded-lg bg-[var(--color-accent)] text-white hover:opacity-90 transition-opacity disabled:opacity-50"
        >
          {login.isPending ? 'Signing in...' : 'Unlock'}
        </button>
      </form>

      {footer}
    </div>
  )
}
