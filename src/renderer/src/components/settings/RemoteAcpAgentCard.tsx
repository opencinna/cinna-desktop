import { useState } from 'react'
import { useDeleteAgent, useSetAgentEnabled } from '../../hooks/useAgents'
import { CustomAgentModal } from '../agents/CustomAgentModal'

type AgentData = Awaited<ReturnType<typeof window.api.agents.list>>[number]

export function RemoteAcpAgentCard({ agent }: { agent: AgentData }): React.JSX.Element {
  const [editing, setEditing] = useState(false)
  const remove = useDeleteAgent()
  const enabled = useSetAgentEnabled()
  const error = remove.error ?? enabled.error
  return <div className="rounded-lg border border-[var(--color-border)] bg-[var(--color-bg-secondary)] p-3 text-sm">
    <div className="flex items-center gap-3">
      <div className="min-w-0 flex-1"><div className="truncate font-medium">{agent.name}</div><div className="text-xs text-[var(--color-text-muted)]">ACP · WebSocket{!agent.enabled ? ' · Disabled' : ''}</div></div>
      <button type="button" className="text-xs text-[var(--color-accent)]" disabled={enabled.isPending} onClick={() => enabled.mutate({ agentId: agent.id, enabled: !agent.enabled })}>{agent.enabled ? 'Disable' : 'Enable'}</button>
      <button type="button" className="text-xs text-[var(--color-accent)]" onClick={() => setEditing(true)}>Configure</button>
      <button type="button" className="text-xs text-[var(--color-danger)]" disabled={remove.isPending} onClick={() => remove.mutate(agent.id)}>Delete</button>
    </div>
    {agent.enabled && agent.readiness?.reason && <p className="mt-2 text-xs text-[var(--color-text-muted)]">{agent.readiness.reason}</p>}
    {error && <p role="alert" className="mt-2 text-xs text-[var(--color-danger)]">{String(error)}</p>}
    {editing && <CustomAgentModal remote agentId={agent.id} onClose={() => setEditing(false)} />}
  </div>
}
