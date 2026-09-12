import type { AgentStatusSnapshot, StatusRefreshIntent } from '../../../shared/agentStatus'

/** Optional status data source, independent of the transport used for a turn. */
export interface AgentStatusSource {
  read(intent: StatusRefreshIntent): Promise<AgentStatusSnapshot | null>
}
