import { Bot, SquareTerminal, Waypoints } from 'lucide-react'

type AgentType = { source: string; driver?: string | null; protocol?: string; acpTransport?: string | null }

/** Type stays stable when connectivity or readiness changes. */
export function AgentTypeIcon({ agent, size = 14, className = '' }: {
  agent: AgentType
  size?: number
  className?: string
}): React.JSX.Element {
  const local = agent.source === 'folder'
  const network = agent.source === 'remote' || agent.protocol === 'a2a' || agent.acpTransport === 'websocket'
  const Icon = local ? SquareTerminal : network ? Waypoints : Bot
  const label = local ? 'Local CLI agent' : network ? (agent.acpTransport === 'websocket' ? 'Remote ACP agent' : 'A2A agent') : agent.driver === 'managed' ? 'Managed agent' : 'ACP agent'
  return <span title={label} className={`inline-flex shrink-0 text-[var(--color-text-muted)] ${className}`}><Icon size={size} aria-hidden="true" /></span>
}
