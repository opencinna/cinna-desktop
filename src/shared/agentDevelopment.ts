import type { RemoteAgentMetadata } from './agentMetadata'

export function canDevelopAgent(agent: {
  source: string
  remoteTargetType: string | null
  remoteTargetId: string | null
  remoteMetadata: RemoteAgentMetadata | null
}): boolean {
  return agent.remoteMetadata?.can_build !== false && agent.remoteMetadata?.is_foreign_install !== true && agent.source === 'remote' && agent.remoteTargetType === 'agent' && !!agent.remoteTargetId &&
    (!(agent.remoteMetadata?.bundle_uuid || agent.remoteMetadata?.bundle_id) || agent.remoteMetadata?.is_publisher_install === true)
}
