import { agentStatusService, type AgentStatusSnapshot } from '../services/agentStatusService'
import { getCurrentUserId } from '../auth/session'
import { userActivation } from '../auth/activation'
import { ipcErrorShape } from '../errors'
import { CinnaReauthRequired } from '../auth/cinna-oauth'
import { ipcHandle } from './_wrap'

export function registerAgentStatusHandlers(): void {
  ipcHandle('agent-status:list', async () => {
    userActivation.requireActivated()
    try {
      const items = await agentStatusService.list(getCurrentUserId())
      return { success: true as const, items }
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
          getCurrentUserId(),
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
