import { Activity } from 'lucide-react'
import { useUIStore } from '../../stores/ui.store'
import { useAgentStatus } from '../../hooks/useAgentStatus'
import { SEVERITY_DOT, worstSeverity } from '../../constants/agentSeverity'

/**
 * Sidebar footer button that opens the agent-status overlay and shows a
 * severity dot for the worst current status. Only shown for cinna users.
 */
export function AgentStatusButton(): React.JSX.Element {
  const agentStatusOpen = useUIStore((s) => s.agentStatusOpen)
  const setAgentStatusOpen = useUIStore((s) => s.setAgentStatusOpen)
  const { data: statuses, refetch } = useAgentStatus()
  const worst = worstSeverity(statuses)
  const title =
    statuses.length === 0
      ? 'Agent status'
      : `Agent status — ${statuses.length} agent${statuses.length === 1 ? '' : 's'}${worst ? ` · worst: ${worst}` : ''}`

  return (
    <button
      onClick={() => {
        const next = !agentStatusOpen
        setAgentStatusOpen(next)
        // Opening the overlay kicks off a fresh batch fetch so the user sees
        // current statuses, not whatever the 45s poll happened to have cached.
        if (next) refetch()
      }}
      title={title}
      className={`relative p-1.5 rounded-md transition-colors ${
        agentStatusOpen
          ? 'bg-[var(--color-bg-tertiary)] text-[var(--color-text)]'
          : 'text-[var(--color-text-muted)] hover:bg-[var(--color-bg-hover)] hover:text-[var(--color-text-secondary)]'
      }`}
    >
      <Activity size={14} />
      {worst && (
        <span
          className={`absolute top-0.5 right-0.5 w-1.5 h-1.5 rounded-full ${SEVERITY_DOT[worst]}`}
        />
      )}
    </button>
  )
}
