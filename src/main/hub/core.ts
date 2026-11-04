import { createLogger, setLogValueRedactor } from '../logger/logger'
import { redactCredentialValues } from '../security/serviceCredentialRedaction'
import { installCredentialReadiness } from '../services/localAgents/scannerService'
import { installCommandCredentialPreparation } from '../services/localAgents/commandService'
/** Shared runtime composition. Desktop calls this in process; the Phase 0
 * Node spike exercises the same boot without importing any desktop transport.
 */
import { serviceCredentialService } from '../services/serviceCredentials/service'
import { stopPeriodicSync } from '../agents/remote-sync'
import { libraryService } from '../services/libraryService'
import { stopAccountConfigPeriodicSync } from '../services/account-config-sync'
import { initDatabase } from '../db/client'
import { getCurrentUserId, initSession } from '../auth/session'
import { userActivation } from '../auth/activation'
import { getProfileScopeUserId, getSettingsScopeUserId } from '../auth/scope'
import { taskRuntimeService } from '../services/taskRuntimeService'
import { interruptedTurnService } from '../services/interruptedTurnService'
import { registerRecoverer, remoteTurnRecoveryService } from '../services/remoteTurnRecoveryService'
import { a2aTurnRecoverer, managedTurnRecoverer, acpProcessPool, shutdownEngineLogins, agentCommandWorkspace, installClaudeAuthFollow } from '../agents/drivers'
import { installUserCommandWorkspace, userCommandService } from '../services/userCommands'
import { installFolderMovedListener, localAgentService } from '../services/localAgents/localAgentService'
import { catalogSkillService } from '../services/catalogSkillService'
import { marketplaceSkillService } from '../services/marketplaceSkillService'
import { marketplacePluginService } from '../services/marketplacePluginService'
import { pinnedSkillAutoFetch } from '../services/pinnedSkillAutoFetch'
import { a2aStreamingService } from '../services/a2aStreamingService'
import { localScheduleScheduler } from '../services/localScheduleScheduler'
import { handoverScheduler } from '../services/handoverScheduler'
import { taskSyncScheduler } from '../services/taskSyncScheduler'
import { taskDispatchService } from '../services/taskDispatchService'
import { toolInstallService } from '../services/localAgents/toolInstallService'
import { watcherService } from '../services/localAgents/watcherService'
import { conductorBridge } from '../services/conductorBridge'
import { artifactService } from '../services/artifacts/artifactService'
import { dashboardRefreshService } from '../services/dashboards/dashboardRefreshService'
import { capabilityService } from '../services/capabilityService'
import { onRunClosed } from '../services/runExecutionState'
import { onScheduleRunCompleted } from '../services/localScheduleEvents'
import { mcpManager } from '../mcp/manager'
import { installAgentReadiness } from './agentReadiness'
import { chatModeService } from '../services/chatModeService'
import { shutdownOpencodeBootstraps } from '../agents/drivers/acp/acpLaunchers'
import { installCloudUpdateFollow } from '../agents/cloudUpdateFollow'
import { installAddonPolicyFollow } from '../services/addonDirectory/policyFollow'
import { installScaffoldPrewarm } from '../services/localAgents/scaffoldService'
import { prewarm, prewarmState, uvPrewarm } from '../services/localAgents/uvPrewarm'
import { agentsHomeService } from '../services/localAgents/agentsHomeService'
import { agentRepo } from '../db/agents'

/**
 * Whether this computer has local agents to pre-warm uv and Python for: an
 * agents folder is registered and holds at least one folder agent. Read-only;
 * creates nothing.
 */
function hasLocalAgents(userId: string): boolean {
  if (agentsHomeService.rootPaths(userId).length === 0) return false
  return agentRepo.listFolder(userId).length > 0
}

export function initializeHubCore(openDatabase?: Parameters<typeof initDatabase>[0]): void {
  setLogValueRedactor(redactCredentialValues)
  initDatabase(openDatabase)
  initSession()
  // Notes and Dashboards nobody has turned on or off yet: decided once, from
  // whether any profile holds a note or a dashboard, before the first window
  // reads its settings and before the dashboard warm-up asks. A failure stays
  // undecided (off) and the next read retries.
  capabilityService.resolveUnset()
  // Every runtime is a chat mode (Claude Code, Codex, Antigravity, OpenCode).
  // Chat modes live in the Default scope; `chatmode:list` makes them too.
  try {
    chatModeService.ensureRuntimeModes(getSettingsScopeUserId())
  } catch (err) {
    createLogger('chatmode').warn('could not create the runtime modes at startup', { error: err instanceof Error ? err.message : String(err) })
  }
  installCommandCredentialPreparation(id => serviceCredentialService.prepare(id))
  serviceCredentialService.installUnlockCheck((userId) => userActivation.isUnlocked(userId))
  taskRuntimeService.recover()
  registerRecoverer('a2a', a2aTurnRecoverer)
  registerRecoverer('managed', managedTurnRecoverer)
  interruptedTurnService.finalizeLeftovers()
  // A dispatched run Cinna quit under: flag its task and pause its queue,
  // before any profile activates and the dispatcher starts waking.
  taskDispatchService.recoverInterrupted()
  userActivation.onProfileReady((userId) => { void remoteTurnRecoveryService.resume(userId) })
  // Whether this profile's instance keeps artifacts, read now rather than when
  // a window first asks: an agent's session offers `artifacts_publish` from it.
  userActivation.onProfileReady(() => { void artifactService.support() })
  // Leaving a profile stops its dashboards' runs and forgets which tiles were on screen.
  userActivation.onProfileClosing(() => { void dashboardRefreshService.cancelAll() })
  // A turn of an agent ended: its on-screen tiles that ask for it re-run (README D3).
  onRunClosed((_chatId, agentId) => {
    if (agentId && userActivation.isActivated()) dashboardRefreshService.afterTurn(getProfileScopeUserId(), agentId)
  })
  // A schedule's run completed: the active profile's tiles it feeds re-read what it wrote (README D4).
  onScheduleRunCompleted(({ userId, agentId, name }) => {
    if (userActivation.isActivated() && getProfileScopeUserId() === userId) dashboardRefreshService.scheduleRan(userId, agentId, name)
  })
  remoteTurnRecoveryService.onRetryDue((userId) => {
    if (userActivation.isActivated() && getCurrentUserId() === userId) void remoteTurnRecoveryService.resume(userId)
  })
  localAgentService.configure(getSettingsScopeUserId)
  // A kit agent's folder moved: its warm process may sit in the old path, and the
  // Claude spec key does not include the cwd. `retire` lets a running turn finish.
  installFolderMovedListener((agentId) => acpProcessPool.retire(agentId))
  // Claude's auth mode, credential or key changed: idle Claude processes on the old one stop.
  installClaudeAuthFollow()
  installCredentialReadiness(path => serviceCredentialService.metadataForPath(path))
  installAgentReadiness()
  // A message's Run resolves the agent's folder where a turn's folder view is built.
  installUserCommandWorkspace(agentCommandWorkspace)
  // Commands run from messages died with the last app; so do their logs.
  userCommandService.sweep()
  // A listing that names a newer version of an installed cloud agent syncs the remote agents once.
  installCloudUpdateFollow()
  // The admin turned local servers off: a directory's and a plugin's running ones stop (never deleted).
  installAddonPolicyFollow()
  // Cached catalog revisions and marketplace snapshots no agent pins: once per start, off the boot
  // path but in one synchronous run before any profile can activate, so no turn or schedule holds a path into it.
  // Pinned skills not on this computer are fetched in the background once a profile is ready (no
  // profile is active yet at this point, and nothing is tried without a Cinna account), and again on
  // renewed credentials: the tried set is forgotten and pins whose download failed are retried too,
  // since a lapsed sign-in is what a renewed session fixes. A turn fetches a missing pin only once.
  setImmediate(() => {
    catalogSkillService.collectGarbage()
    marketplaceSkillService.collectGarbage()
    marketplacePluginService.collectGarbage()
  })
  userActivation.onProfileReady(() => { pinnedSkillAutoFetch.retryAllMissing() })
  // The managed uv and the template's Python, so a kit agent's first `uv run` does not wait on a
  // download: when an agent is scaffolded, and once a profile with local agents is ready (off the
  // boot path; skipped silently with no agents folder or no agents in it, and once Python is in).
  installScaffoldPrewarm((agentDir) => { void prewarm(agentDir) })
  userActivation.onProfileReady(() => {
    setImmediate(() => {
      try {
        if (prewarmState().python !== 'ready' && hasLocalAgents(getSettingsScopeUserId())) void prewarm()
      } catch (err) {
        createLogger('uv-prewarm').warn('could not check for local agents to pre-warm', { error: err instanceof Error ? err.message : String(err) })
      }
      // Tiles whose component says `on_app_start`, one at a time, off the boot path
      // (README D4); a profile close or quit cancels it. `CINNA_DASHBOARD_WARMUP=off` skips it.
      if (userActivation.isActivated()) void dashboardRefreshService.warmUp(getProfileScopeUserId()).catch(() => {})
    })
  })
}

export { runExecutionService } from '../services/runExecutionService'
export { liveRunHub } from '../services/liveRunHub'
export { inboxService } from '../services/inboxService'
export { taskRuntimeService, userActivation }

/** Persist partial turns and signal every owned process before the first await.
 * Electron does not await will-quit; Node hosts may await process exit before
 * closing their database. Detaching a viewer must never call this function.
 */
export async function shutdownHubCore(reason = 'Execution stopped when the app closed. Review the conversation before resuming.'): Promise<void> {
  // First: a dispatched turn ending under the shutdown must not be settled
  // as a Stop; its in-flight row is the next boot's to flag.
  taskDispatchService.shutdown()
  serviceCredentialService.retire()
  stopPeriodicSync()
  stopAccountConfigPeriodicSync()
  libraryService.stop()
  a2aStreamingService.saveInFlight()
  localScheduleScheduler.stop()
  handoverScheduler.stop()
  taskRuntimeService.interruptAll(reason)
  taskSyncScheduler.stop()
  const processes = acpProcessPool.shutdown()
  // Commands the user ran from messages: every group is signalled now, killed after a grace.
  const userCommands = userCommandService.shutdown()
  const conductor = conductorBridge.shutdown()
  // Dashboard endpoints and refresh commands run in their own process groups: killed now.
  const dashboards = dashboardRefreshService.cancelAll()
  // The credential token endpoint's loopback listener ends with the app, its bearers with it.
  const credentialTokens = serviceCredentialService.closeTokenServer()
  // A login waiting on a browser sign-in holds a loopback port; it ends with the app.
  const logins = shutdownEngineLogins()
  // Cinna's OpenCode database is created by an engine outside the pool; it ends with the app too.
  const bootstraps = shutdownOpencodeBootstraps()
  toolInstallService.shutdown()
  // A `uv python install` the pre-warm started dies with the app.
  uvPrewarm.shutdown()
  watcherService.stopAll()
  await Promise.all([processes, userCommands, conductor, dashboards, credentialTokens, logins, bootstraps, mcpManager.disconnectAll()])
}
