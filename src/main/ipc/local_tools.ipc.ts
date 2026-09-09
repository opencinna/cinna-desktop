import { userActivation } from '../auth/activation'
import { toolDetectionService } from '../services/localAgents/toolDetectionService'
import { claudeAuthProbe } from '../services/agentTurn'
import { openInService } from '../services/localAgents/openInService'
import { ipcHandle } from './_wrap'
import type { DetectedTool, OpenInRequest } from '../../shared/localTools'
import type { ClaudeAuthStatus } from '../../shared/engine'

/**
 * Detection of the user's installed developer tools, and the "Open in…"
 * launchers for a local agent folder. Thin controllers — validation of the
 * folder path and of the tool id lives in `openInService`.
 */
export function registerLocalToolsHandlers(): void {
  ipcHandle('local-tools:list', (): Promise<DetectedTool[]> => {
    userActivation.requireActivated()
    return toolDetectionService.list()
  })

  ipcHandle('local-tools:refresh', async (): Promise<DetectedTool[]> => {
    userActivation.requireActivated()
    const tools = await toolDetectionService.refresh()
    // **After the await, and the order is the whole point.** The login probe
    // resolves its path through `toolDetectionService.get`, which reads the
    // memoized `detection` promise *synchronously*. Started first, it would
    // therefore answer from the cache this line is about to throw away — so a
    // user who had just installed Claude Code and pressed this button would get
    // fresh detection beside a login answer of `unknown`, held for the probe's
    // full window, on precisely the machine the button exists for.
    //
    // Fire-and-forget: a refused refresh of the login must not fail the
    // detection the button is actually named after. The renderer invalidates
    // its own copy, and that refetch joins this probe rather than starting a
    // second one.
    void claudeAuthProbe.refresh().catch(() => {})
    return tools
  })

  /**
   * Whether the user's own `claude` is logged in — the sibling fact to
   * detection, and answered the same way: by asking the machine, not by
   * guessing. Free (`claude auth status` runs no turn and bills nothing) and
   * cached behind a short window in the main process, so the panel may ask on
   * every mount.
   *
   * **What comes back carries the account and not the organisation.** The CLI's
   * answer holds the user's email, organisation id and organisation name;
   * `claudeAuth.ts` reads the first — it is the answer to *which login pays for
   * this turn*, which the panel asks — and never the other two, so nothing here
   * has to remember not to forward them.
   */
  ipcHandle('local-tools:claude-auth', (): Promise<ClaudeAuthStatus> => {
    userActivation.requireActivated()
    return claudeAuthProbe.status()
  })

  ipcHandle('local-tools:open-in', async (_event, data: OpenInRequest) => {
    userActivation.requireActivated()
    await openInService.openIn(data)
    return { success: true as const }
  })
}
