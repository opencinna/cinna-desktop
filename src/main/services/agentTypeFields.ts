import type { AgentRow } from '../db/agents'

/**
 * How a custom ACP agent is reached; absent for every other agent. One
 * derivation for the agent DTO and for anything else that sends an agent's
 * type to the renderer (`AgentTypeIcon` reads it), so the two cannot disagree.
 */
export function acpTransportOf(row: Pick<AgentRow, 'driver' | 'driverConfig'>): 'stdio' | 'websocket' | undefined {
  if (row.driver !== 'acp' || row.driverConfig?.launcher !== 'custom') return undefined
  return row.driverConfig.transport === 'websocket' ? 'websocket' : 'stdio'
}
