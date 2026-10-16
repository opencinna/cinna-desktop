import type { AgentShareStatus } from '../../../../../../shared/agentSharing'
import { useListedShareStatus, useShareStatus } from '../../../../hooks/useSharing'

/**
 * This agent's own status once it lands, else its entry in the statuses list:
 * `undefined` while the list loads, `null` when the agent is not shared.
 *
 * In a file of its own because the badge, the Sharing tab, the chat banner
 * and the page's actions all read it, and the actions are what the badge
 * imports — the hook living in the badge would be a cycle.
 */
export function useAgentShareStatus(agentId: string): AgentShareStatus | null | undefined {
  const listed = useListedShareStatus(agentId)
  const own = useShareStatus(listed ? agentId : null, listed ? listed.remote.kind : null)
  if (!listed) return listed
  return own.data === undefined ? listed : own.data
}
