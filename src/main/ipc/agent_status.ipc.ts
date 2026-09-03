import {
  agentStatusService,
  type AgentStatusScope,
  type AgentStatusSnapshot
} from '../services/agentStatusService'
import { userActivation } from '../auth/activation'
import { getProfileScopeUserId, getSettingsScopeUserId } from '../auth/scope'
import { ipcErrorShape } from '../errors'
import { CinnaReauthRequired } from '../auth/cinna-oauth'
import { ipcHandle } from './_wrap'

/**
 * Both scopes, resolved here rather than inside the service, the way
 * `agent_a2a.ipc.ts:175` already resolves them for `agentService.findAgent`.
 *
 * Folder agents are written under the settings scope by every handler in
 * `local_agent.ipc.ts`, so reading them under the profile scope returns `[]` —
 * a valid call with an empty answer, which is why passing only
 * `getProfileScopeUserId()` here made the folder status leg silently dead for
 * every user except the Default profile.
 */
function statusScope(): AgentStatusScope {
  return {
    defaultUserId: getSettingsScopeUserId(),
    profileUserId: getProfileScopeUserId()
  }
}

export function registerAgentStatusHandlers(): void {
  ipcHandle('agent-status:list', async () => {
    userActivation.requireActivated()
    try {
      const { items, remoteError } = await agentStatusService.list(statusScope())
      // A *partial* success: the Cinna leg failed but folder agents answered
      // from disk. `success: true` because there are rows to show; `remoteError`
      // because the rows that are missing must not go missing silently.
      return { success: true as const, items, remoteError }
    } catch (err) {
      if (err instanceof CinnaReauthRequired) {
        return { success: false as const, code: 'reauth_required' as const, error: err.message }
      }
      const e = ipcErrorShape(err)
      return { success: false as const, code: e.code, error: e.message }
    }
  })

  ipcHandle(
    'agent-status:get',
    async (
      _event,
      data: { agentId: string; forceRefresh?: boolean }
    ): Promise<
      | { success: true; item: AgentStatusSnapshot | null }
      | { success: false; code: string; error: string }
    > => {
      userActivation.requireActivated()
      try {
        const item = await agentStatusService.get(
          statusScope(),
          data.agentId,
          data.forceRefresh ?? false
        )
        return { success: true as const, item }
      } catch (err) {
        if (err instanceof CinnaReauthRequired) {
          return { success: false as const, code: 'reauth_required', error: err.message }
        }
        const e = ipcErrorShape(err)
        return { success: false as const, code: e.code, error: e.message }
      }
    }
  )
}
