import { userActivation } from '../auth/activation'
import { getProfileScopeUserId } from '../auth/scope'
import { activeAgentSessions } from '../services/activeAgentSessions'
import { ipcHandle } from './_wrap'
import type { AgentActiveSessionsResult } from '../../shared/agentSessions'

/**
 * `agentSessions:*` — which agents are already running a session, for the
 * warning a surface shows before it starts one more. An adapter: the profile
 * is resolved here, the answer is `activeAgentSessions`'s, and "not yet" comes
 * back as data rather than a thrown error.
 */
export function registerAgentSessionHandlers(): void {
  ipcHandle('agentSessions:active', async (): Promise<AgentActiveSessionsResult> => {
    if (!userActivation.isActivated()) {
      return { ok: false, code: 'not_activated', message: 'Sign in to see which agents are running.' }
    }
    return { ok: true, sessions: activeAgentSessions(getProfileScopeUserId()) }
  })
}
