import { useState } from 'react'
import { User, Cloud, HardDrive, Trash2, ChevronDown, ChevronUp, Lock, Unlock, AlertTriangle } from 'lucide-react'
import { useUsers, useUpdateUser, useDeleteUser } from '../../hooks/useAuth'
import { useAuthStore } from '../../stores/auth.store'
import { AnimatedCollapse } from '../ui/AnimatedCollapse'

const inputClass =
  'w-full bg-[var(--color-bg)] text-[var(--color-text)] px-2.5 py-1.5 rounded-md text-xs border border-[var(--color-border)] focus:border-[var(--color-accent)] focus:outline-none'

interface UserCardProps {
  user: {
    id: string
    type: string
    username: string
    displayName: string
    hasPassword: boolean
    createdAt: Date
    cinnaHostingType?: 'cloud' | 'self_hosted'
    cinnaServerUrl?: string
    hasCinnaTokens?: boolean
  }
  isCurrentUser: boolean
}

function UserAccountCard({ user, isCurrentUser }: UserCardProps): React.JSX.Element {
  const [expanded, setExpanded] = useState(false)
  const [displayName, setDisplayName] = useState(user.displayName)
  const [newPassword, setNewPassword] = useState('')
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false)
  const [deletePassword, setDeletePassword] = useState('')
  const [error, setError] = useState('')

  const updateUser = useUpdateUser()
  const deleteUser = useDeleteUser()

  const isDefault = user.id === '__default__'
  const isCinna = user.type === 'cinna_user'

  const handleSave = async (): Promise<void> => {
    setError('')
    const data: { userId: string; displayName?: string; password?: string } = {
      userId: user.id
    }

    if (displayName.trim() && displayName.trim() !== user.displayName) {
      data.displayName = displayName.trim()
    }
    if (newPassword) {
      data.password = newPassword
    }

    if (!data.displayName && !data.password) return

    const result = await updateUser.mutateAsync(data)
    if (result.success) {
      setNewPassword('')
    } else {
      setError(result.error ?? 'Update failed')
    }
  }

  const handleRemovePassword = async (): Promise<void> => {
    setError('')
    const result = await updateUser.mutateAsync({
      userId: user.id,
      removePassword: true
    })
    if (!result.success) {
      setError(result.error ?? 'Failed to remove password')
    }
  }

  const handleDelete = async (): Promise<void> => {
    setError('')

    if (user.hasPassword && !deletePassword) {
      setError('Password is required to delete this account')
      return
    }

    const result = await deleteUser.mutateAsync({
      userId: user.id,
      password: deletePassword || undefined
    })

    if (!result.success) {
      setError(result.error ?? 'Delete failed')
    }
  }

  const TypeIcon = isCinna ? Cloud : isDefault ? User : HardDrive

  return (
    <div className="rounded-lg border border-[var(--color-border)] bg-[var(--color-bg-secondary)] overflow-hidden">
      {/* Header */}
      <button
        onClick={() => !isDefault && setExpanded(!expanded)}
        disabled={isDefault}
        className={`w-full flex items-center gap-3 px-4 py-3 text-left transition-colors ${
          isDefault ? 'cursor-default' : 'hover:bg-[var(--color-bg-hover)]'
        }`}
      >
        <div className={`w-8 h-8 rounded-full flex items-center justify-center shrink-0 ${
          isCurrentUser ? 'bg-[var(--color-accent)]' : 'bg-[var(--color-bg-tertiary)]'
        }`}>
          {isDefault ? (
            <User size={14} className={isCurrentUser ? 'text-white' : ''} />
          ) : (
            <span className={`text-xs font-bold ${isCurrentUser ? 'text-white' : ''}`}>
              {user.displayName.charAt(0).toUpperCase()}
            </span>
          )}
        </div>

        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <span className="text-xs font-medium text-[var(--color-text)] truncate">
              {user.displayName}
            </span>
            {isDefault && (
              <span className="shrink-0 px-1.5 py-0.5 rounded text-[9px] font-medium bg-[var(--color-bg-tertiary)] text-[var(--color-text-muted)]">
                Guest
              </span>
            )}
            {isCurrentUser && !isDefault && (
              <span className="shrink-0 px-1.5 py-0.5 rounded text-[9px] font-medium bg-[var(--color-accent)]/15 text-[var(--color-accent)]">
                Active
              </span>
            )}
          </div>
          <div className="flex items-center gap-2 mt-0.5">
            <TypeIcon size={10} className="text-[var(--color-text-muted)] shrink-0" />
            <span className="text-[10px] text-[var(--color-text-muted)] truncate">
              {isCinna
                ? `Cinna · ${user.cinnaHostingType === 'cloud' ? 'Cloud' : user.cinnaServerUrl ?? 'Self-hosted'}`
                : isDefault
                  ? 'Built-in guest account'
                  : `Local · @${user.username}`}
            </span>
            {user.hasPassword ? (
              <Lock size={10} className="text-[var(--color-text-muted)] shrink-0" />
            ) : !isDefault ? (
              <Unlock size={10} className="text-[var(--color-text-muted)] shrink-0" />
            ) : null}
          </div>
        </div>

        {!isDefault && (
          expanded ? <ChevronUp size={14} className="text-[var(--color-text-muted)]" />
            : <ChevronDown size={14} className="text-[var(--color-text-muted)]" />
        )}
      </button>

      {/* Expanded content */}
      <AnimatedCollapse open={expanded && !isDefault}>
        <div className="border-t border-[var(--color-border)] px-4 py-3 space-y-3">
          {/* Cinna account details (read-only) */}
          {isCinna && (
            <div className="space-y-2 pb-2 border-b border-[var(--color-border)]">
              <h3 className="text-[10px] font-medium uppercase tracking-wider text-[var(--color-text-muted)]">
                Cinna Server Details
              </h3>
              <div className="grid grid-cols-2 gap-2">
                <div>
                  <div className="text-[10px] text-[var(--color-text-muted)]">Host</div>
                  <div className="text-xs text-[var(--color-text)]">
                    {user.cinnaHostingType === 'cloud'
                      ? 'opencinna.io (Cloud)'
                      : user.cinnaServerUrl ?? 'Unknown'}
                  </div>
                </div>
                <div>
                  <div className="text-[10px] text-[var(--color-text-muted)]">Hosting</div>
                  <div className="text-xs text-[var(--color-text)]">
                    {user.cinnaHostingType === 'cloud' ? 'Cloud' : 'Self-Hosted'}
                  </div>
                </div>
                <div>
                  <div className="text-[10px] text-[var(--color-text-muted)]">Connection</div>
                  <div className="text-xs text-[var(--color-text)]">
                    {user.hasCinnaTokens ? 'Connected' : 'Not connected'}
                  </div>
                </div>
                <div>
                  <div className="text-[10px] text-[var(--color-text-muted)]">Email</div>
                  <div className="text-xs text-[var(--color-text)] truncate">{user.username}</div>
                </div>
              </div>
            </div>
          )}

          {/* Editable fields */}
          {!isCinna && (
            <div>
              <label className="block text-[10px] text-[var(--color-text-muted)] mb-0.5">Display Name</label>
              <input
                value={displayName}
                onChange={(e) => setDisplayName(e.target.value)}
                className={inputClass}
              />
            </div>
          )}

          {/* Password section */}
          <div>
            <label className="block text-[10px] text-[var(--color-text-muted)] mb-0.5">
              {user.hasPassword ? 'Change Password' : 'Set Password'}
            </label>
            <input
              type="password"
              value={newPassword}
              onChange={(e) => setNewPassword(e.target.value)}
              placeholder={user.hasPassword ? 'New password' : 'Set a password (optional)'}
              className={inputClass}
            />
          </div>

          {error && <div className="text-[10px] text-red-400">{error}</div>}

          {/* Action buttons */}
          <div className="flex items-center gap-2">
            <button
              onClick={() => { setShowDeleteConfirm(true); setError('') }}
              className="p-1.5 rounded-md text-[var(--color-text-muted)] hover:text-red-400 hover:bg-red-400/10 transition-colors"
              title="Delete account"
            >
              <Trash2 size={14} />
            </button>

            <div className="flex-1" />

            {user.hasPassword && (
              <button
                onClick={handleRemovePassword}
                disabled={updateUser.isPending}
                className="px-3 py-1.5 rounded-md text-xs font-medium border border-[var(--color-border)] text-[var(--color-text-muted)] hover:text-[var(--color-text)] transition-colors disabled:opacity-50"
              >
                Remove Password
              </button>
            )}

            <button
              onClick={handleSave}
              disabled={updateUser.isPending}
              className="px-3 py-1.5 rounded-md text-xs font-medium bg-[var(--color-accent)] hover:bg-[var(--color-accent-hover)] text-white transition-colors disabled:opacity-50"
            >
              {updateUser.isPending ? 'Saving...' : 'Save Changes'}
            </button>
          </div>

          {/* Delete confirmation */}
          {showDeleteConfirm && (
            <div className="rounded-md border border-red-400/30 bg-red-400/5 p-3 space-y-2">
              <div className="flex items-center gap-2 text-xs font-medium text-red-400">
                <AlertTriangle size={14} />
                Delete Account
              </div>
              <p className="text-[10px] text-[var(--color-text-muted)]">
                This will permanently delete this account and all associated data
                (chats, providers, agents, settings).
                {isCinna && ' The Cinna cloud account will not be affected.'}
              </p>

              {user.hasPassword && (
                <input
                  type="password"
                  value={deletePassword}
                  onChange={(e) => setDeletePassword(e.target.value)}
                  placeholder="Enter password to confirm"
                  className={inputClass}
                  autoFocus
                />
              )}

              {error && <div className="text-[10px] text-red-400">{error}</div>}

              <div className="flex justify-end gap-2">
                <button
                  onClick={() => { setShowDeleteConfirm(false); setDeletePassword(''); setError('') }}
                  className="px-3 py-1.5 rounded-md text-xs font-medium border border-[var(--color-border)] text-[var(--color-text-muted)] hover:text-[var(--color-text)] transition-colors"
                >
                  Cancel
                </button>
                <button
                  onClick={handleDelete}
                  disabled={deleteUser.isPending}
                  className="px-3 py-1.5 rounded-md text-xs font-medium bg-red-500 hover:bg-red-600 text-white transition-colors disabled:opacity-50"
                >
                  {deleteUser.isPending ? 'Deleting...' : 'Delete Account'}
                </button>
              </div>
            </div>
          )}
        </div>
      </AnimatedCollapse>
    </div>
  )
}

export function UserAccountsSection(): React.JSX.Element {
  const { data: users } = useUsers()
  const currentUser = useAuthStore((s) => s.currentUser)
  const allUsers = users ?? []

  return (
    <div className="space-y-3">
      <p className="text-xs text-[var(--color-text-muted)] -mt-1 mb-3">
        Manage local user accounts. Each account has its own chats, providers, agents, and settings.
      </p>

      {allUsers.map((user) => (
        <UserAccountCard
          key={user.id}
          user={user}
          isCurrentUser={user.id === currentUser?.id}
        />
      ))}
    </div>
  )
}
