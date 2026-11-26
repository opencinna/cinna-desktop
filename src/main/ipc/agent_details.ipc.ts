import { userActivation } from '../auth/activation'
import { getProfileScopeUserId } from '../auth/scope'
import { agentDetailsService } from '../services/agentDetails/agentDetails'
import { agentDetailsFrameServer } from '../host/desktop/htmlPreview'
import type { AgentDetailsFrameResult, AgentDetailsResult } from '../../shared/agentDetails'
import { ipcHandle } from './_wrap'

/**
 * Agent Details. Thin controllers over the core service: `get` returns the
 * renderer's view (never the HTML), `open-frame` registers the publisher's
 * HTML with the `det-` frame server for the profile that asked, and
 * `release-frame` forgets the token. Targets are checked by the service;
 * failures are returned as data.
 */
export function registerAgentDetailsHandlers(): void {
  ipcHandle('agent-details:get', async (_event, target: unknown): Promise<AgentDetailsResult> => {
    userActivation.requireActivated()
    return agentDetailsService.get(target, { profileId: getProfileScopeUserId() })
  })

  ipcHandle('agent-details:open-frame', async (_event, target: unknown): Promise<AgentDetailsFrameResult> => {
    userActivation.requireActivated()
    // Read once: a profile switch during the call must not bind this page to the next profile.
    const profileUserId = getProfileScopeUserId()
    const html = await agentDetailsService.htmlFor(target, profileUserId)
    if (!html.ok) return html
    const { token, url } = agentDetailsFrameServer.register(html.html, profileUserId)
    return { ok: true, token, url }
  })

  ipcHandle('agent-details:release-frame', (_event, token: unknown): { success: true } => {
    agentDetailsFrameServer.release(token)
    return { success: true }
  })
}
