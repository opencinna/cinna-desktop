import { agentService } from '../services/agentService'
import { userActivation } from '../auth/activation'
import { getSettingsScopeUserId, getProfileScopeUserId } from '../auth/scope'
import { ipcErrorShape } from '../errors'
import { CinnaReauthRequired } from '../auth/cinna-oauth'
import { notifyRemoteSyncComplete } from '../agents/remote-sync'
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
      // Broadcast like the periodic runner so `useAgents` invalidates
      // `['agents']` after a renderer-triggered sync — without this, callers
      // that rely on the sync to refresh agent rows (catalog refresh,
      // bundle-update apply) write the DB but the UI keeps stale data.
      notifyRemoteSyncComplete()
      return { success: true as const, ...result }
    } catch (err) {
      if (err instanceof CinnaReauthRequired) {
        notifyRemoteSyncComplete({ error: 'reauth_required' })
        return { success: false as const, code: 'reauth_required' as const, error: err.message }
      }
      const e = ipcErrorShape(err)
      notifyRemoteSyncComplete({ error: 'sync_failed' })
      return { success: false as const, code: e.code, error: e.message }
    }
  })

  // Apply the latest bundle revision to an installed agent (native in-app
  // update). Returns the post-update version snapshot so both the Catalog
  // card and the Agents list can refresh without a second round-trip. Inline
  // error shape mirrors agent:sync-remote so the UI can branch on reauth.
  ipcHandle('agent:apply-bundle-update', async (_event, installId: string) => {
    userActivation.requireActivated()
    try {
      const bundleVersion = await agentService.applyBundleUpdate(
        getProfileScopeUserId(),
        installId
      )
      return { success: true as const, bundleVersion }
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
