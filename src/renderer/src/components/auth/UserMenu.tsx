import { useState, useRef, useEffect } from 'react'
import { User, ChevronDown, Plus, LogOut, Cloud } from 'lucide-react'
import { useAuthStore } from '../../stores/auth.store'
import { useUsers, useLogin, useLogout } from '../../hooks/useAuth'
import { RegisterForm } from './RegisterForm'
import { LoginPrompt } from './LoginPrompt'

export function UserMenu(): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const [showRegister, setShowRegister] = useState(false)
  const [loginUserId, setLoginUserId] = useState<string | null>(null)
  const ref = useRef<HTMLDivElement>(null)
  const currentUser = useAuthStore((s) => s.currentUser)
  const { data: users } = useUsers()
  const login = useLogin()
  const logout = useLogout()

  const modalRef = useRef<HTMLDivElement>(null)

  // Close dropdown on outside click
  useEffect(() => {
    function handleClick(e: MouseEvent): void {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false)
        setLoginUserId(null)
      }
    }
    if (open) document.addEventListener('mousedown', handleClick)
    return () => document.removeEventListener('mousedown', handleClick)
  }, [open])

  // Close register modal on outside click (on the backdrop)
  useEffect(() => {
    function handleClick(e: MouseEvent): void {
      if (modalRef.current && !modalRef.current.contains(e.target as Node)) {
        setShowRegister(false)
      }
    }
    if (showRegister) document.addEventListener('mousedown', handleClick)
    return () => document.removeEventListener('mousedown', handleClick)
  }, [showRegister])

  const handleSwitchUser = async (userId: string, hasPassword: boolean): Promise<void> => {
    setOpen(false)
    if (!hasPassword) {
      login.mutate({ userId })
      return
    }
    // Main-process tracks whether the user has unlocked this session.
    // Try without a password — if main says one is required, prompt for it.
    const result = await login.mutateAsync({ userId })
    if (!result.success) {
      setLoginUserId(userId)
    }
  }

  const handleLogout = (): void => {
    logout.mutate()
    setOpen(false)
  }

  const isDefault = currentUser?.id === '__default__'
  const initial = currentUser?.displayName?.charAt(0).toUpperCase() ?? '?'
  const allUsers = users ?? []

  return (
    <div ref={ref} className="relative">
      <button
        onClick={() => setOpen(!open)}
        className="flex items-center gap-1.5 px-2 py-1 rounded-md hover:bg-[var(--color-bg-hover)] text-[var(--color-text-secondary)] transition-colors"
      >
        <div className="w-5 h-5 rounded-full bg-[var(--color-accent)] flex items-center justify-center">
          {isDefault ? (
            <User size={11} className="text-white" />
          ) : (
            <span className="text-[10px] font-bold text-white">{initial}</span>
          )}
        </div>
        <span className="text-xs font-medium max-w-[80px] truncate">
          {currentUser?.displayName ?? 'User'}
        </span>
        <ChevronDown size={12} />
      </button>

      {loginUserId && (
        <LoginPrompt
          userId={loginUserId}
          userName={users?.find((u) => u.id === loginUserId)?.displayName ?? ''}
          onSuccess={() => {
            setLoginUserId(null)
            setOpen(false)
          }}
          onCancel={() => setLoginUserId(null)}
        />
      )}

      {open && (
        <div className="absolute right-0 top-full mt-1 w-64 rounded-lg border border-[var(--color-border)] bg-[var(--color-bg-secondary)] shadow-lg z-50 overflow-hidden">
          {/* Profiles */}
          {allUsers.length > 0 && (
          <div className="py-1 max-h-48 overflow-y-auto">
            <div className="px-3 py-1 text-[10px] font-medium uppercase tracking-wider text-[var(--color-text-muted)]">
              Profiles
            </div>
            {allUsers.map((u) => {
              const isCurrent = u.id === currentUser?.id
              return (
                <button
                  key={u.id}
                  onClick={() => !isCurrent && handleSwitchUser(u.id, u.hasPassword)}
                  className={`w-full flex items-center gap-2 px-3 py-2 text-xs transition-colors ${
                    isCurrent
                      ? 'bg-[var(--color-accent)]/10 text-[var(--color-accent)]'
                      : 'text-[var(--color-text-secondary)] hover:bg-[var(--color-bg-hover)]'
                  }`}
                >
                  <div className={`w-5 h-5 rounded-full flex items-center justify-center shrink-0 ${
                    isCurrent
                      ? 'bg-[var(--color-accent)]'
                      : 'bg-[var(--color-bg-tertiary)]'
                  }`}>
                    {u.id === '__default__' ? (
                      <User size={11} className={isCurrent ? 'text-white' : ''} />
                    ) : (
                      <span className={`text-[10px] font-bold ${isCurrent ? 'text-white' : ''}`}>
                        {u.displayName.charAt(0).toUpperCase()}
                      </span>
                    )}
                  </div>
                  <span className="truncate">{u.displayName}</span>
                  {u.id === '__default__' && (
                    <span className="shrink-0 px-1.5 py-0.5 rounded text-[9px] font-medium bg-[var(--color-bg-tertiary)] text-[var(--color-text-muted)]">
                      Guest
                    </span>
                  )}
                  {u.type === 'cinna_user' && (
                    <Cloud size={10} className="shrink-0 text-[var(--color-text-muted)]" />
                  )}
                </button>
              )
            })}
          </div>
          )}

          {/* Actions */}
          <div className="border-t border-[var(--color-border)] py-1">
            <button
              onClick={() => { setShowRegister(true); setOpen(false) }}
              className="w-full flex items-center gap-2 px-3 py-2 text-xs text-[var(--color-text-secondary)] hover:bg-[var(--color-bg-hover)] transition-colors"
            >
              <Plus size={14} />
              Add Account
            </button>
            {!isDefault && (
              <button
                onClick={handleLogout}
                className="w-full flex items-center gap-2 px-3 py-2 text-xs text-[var(--color-text-secondary)] hover:bg-[var(--color-bg-hover)] transition-colors"
              >
                <LogOut size={14} />
                Sign Out
              </button>
            )}
          </div>
        </div>
      )}

      {/* Centered modal for account creation */}
      {showRegister && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
          <div ref={modalRef} className="w-96 rounded-lg border border-[var(--color-border)] bg-[var(--color-bg-secondary)] shadow-xl">
            <RegisterForm
              onSuccess={() => setShowRegister(false)}
              onCancel={() => setShowRegister(false)}
            />
          </div>
        </div>
      )}
    </div>
  )
}
