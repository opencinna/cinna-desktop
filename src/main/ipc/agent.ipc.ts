import { agentService } from '../services/agentService'
import { userActivation } from '../auth/activation'
import { getSettingsScopeUserId, getProfileScopeUserId } from '../auth/scope'
import { ipcErrorShape } from '../errors'
import { CinnaReauthRequired } from '../auth/cinna-oauth'
import { registerA2AHandlers } from './agent_a2a.ipc'
import { ipcHandle } from './_wrap'

export function registerAgentHandlers(): void {
  // Local agents live in the shared default scope; remote agents stay tied to
  // the active profile (Cinna sync owns them).
  ipcHandle('agent:list', async () => {
    userActivation.requireActivated()
    return agentService.listMerged(getSettingsScopeUserId(), getProfileScopeUserId())
  })

  // agent:upsert/delete/sync-remote return inline errors so the settings UI
  // can surface agent-specific messages (reauth, invalid URL, etc.).
  ipcHandle(
    'agent:upsert',
    async (
      _event,
      data: {
        id?: string
        name: string
        description?: string
        protocol: string
        cardUrl?: string
        endpointUrl?: string
        protocolInterfaceUrl?: string
        protocolInterfaceVersion?: string
        accessToken?: string
        cardData?: Record<string, unknown>
        skills?: Array<{ id: string; name: string; description?: string }>
        enabled?: boolean
      }
    ) => {
      userActivation.requireActivated()
      try {
        const { id } = agentService.upsert(getSettingsScopeUserId(), data)
        return { id, success: true as const }
      } catch (err) {
        const e = ipcErrorShape(err)
        return { success: false as const, error: e.message }
      }
    }
  )

  ipcHandle(
    'agent:set-enabled',
    async (_event, data: { agentId: string; enabled: boolean }) => {
      userActivation.requireActivated()
      try {
        agentService.setEnabled(
          getSettingsScopeUserId(),
          getProfileScopeUserId(),
          data.agentId,
          data.enabled
        )
        return { success: true as const }
      } catch (err) {
        const e = ipcErrorShape(err)
        return { success: false as const, error: e.message }
      }
    }
  )

  ipcHandle('agent:delete', async (_event, agentId: string) => {
    userActivation.requireActivated()
    try {
      agentService.delete(getSettingsScopeUserId(), agentId)
      return { success: true as const }
    } catch (err) {
      const e = ipcErrorShape(err)
      return { success: false as const, error: e.message }
    }
  })

  ipcHandle('agent:sync-remote', async () => {
    userActivation.requireActivated()
    try {
      const result = await agentService.syncRemoteAgents(getProfileScopeUserId())
      return { success: true as const, ...result }
    } catch (err) {
      if (err instanceof CinnaReauthRequired) {
        return { success: false as const, code: 'reauth_required' as const, error: err.message }
      }
      const e = ipcErrorShape(err)
      return { success: false as const, code: e.code, error: e.message }
    }
  })

  registerA2AHandlers()
}
