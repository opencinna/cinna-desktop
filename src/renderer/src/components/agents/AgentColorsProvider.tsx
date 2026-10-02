import { useMemo, type ReactNode } from 'react'
import { useAgentColors } from '../../hooks/useAgents'
import { AgentColorsContext, agentColorMap } from '../../utils/agentColors'

/**
 * Reads the active profile's chosen agent colors once, at the app root, and
 * hands them down through {@link AgentColorsContext}: the sidebar icons, the
 * chat-row dots and every per-agent chip take them from there.
 */
export function AgentColorsProvider({ children }: { children: ReactNode }): React.JSX.Element {
  const { data } = useAgentColors()
  const colors = useMemo(() => agentColorMap(data), [data])
  return <AgentColorsContext.Provider value={colors}>{children}</AgentColorsContext.Provider>
}
