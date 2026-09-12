import type { AgentRow } from '../../db/agents'
import type { AgentStatusSource } from './contract'
import { folderStatusSource } from './folderStatusSource'
import { cinnaStatusSource } from './cinnaStatusSource'

/** Resolve the owner of status data; transport capabilities do not imply a status source. */
export function statusSourceFor(userId: string, agent: AgentRow): AgentStatusSource | null {
  if (agent.source === 'folder') return folderStatusSource(userId, agent)
  if (agent.source === 'remote' && agent.remoteTargetId) return cinnaStatusSource(userId, agent)
  return null
}
