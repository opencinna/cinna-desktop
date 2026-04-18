import { User } from 'lucide-react'
import { useAuthStore } from '../../stores/auth.store'
import { useUsers, useLogin } from '../../hooks/useAuth'
import { PasswordUnlockForm } from './PasswordUnlockForm'

export function LoginScreen(): React.JSX.Element {
  const pendingUserId = useAuthStore((s) => s.pendingUserId)
  const setNeedsPassword = useAuthStore((s) => s.setNeedsPassword)
  const setPendingUserId = useAuthStore((s) => s.setPendingUserId)
  const { data: users } = useUsers()
  const login = useLogin()

  const pendingUser = users?.find((u) => u.id === pendingUserId)

  const handleSwitchToDefault = async (): Promise<void> => {
    await login.mutateAsync({ userId: '__default__' })
    setNeedsPassword(false)
    setPendingUserId(null)
  }

  if (!pendingUserId) return <></>

  return (
    <div className="h-full flex flex-col items-center justify-center bg-[var(--color-bg)]">
      <div className="titlebar fixed top-0 left-0 right-0 h-10" />

      <PasswordUnlockForm
        userId={pendingUserId}
        userName={pendingUser?.displayName ?? 'User'}
        onSuccess={() => setNeedsPassword(false)}
        footer={
          <button
            onClick={handleSwitchToDefault}
            className="w-full flex items-center justify-center gap-1.5 text-xs text-[var(--color-text-muted)] hover:text-[var(--color-text-secondary)] transition-colors"
          >
            <User size={12} />
            Continue as Guest
          </button>
        }
      />
    </div>
  )
}
