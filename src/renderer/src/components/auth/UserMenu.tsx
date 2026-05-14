import { useState, useRef, useEffect } from 'react'
import { createPortal } from 'react-dom'
import { User, ChevronDown, Plus, LogOut, Cloud, AlertTriangle, Settings } from 'lucide-react'
import { useAuthStore } from '../../stores/auth.store'
import { useUIStore } from '../../stores/ui.store'
import { useUsers, useLogin, useDeleteUser } from '../../hooks/useAuth'
import { usePopover } from '../ui/usePopover'
import { RegisterForm } from './RegisterForm'
import { LoginPrompt } from './LoginPrompt'

interface UserMenuProps {
  /** Compact mode: render only the avatar (no name + chevron). Dropdown opens
      upward so it works at the bottom of the sidebar. */
  compact?: boolean
}

export function UserMenu({ compact = false }: UserMenuProps = {}): React.JSX.Element {
  const [showRegister, setShowRegister] = useState(false)
  const [showSignOutConfirm, setShowSignOutConfirm] = useState(false)
  const [signOutPassword, setSignOutPassword] = useState('')
  const [signOutError, setSignOutError] = useState('')
  const [loginUserId, setLoginUserId] = useState<string | null>(null)
  const signOutModalRef = useRef<HTMLDivElement>(null)
  const currentUser = useAuthStore((s) => s.currentUser)
  const activeView = useUIStore((s) => s.activeView)
  const setActiveView = useUIStore((s) => s.setActiveView)
  const { data: users } = useUsers()
  const login = useLogin()
  const deleteUser = useDeleteUser()
  const {
    open,
    setOpen,
    triggerRef,
    popoverRef: dropdownRef,
    style: dropdownStyle
  } = usePopover<HTMLButtonElement>(compact ? 'above-left' : 'below-right')

  // Close the password-prompt when the popover closes.
  useEffect(() => {
    if (!open) setLoginUserId(null)
  }, [open])

  const modalRef = useRef<HTMLDivElement>(null)

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

  // Close sign-out confirmation modal on outside click
  useEffect(() => {
    function handleClick(e: MouseEvent): void {
      if (signOutModalRef.current && !signOutModalRef.current.contains(e.target as Node)) {
        setShowSignOutConfirm(false)
        setSignOutPassword('')
        setSignOutError('')
      }
    }
    if (showSignOutConfirm) document.addEventListener('mousedown', handleClick)
    return () => document.removeEventListener('mousedown', handleClick)
  }, [showSignOutConfirm])

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

  const handleSignOut = (): void => {
    setOpen(false)
    setShowSignOutConfirm(true)
    setSignOutPassword('')
    setSignOutError('')
  }

  const handleConfirmSignOut = async (): Promise<void> => {
    if (!currentUser) return
    setSignOutError('')

    if (currentUser.hasPassword && !signOutPassword) {
      setSignOutError('Password is required to remove this account')
      return
    }

    const result = await deleteUser.mutateAsync({
      userId: currentUser.id,
      password: signOutPassword || undefined
    })

    if (result.success) {
      setShowSignOutConfirm(false)
      setSignOutPassword('')
    } else {
      setSignOutError(result.error ?? 'Failed to remove account')
    }
  }

  const isDefault = currentUser?.id === '__default__'
  const initial = (currentUser?.cinnaFullName ?? currentUser?.displayName)?.charAt(0).toUpperCase() ?? '?'
  const allUsers = users ?? []

  return (
    <div className="relative">
      <button
        ref={triggerRef}
        onClick={() => setOpen(!open)}
        title={currentUser?.cinnaFullName ?? currentUser?.displayName ?? 'User'}
        className={
          compact
            ? 'p-0.5 rounded-md hover:bg-[var(--color-bg-hover)] transition-colors'
            : 'flex items-center gap-1.5 px-2 py-1 rounded-md hover:bg-[var(--color-bg-hover)] text-[var(--color-text-secondary)] transition-colors'
        }
      >
        <div className={`${compact ? 'w-6 h-6' : 'w-5 h-5'} rounded-full bg-[var(--color-accent)] flex items-center justify-center`}>
          {isDefault ? (
            <User size={compact ? 13 : 11} className="text-white" />
          ) : (
            <span className={`${compact ? 'text-[11px]' : 'text-[10px]'} font-bold text-white`}>{initial}</span>
          )}
        </div>
        {!compact && (
          <>
            <span className="text-xs font-medium max-w-[80px] truncate">
              {currentUser?.cinnaFullName ?? currentUser?.displayName ?? 'User'}
            </span>
            <ChevronDown size={12} />
          </>
        )}
      </button>

      {loginUserId && createPortal(
        <LoginPrompt
          userId={loginUserId}
          userName={users?.find((u) => u.id === loginUserId)?.displayName ?? ''}
          onSuccess={() => {
            setLoginUserId(null)
            setOpen(false)
          }}
          onCancel={() => setLoginUserId(null)}
        />,
        document.body
      )}

      {open && dropdownStyle && createPortal(
        <div
          ref={dropdownRef}
          style={dropdownStyle}
          className="w-64 rounded-lg border border-[var(--color-border)] bg-[var(--color-bg-secondary)] shadow-lg z-50 overflow-hidden"
        >
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
                  <div className="flex flex-col min-w-0 items-start">
                    <span className="truncate">{u.cinnaFullName ?? u.displayName}</span>
                    {u.type === 'cinna_user' && u.cinnaFullName && (
                      <span className="text-[10px] text-[var(--color-text-muted)] truncate">{u.displayName}</span>
                    )}
                  </div>
                  {u.id === '__default__' && (
                    <span className="shrink-0 px-1.5 py-0.5 rounded text-[9px] font-medium bg-[var(--color-bg-tertiary)] text-[var(--color-text-muted)]">
                      Guest
                    </span>
                  )}
                  {u.type === 'cinna_user' && u.cinnaServerUrl && (
                    <span
                      role="button"
                      title={u.cinnaServerUrl}
                      onClick={(e) => { e.stopPropagation(); window.open(u.cinnaServerUrl, '_blank') }}
                      className="shrink-0 text-[var(--color-text-muted)] hover:text-[var(--color-accent)] transition-colors cursor-pointer"
                    >
                      <Cloud size={15} />
                    </span>
                  )}
                </button>
              )
            })}
          </div>
          )}

          {/* Settings */}
          <div className="border-t border-[var(--color-border)] py-1">
            <button
              onClick={() => { setActiveView(activeView === 'settings' ? 'chat' : 'settings'); setOpen(false) }}
              className={`w-full flex items-center gap-2 px-3 py-2 text-xs transition-colors ${
                activeView === 'settings'
                  ? 'bg-[var(--color-bg-tertiary)] text-[var(--color-text)]'
                  : 'text-[var(--color-text-secondary)] hover:bg-[var(--color-bg-hover)]'
              }`}
            >
              <Settings size={14} />
              Settings
            </button>
          </div>

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
                onClick={handleSignOut}
                className="w-full flex items-center gap-2 px-3 py-2 text-xs text-[var(--color-text-secondary)] hover:bg-[var(--color-bg-hover)] transition-colors"
              >
                <LogOut size={14} />
                Sign Out
              </button>
            )}
          </div>
        </div>,
        document.body
      )}

      {/* Centered modal for account creation */}
      {showRegister && createPortal(
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
          <div ref={modalRef} className="w-96 rounded-lg border border-[var(--color-border)] bg-[var(--color-bg-secondary)] shadow-xl">
            <RegisterForm
              onSuccess={() => setShowRegister(false)}
              onCancel={() => setShowRegister(false)}
            />
          </div>
        </div>,
        document.body
      )}

      {/* Sign-out confirmation modal */}
      {showSignOutConfirm && currentUser && createPortal(
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
          <div ref={signOutModalRef} className="w-96 rounded-lg border border-[var(--color-border)] bg-[var(--color-bg-secondary)] shadow-xl p-5 space-y-4">
            <div className="flex items-center gap-2 text-sm font-medium text-red-400">
              <AlertTriangle size={16} />
              Sign Out — {currentUser.cinnaFullName ?? currentUser.displayName}
            </div>

            <p className="text-xs text-[var(--color-text-muted)] leading-relaxed">
              This will remove the account from this device. All <strong className="text-[var(--color-text)]">local</strong> chat
              history, providers, agents, and settings for this account will be permanently erased.
              {currentUser.type === 'cinna_user' && (
                <> Your Cinna cloud account will not be affected.</>
              )}
            </p>

            {currentUser.hasPassword && (
              <div>
                <label className="block text-[10px] text-[var(--color-text-muted)] mb-0.5">
                  Enter password to confirm
                </label>
                <input
                  type="password"
                  value={signOutPassword}
                  onChange={(e) => setSignOutPassword(e.target.value)}
                  placeholder="Password"
                  className="w-full bg-[var(--color-bg)] text-[var(--color-text)] px-2.5 py-1.5 rounded-md text-xs border border-[var(--color-border)] focus:border-[var(--color-accent)] focus:outline-none"
                  autoFocus
                />
              </div>
            )}

            {signOutError && (
              <div className="text-[10px] text-red-400">{signOutError}</div>
            )}

            <div className="flex justify-end gap-2">
              <button
                onClick={() => { setShowSignOutConfirm(false); setSignOutPassword(''); setSignOutError('') }}
                className="px-3 py-1.5 rounded-md text-xs font-medium border border-[var(--color-border)] text-[var(--color-text-muted)] hover:text-[var(--color-text)] transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={handleConfirmSignOut}
                disabled={deleteUser.isPending}
                className="px-3 py-1.5 rounded-md text-xs font-medium bg-red-500 hover:bg-red-600 text-white transition-colors disabled:opacity-50"
              >
                {deleteUser.isPending ? 'Removing...' : 'Remove Account'}
              </button>
            </div>
          </div>
        </div>,
        document.body
      )}
    </div>
  )
}
