import type { RemoteAgentMetadata } from './agentMetadata'
import { isBundleAgent } from './agentPresentation'

/**
 * An agent this account may build on locally: its own, on a Cinna server.
 *
 * The exact complement of {@link isBundleAgent} within the remote agents that
 * name a target — you can develop what you own, you can uninstall what you
 * installed, and no agent is both. Expressed by calling it rather than by
 * restating its condition, because the two drifted apart once already and the
 * agent that fell through the gap was developable by nobody.
 */
export function canDevelopAgent(agent: {
  source: string
  remoteTargetType: string | null
  remoteTargetId: string | null
  remoteMetadata: RemoteAgentMetadata | null
}): boolean {
  return agent.remoteMetadata?.can_build !== false && agent.remoteMetadata?.is_foreign_install !== true &&
    agent.source === 'remote' && agent.remoteTargetType === 'agent' && !!agent.remoteTargetId &&
    !isBundleAgent(agent)
}
