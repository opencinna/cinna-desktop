import type { RemoteAgentMetadata } from './agentMetadata'

export function isBundleAgent(agent: { source: string; remoteTargetType: string | null; remoteMetadata: RemoteAgentMetadata | null }): boolean {
  return agent.source === 'remote' && agent.remoteTargetType === 'agent' &&
    !!(agent.remoteMetadata?.bundle_uuid || agent.remoteMetadata?.bundle_id) &&
    agent.remoteMetadata?.is_publisher_install !== true
}
