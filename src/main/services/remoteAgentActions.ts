import { agentRepo } from '../db/agents'
import { AgentError } from '../errors'
import { agentReadinessService } from './agentReadinessService'
import { cinnaFetch } from './cinna-http'
import { isBundleAgent } from '../../shared/agentPresentation'

/** Delete on the owning server first; pruning only the cache would undo itself on sync. */
export async function deleteRemoteAgent(userId: string, agentId: string): Promise<void> {
  const agent = agentRepo.getOwned(userId, agentId)
  if (!agent || agent.source !== 'remote' || agent.remoteTargetType !== 'agent' || !agent.remoteTargetId) {
    throw new AgentError('not_found', 'This remote agent cannot be deleted from this profile.')
  }
  if (isBundleAgent(agent)) throw new AgentError('remote_immutable', 'Uninstall this bundle agent instead.')
  // The server authorizes developer access and ownership, and cleans up the environment.
  await cinnaFetch(userId, `/api/v1/agents/${encodeURIComponent(agent.remoteTargetId)}`, { method: 'DELETE' })
  agentRepo.delete(userId, agentId)
  agentReadinessService.forget(agentId)
}
