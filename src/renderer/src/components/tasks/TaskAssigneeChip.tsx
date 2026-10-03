import type { TaskDto } from '../../../../shared/tasks'
import { useAgents } from '../../hooks/useAgents'
import { AgentTypeIcon } from '../agents/AgentTypeIcon'

/** The agent a task is assigned to, by the name the agents list gives it now (else the name the task recorded). */
export function taskAssigneeAgent(
  task: Pick<TaskDto, 'assignee'>,
  agents: readonly { id: string; name: string }[] | undefined
): { name: string | null; agentId: string | null } | null {
  const { kind, agentId, name } = task.assignee
  if (kind !== 'agent' && kind !== 'remote_agent') return null
  const found = agentId ? agents?.find((entry) => entry.id === agentId) : undefined
  return { name: found?.name ?? name, agentId: agentId ?? null }
}

/**
 * Whose task it is, small: the agent's type icon in its chosen color, then its
 * name. The board's cards and the Tasks list's rows share it, so the two
 * layouts name an assignee one way. Nothing for a task with no agent — an
 * Unassigned task leaves the space empty rather than saying so on every row.
 */
export function TaskAssigneeChip({ task, className = '' }: {
  task: Pick<TaskDto, 'assignee'>
  className?: string
}): React.JSX.Element | null {
  const { data: agents } = useAgents()
  const assignee = taskAssigneeAgent(task, agents)
  if (!assignee?.name) return null
  const agent = assignee.agentId ? agents?.find((entry) => entry.id === assignee.agentId) : undefined
  return (
    <span className={`flex min-w-0 items-center gap-1 text-[11px] text-[var(--color-text-muted)] ${className}`}>
      {agent && <AgentTypeIcon agent={agent} agentId={agent.id} size={12} />}
      <span className="truncate" title={assignee.name}>{assignee.name}</span>
    </span>
  )
}
