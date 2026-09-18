import { userActivation } from '../auth/activation'
import { toolDetectionService } from '../services/localAgents/toolDetectionService'
import { claudeAuthProbe, codexAuthProbe } from '../agents/drivers'
import { openInService } from '../services/localAgents/openInService'
import { toolInstallService } from '../services/localAgents/toolInstallService'
import { defaultEngineService } from '../services/localAgents/defaultEngineService'
import { localAgentService } from '../services/localAgents/localAgentService'
import { getSettingsScopeUserId } from '../auth/scope'
import { createLogger } from '../logger/logger'
import { getMainWindow } from '../index'
import { DEFAULT_AGENT_ENGINE } from '../../shared/engine'
import { ipcHandle } from './_wrap'
import {
  TOOL_INSTALL_CHANNEL,
  type DetectedTool,
  type OpenInRequest,
  type ToolInstallPlan,
  type ToolInstallProgress
} from '../../shared/localTools'
import type { ClaudeAuthStatus } from '../../shared/engine'

const logger = createLogger('local-tools-ipc')

/**
 * Detection of the user's installed developer tools, and the "Open in…"
 * launchers for a local agent folder. Thin controllers — validation of the
 * folder path and of the tool id lives in `openInService`.
 */
export function registerLocalToolsHandlers(): void {
  // One subscription for the app's lifetime, forwarding an installer's progress
  // to whatever window is open — the same shape `engine.ipc` uses for the
  // binary's state, and for the same reason: the service keeps no Electron
  // dependency of its own.
  toolInstallService.onProgress((progress) => {
    getMainWindow()?.webContents.send(TOOL_INSTALL_CHANNEL, progress)
  })

  /**
   * **Detection starts at launch, and its first answer decides this machine's
   * Default runtime — once.**
   *
   * Two things hang on this pass. `defaultEngineService.current()` is read
   * *synchronously* — from the scanner, the DTO mapper and the engine's config
   * assembly — so before it there is no honest answer but "no `claude`". And
   * the lock itself: the first launch that can answer picks the runtime and
   * stores it, and every launch after this is a no-op.
   *
   * The re-index is the other half of the write. `driver_config.launcher`
   * caches the resolved engine per agent row, and `capabilitiesFor` answers
   * from that cache — so a lock that landed after the first scan would leave
   * every agent described as running on the engine it was indexed with.
   * `settings:set` does the same thing when the user changes the picker; this
   * is that path for the one write the user did not make.
   *
   * Fire-and-forget, and every failure is swallowed inside: nothing here may
   * fail the registration of an IPC handler, and a lock that did not happen is
   * retried on the next launch.
   */
  void defaultEngineService
    .lockIfUnset()
    .then((locked) => {
      // Only when a *different* engine was chosen than the rows were built
      // with. Locking the OpenCode runner changes nothing — it is what every
      // unanswered read already returned — so the common case costs no walk.
      if (locked === null || locked === DEFAULT_AGENT_ENGINE) return
      localAgentService.rescan(getSettingsScopeUserId())
    })
    .catch((err: unknown) => {
      logger.warn('could not settle the default runtime at startup', {
        error: err instanceof Error ? err.message : String(err)
      })
    })

  ipcHandle('local-tools:list', (): Promise<DetectedTool[]> => {
    userActivation.requireActivated()
    return toolDetectionService.list()
  })

  ipcHandle('local-tools:refresh', async (): Promise<DetectedTool[]> => {
    userActivation.requireActivated()
    const tools = await toolDetectionService.refresh()
    // **After the await, and the order is the whole point.** The login probe
    // resolves its binary through the engine binary service, whose exact-version
    // PATH reuse rests on the same detection this line refreshes. Started first, it would
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
    void codexAuthProbe.refresh().catch(() => {})
    return tools
  })

  // Codex exposes a login verdict without returning account or credential data.
  ipcHandle('local-tools:codex-auth', () => {
    userActivation.requireActivated()
    return codexAuthProbe.status()
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

  /**
   * What this machine would run to install each runtime.
   *
   * The command crosses the bridge because the confirm dialog shows it — the
   * user agrees to a specific command, not to the word *Install*. It crosses as
   * **text**: `local-tools:install` takes an id and looks the command up again
   * on this side, so nothing the renderer sends is ever executed.
   */
  ipcHandle('local-tools:install-plans', (): ToolInstallPlan[] => {
    userActivation.requireActivated()
    return toolInstallService.plans()
  })

  /**
   * Run one vendor's installer.
   *
   * Resolves with the outcome, failure included, rather than rejecting: the
   * dialog renders it beside the button that was pressed, and a rejection would
   * lose the sentence crossing the bridge — the same rule `engine:resolve`
   * follows.
   */
  ipcHandle('local-tools:install', (_event, toolId: unknown): Promise<ToolInstallProgress> => {
    userActivation.requireActivated()
    return toolInstallService.install(toolId)
  })

  ipcHandle('local-tools:open-in', async (_event, data: OpenInRequest) => {
    userActivation.requireActivated()
    await openInService.openIn(data)
    return { success: true as const }
  })
}
