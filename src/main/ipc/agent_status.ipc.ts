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
    try {
      // Inside the try, not above it. `requireActivated` throws a **plain**
      // `Error` (`activation.ts:113`) and `ipcHandle` re-throws, so an invoke
      // rejects — and by then the code is gone: `ipcMain.handle` serialises a
      // rejection to message + stack and `contextBridge` re-clones it, which is
      // why `_wrap.ts` says in as many words to *return the code as data rather
      // than throw it*. The renderer's typed-error check then failed to match,
      // the query resolved to `error: null, data: []`, and both the overlay and
      // the tray rendered "No agents have reported status yet." — an inactive
      // session shown as a clean bill of health.
      //
      // This is newly reachable: until the account gate came off this hook, the
      // query was never issued for a local account. It now polls every 45s for
      // every account, including across sign-out and a profile switch, so the
      // window exists where it did not before. `statusScope()` is in here too —
      // it reads the session, and a session that is not activated has no reason
      // to answer that question either.
      userActivation.requireActivated()
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
      try {
        // Same shape, same fix, same reason as `agent-status:list` above — the
        // guard was outside the try here too. Reached by every per-card Refresh
        // and by "Refresh all"'s fan-out.
        userActivation.requireActivated()
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
