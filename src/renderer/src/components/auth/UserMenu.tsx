import { useState, useRef, useEffect } from 'react'
import { User, ChevronDown, Plus, LogOut } from 'lucide-react'
import { useAuthStore } from '../../stores/auth.store'
import { useUsers, useLogin, useLogout } from '../../hooks/useAuth'

function useIsUnlocked(): (userId: string) => boolean {
  return useAuthStore((s) => s.isUnlocked)
}
import { RegisterForm } from './RegisterForm'
import { LoginPrompt } from './LoginPrompt'

export function UserMenu(): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const [showRegister, setShowRegister] = useState(false)
  const [loginUserId, setLoginUserId] = useState<string | null>(null)
  const ref = useRef<HTMLDivElement>(null)
  const currentUser = useAuthStore((s) => s.currentUser)
  const isUnlocked = useIsUnlocked()
  const { data: users } = useUsers()
  const login = useLogin()
  const logout = useLogout()

  // Close on outside click
  useEffect(() => {
    function handleClick(e: MouseEvent): void {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false)
        setShowRegister(false)
        setLoginUserId(null)
      }
    }
    if (open) document.addEventListener('mousedown', handleClick)
    return () => document.removeEventListener('mousedown', handleClick)
  }, [open])

  const handleSwitchUser = (userId: string, hasPassword: boolean): void => {
    if (hasPassword && !isUnlocked(userId)) {
      // Password required and not yet authenticated this session
      setLoginUserId(userId)
      setOpen(false)
    } else {
      // No password, or already unlocked this session — switch directly
      login.mutate({ userId, skipPassword: true })
      setOpen(false)
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
          {showRegister ? (
            <RegisterForm
              onSuccess={() => {
                setShowRegister(false)
                setOpen(false)
              }}
              onCancel={() => setShowRegister(false)}
            />
          ) : (
            <>
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
                    </button>
                  )
                })}
              </div>
              )}

              {/* Actions */}
              <div className="border-t border-[var(--color-border)] py-1">
                <button
                  onClick={() => setShowRegister(true)}
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
            </>
          )}
        </div>
      )}
    </div>
  )
}
