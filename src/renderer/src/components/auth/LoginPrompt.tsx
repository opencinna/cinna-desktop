import { User } from 'lucide-react'
import { PasswordUnlockForm } from './PasswordUnlockForm'

interface LoginPromptProps {
  userId: string
  userName: string
  onSuccess: () => void
  onCancel: () => void
}

export function LoginPrompt({
  userId,
  userName,
  onSuccess,
  onCancel
}: LoginPromptProps): React.JSX.Element {
  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-[var(--color-bg)]/90 backdrop-blur-sm">
      <div className="titlebar fixed top-0 left-0 right-0 h-10" />

      <PasswordUnlockForm
        userId={userId}
        userName={userName}
        onSuccess={onSuccess}
        footer={
          <button
            onClick={onCancel}
            className="w-full flex items-center justify-center gap-1.5 text-xs text-[var(--color-text-muted)] hover:text-[var(--color-text-secondary)] transition-colors"
          >
            <User size={12} />
            Cancel
          </button>
        }
      />
    </div>
  )
}
