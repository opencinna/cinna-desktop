import { useAgents } from '../../../hooks/useAgents'
import { useAuthStore } from '../../../stores/auth.store'

/**
 * The non-folder agents the Agents sidebar lists, split the way it groups them:
 * the active Cinna server's agents, hand-added A2A connections, command-line
 * ACP agents and managed ones.
 *
 * One copy of the filters, shared by the sidebar and by the empty agent pane,
 * which shows "Create a local agent" only when the sidebar has nothing in it at
 * all. Two copies would drift, and the pane would then offer a first agent to
 * someone whose sidebar already lists one.
 *
 * `loaded` is false until the agents query has answered: "none yet" and "not
 * known yet" are different, and a surface that guessed would show one and then
 * the other. `failed` says it will not answer.
 */
export function useSidebarExternalAgents() {
  const { data: agentData, isError } = useAgents()
  const profile = useAuthStore((state) => state.currentUser)
  const allAgents = agentData?.filter((agent) => !agent.conductor && (agent.source !== 'remote' || agent.enabled !== false))
  const remoteAgents = profile?.type === 'cinna_user' ? (allAgents ?? []).filter((agent) => agent.source === 'remote') : []
  const a2aAgents = (allAgents ?? []).filter((agent) => agent.source === 'local' && agent.protocol === 'a2a')
  const managedAgents = (allAgents ?? []).filter((agent) => agent.driver === 'managed')
  const commandAgents = (allAgents ?? []).filter((agent) => agent.driver === 'acp' && agent.capabilities.cwd === false)
  return {
    loaded: agentData !== undefined,
    /** The agents query failed: nothing more is coming, so stop waiting for it. */
    failed: isError,
    remoteAgents,
    a2aAgents,
    managedAgents,
    commandAgents,
    count: remoteAgents.length + a2aAgents.length + managedAgents.length + commandAgents.length
  }
}
