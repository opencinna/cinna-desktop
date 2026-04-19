import { PanelLeft, Activity } from 'lucide-react'
import { useUIStore } from '../../stores/ui.store'
import { UserMenu } from '../auth/UserMenu'
import { useAuthStore } from '../../stores/auth.store'
import { useAgentStatus } from '../../hooks/useAgentStatus'
import { SEVERITY_DOT, worstSeverity } from '../../constants/agentSeverity'

export function TitleBar(): React.JSX.Element {
  const { toggleSidebar, agentStatusOpen, setAgentStatusOpen } = useUIStore()
  const currentUser = useAuthStore((s) => s.currentUser)
  const isCinnaUser = currentUser?.type === 'cinna_user'
  const { data: statuses, refetch } = useAgentStatus()
  const worst = worstSeverity(statuses)
  const title =
    statuses.length === 0
      ? 'Agent status'
      : `Agent status — ${statuses.length} agent${statuses.length === 1 ? '' : 's'}${worst ? ` · worst: ${worst}` : ''}`

  return (
    <div className="titlebar h-10 flex items-center justify-between px-3 border-b border-[var(--color-border)] bg-[var(--color-bg-secondary)] shrink-0">
      <div className="flex items-center gap-1.5">
        <div className="w-[68px]" />
        <button
          onClick={toggleSidebar}
          className="p-1 rounded hover:bg-[var(--color-bg-hover)] text-[var(--color-text-secondary)] transition-colors"
        >
          <PanelLeft size={16} />
        </button>
      </div>

      <span className="text-xs font-medium text-[var(--color-text-muted)]">Cinna Desktop</span>

      <div className="flex items-center justify-end gap-1">
        {isCinnaUser && (
          <button
            onClick={() => {
              const next = !agentStatusOpen
              setAgentStatusOpen(next)
              // Opening the overlay kicks off a fresh batch fetch so the
              // user sees current statuses, not whatever the 45 s poll
              // happened to have cached last.
              if (next) refetch()
            }}
            title={title}
            className={`relative p-1 rounded transition-colors ${
              agentStatusOpen
                ? 'bg-[var(--color-bg-tertiary)] text-[var(--color-text)]'
                : 'hover:bg-[var(--color-bg-hover)] text-[var(--color-text-secondary)]'
            }`}
          >
            <Activity size={16} />
            {worst && (
              <span
                className={`absolute top-0.5 right-0.5 w-2 h-2 rounded-full border border-[var(--color-bg-secondary)] ${SEVERITY_DOT[worst]}`}
              />
            )}
          </button>
        )}
        <UserMenu />
      </div>
    </div>
  )
}
