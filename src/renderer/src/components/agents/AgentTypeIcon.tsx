import { Bot, SquareTerminal, Waypoints } from 'lucide-react'
import { useChosenAgentColor } from '../../utils/agentColors'

type AgentType = { source: string; driver?: string | null; protocol?: string; acpTransport?: string | null }

/**
 * Type stays stable when connectivity or readiness changes. `color` is the
 * agent's chosen color preset, drawn instead of the muted default; given
 * `agentId` instead, the icon looks the chosen color up itself.
 */
export function AgentTypeIcon({ agent, size = 14, className = '', color: given, agentId }: {
  agent: AgentType
  size?: number
  className?: string
  color?: string | null
  agentId?: string
}): React.JSX.Element {
  const chosen = useChosenAgentColor()
  const color = given ?? chosen(agentId)
  const local = agent.source === 'folder'
  const network = agent.source === 'remote' || agent.protocol === 'a2a' || agent.acpTransport === 'websocket'
  const Icon = local ? SquareTerminal : network ? Waypoints : Bot
  const label = local ? 'Local CLI agent' : network ? (agent.acpTransport === 'websocket' ? 'Remote ACP agent' : 'A2A agent') : agent.driver === 'managed' ? 'Managed agent' : 'ACP agent'
  return <span title={label} className={`inline-flex shrink-0 ${color ? '' : 'text-[var(--color-text-muted)]'} ${className}`}
    style={color ? { color } : undefined}><Icon size={size} aria-hidden="true" /></span>
}
