import { KeyRound, X, Info, CheckCircle } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useUpdateUser } from '../../hooks/useAuth'

const inputClass =
  'w-full bg-[var(--color-bg)] text-[var(--color-text)] px-2.5 py-1.5 rounded-md text-[14px] border border-[var(--color-border)] focus:border-[var(--color-accent)] focus:outline-none'

interface PasswordModalProps {
  user: { id: string; displayName: string; hasPassword: boolean }
  onClose: () => void
}

/**
 * Website-style local-password setup. When the account already has a password
 * the current one must be confirmed. The new password is always entered twice;
 * submitting an empty new password removes the password from the account. The
 * password is local-only — it gates unlocking this account inside this app.
 */
export function PasswordModal({ user, onClose }: PasswordModalProps): React.JSX.Element {
  const cardRef = useRef<HTMLDivElement>(null)
  const firstInputRef = useRef<HTMLInputElement>(null)
  const [currentPassword, setCurrentPassword] = useState('')
  const [newPassword, setNewPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [error, setError] = useState('')
  const [done, setDone] = useState<string | null>(null)
  const updateUser = useUpdateUser()

  useEffect(() => {
    firstInputRef.current?.focus()
  }, [])

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    const onMouse = (e: MouseEvent): void => {
      if (cardRef.current && !cardRef.current.contains(e.target as Node)) onClose()
    }
    window.addEventListener('keydown', onKey)
    window.addEventListener('mousedown', onMouse)
    return () => {
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('mousedown', onMouse)
    }
  }, [onClose])

  const handleSubmit = async (): Promise<void> => {
    setError('')

    if (user.hasPassword && !currentPassword) {
      setError('Enter your current password')
      return
    }
    if (newPassword !== confirmPassword) {
      setError('Passwords do not match')
      return
    }

    const removing = newPassword.length === 0
    if (removing && !user.hasPassword) {
      setError('Enter a new password')
      return
    }

    const result = await updateUser.mutateAsync({
      userId: user.id,
      currentPassword: user.hasPassword ? currentPassword : undefined,
      ...(removing ? { removePassword: true } : { password: newPassword })
    })

    if (!result.success) {
      setError(result.error ?? 'Failed to update password')
      return
    }

    setDone(
      removing
        ? 'Password removed — this account will no longer ask for a password.'
        : 'Password updated.'
    )
  }

  return createPortal(
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/25 px-4">
      <div
        ref={cardRef}
        className="w-full max-w-[24rem] rounded-xl border border-[var(--color-border)] bg-[var(--color-bg-secondary)] shadow-lg p-5 space-y-4"
      >
        <div className="flex items-start justify-between">
          <div className="flex items-center gap-2 text-sm font-medium text-[var(--color-text)]">
            <KeyRound size={16} className="text-[var(--color-text-muted)]" />
            {user.hasPassword ? 'Change local password' : 'Set local password'}
          </div>
          <button
            type="button"
            onClick={onClose}
            className="p-1 -mt-1 -mr-1 rounded hover:bg-[var(--color-bg-hover)] text-[var(--color-text-muted)] hover:text-[var(--color-text)] transition-colors"
            title="Close"
          >
            <X size={14} />
          </button>
        </div>

        {done ? (
          <>
            <div className="flex items-start gap-2 rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] p-3">
              <CheckCircle size={16} className="text-[var(--color-accent)] shrink-0 mt-0.5" />
              <p className="text-[13px] text-[var(--color-text)] leading-relaxed">{done}</p>
            </div>
            <div className="flex justify-end">
              <button
                type="button"
                onClick={onClose}
                className="px-3 py-1.5 rounded-md text-xs font-medium bg-[var(--color-accent)] hover:brightness-110 text-white transition-colors"
              >
                Done
              </button>
            </div>
          </>
        ) : (
          <>
            <div className="flex items-start gap-2 rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] p-3">
              <Info size={14} className="text-[var(--color-text-muted)] shrink-0 mt-0.5" />
              <p className="text-[12px] text-[var(--color-text-muted)] leading-relaxed">
                This password is local only — it unlocks{' '}
                <span className="text-[var(--color-text)]">{user.displayName}</span> inside this app
                and is never sent to any server. Leave the new password empty to remove it.
              </p>
            </div>

            <div className="space-y-3">
              {user.hasPassword && (
                <div>
                  <label className="block text-[12px] text-[var(--color-text-muted)] mb-0.5">
                    Current password
                  </label>
                  <input
                    ref={firstInputRef}
                    type="password"
                    value={currentPassword}
                    onChange={(e) => setCurrentPassword(e.target.value)}
                    placeholder="Current password"
                    className={inputClass}
                  />
                </div>
              )}
              <div>
                <label className="block text-[12px] text-[var(--color-text-muted)] mb-0.5">
                  New password
                </label>
                <input
                  ref={user.hasPassword ? undefined : firstInputRef}
                  type="password"
                  value={newPassword}
                  onChange={(e) => setNewPassword(e.target.value)}
                  placeholder={user.hasPassword ? 'New password (empty to remove)' : 'New password'}
                  className={inputClass}
                />
              </div>
              <div>
                <label className="block text-[12px] text-[var(--color-text-muted)] mb-0.5">
                  Confirm new password
                </label>
                <input
                  type="password"
                  value={confirmPassword}
                  onChange={(e) => setConfirmPassword(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && !updateUser.isPending) {
                      e.preventDefault()
                      void handleSubmit()
                    }
                  }}
                  placeholder="Confirm new password"
                  className={inputClass}
                />
              </div>
            </div>

            {error && <div className="text-[12px] text-[var(--color-danger)]">{error}</div>}

            <div className="flex justify-end gap-2">
              <button
                type="button"
                onClick={onClose}
                className="px-3 py-1.5 rounded-md text-xs font-medium border border-[var(--color-border)] text-[var(--color-text-muted)] hover:text-[var(--color-text)] transition-colors"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={handleSubmit}
                disabled={updateUser.isPending}
                className="px-3 py-1.5 rounded-md text-xs font-medium bg-[var(--color-accent)] hover:brightness-110 text-white transition-colors disabled:opacity-50"
              >
                {updateUser.isPending ? 'Saving…' : 'Save'}
              </button>
            </div>
          </>
        )}
      </div>
    </div>,
    document.body
  )
}
