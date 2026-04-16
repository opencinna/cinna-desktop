import { useState } from 'react'
import { useRegister } from '../../hooks/useAuth'

interface RegisterFormProps {
  onSuccess: () => void
  onCancel: () => void
}

export function RegisterForm({ onSuccess, onCancel }: RegisterFormProps): React.JSX.Element {
  const [username, setUsername] = useState('')
  const [displayName, setDisplayName] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const register = useRegister()

  const handleSubmit = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault()
    setError('')

    if (!username.trim() || !password.trim()) {
      setError('Username and password are required')
      return
    }

    const result = await register.mutateAsync({
      username: username.trim(),
      displayName: displayName.trim() || username.trim(),
      password
    })

    if (result.success) {
      onSuccess()
    } else {
      setError(result.error ?? 'Registration failed')
    }
  }

  return (
    <form onSubmit={handleSubmit} className="p-3 space-y-2.5">
      <div className="text-xs font-semibold text-[var(--color-text)] mb-2">
        Create Account
      </div>

      <input
        type="text"
        placeholder="Username"
        value={username}
        onChange={(e) => setUsername(e.target.value)}
        autoFocus
        className="w-full px-2.5 py-1.5 text-xs rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] text-[var(--color-text)] placeholder:text-[var(--color-text-muted)] focus:outline-none focus:ring-1 focus:ring-[var(--color-accent)]"
      />

      <input
        type="text"
        placeholder="Display Name (optional)"
        value={displayName}
        onChange={(e) => setDisplayName(e.target.value)}
        className="w-full px-2.5 py-1.5 text-xs rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] text-[var(--color-text)] placeholder:text-[var(--color-text-muted)] focus:outline-none focus:ring-1 focus:ring-[var(--color-accent)]"
      />

      <input
        type="password"
        placeholder="Password"
        value={password}
        onChange={(e) => setPassword(e.target.value)}
        className="w-full px-2.5 py-1.5 text-xs rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] text-[var(--color-text)] placeholder:text-[var(--color-text-muted)] focus:outline-none focus:ring-1 focus:ring-[var(--color-accent)]"
      />

      {error && (
        <div className="text-[10px] text-red-400">{error}</div>
      )}

      <div className="flex gap-2 pt-1">
        <button
          type="button"
          onClick={onCancel}
          className="flex-1 px-2.5 py-1.5 text-xs rounded-md border border-[var(--color-border)] text-[var(--color-text-secondary)] hover:bg-[var(--color-bg-hover)] transition-colors"
        >
          Cancel
        </button>
        <button
          type="submit"
          disabled={register.isPending}
          className="flex-1 px-2.5 py-1.5 text-xs rounded-md bg-[var(--color-accent)] text-white hover:opacity-90 transition-opacity disabled:opacity-50"
        >
          {register.isPending ? 'Creating...' : 'Create'}
        </button>
      </div>
    </form>
  )
}
