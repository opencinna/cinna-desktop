import { setLogValueRedactor } from '../logger/logger'
import { redactCredentialValues } from '../security/serviceCredentialRedaction'
import { installCredentialReadiness } from '../services/localAgents/scannerService'
import { installCommandCredentialPreparation } from '../services/localAgents/commandService'
/** Shared runtime composition. Desktop calls this in process; the Phase 0
 * Node spike exercises the same boot without importing any desktop transport.
 */
import { serviceCredentialService } from '../services/serviceCredentials/service'
import { stopPeriodicSync } from '../agents/remote-sync'
import { stopAccountConfigPeriodicSync } from '../services/account-config-sync'
import { initDatabase } from '../db/client'
import { getCurrentUserId, initSession } from '../auth/session'
import { userActivation } from '../auth/activation'
import { getSettingsScopeUserId } from '../auth/scope'
import { taskRuntimeService } from '../services/taskRuntimeService'
import { interruptedTurnService } from '../services/interruptedTurnService'
import { registerRecoverer, remoteTurnRecoveryService } from '../services/remoteTurnRecoveryService'
import { a2aTurnRecoverer, managedTurnRecoverer, acpProcessPool, shutdownEngineLogins } from '../agents/drivers'
import { localAgentService } from '../services/localAgents/localAgentService'
import { a2aStreamingService } from '../services/a2aStreamingService'
import { localScheduleScheduler } from '../services/localScheduleScheduler'
import { handoverScheduler } from '../services/handoverScheduler'
import { taskSyncScheduler } from '../services/taskSyncScheduler'
import { toolInstallService } from '../services/localAgents/toolInstallService'
import { watcherService } from '../services/localAgents/watcherService'
import { conductorBridge } from '../services/conductorBridge'
import { mcpManager } from '../mcp/manager'
import { installAgentReadiness } from './agentReadiness'

export function initializeHubCore(openDatabase?: Parameters<typeof initDatabase>[0]): void {
  setLogValueRedactor(redactCredentialValues)
  initDatabase(openDatabase)
  initSession()
  installCommandCredentialPreparation(id => serviceCredentialService.prepare(id))
  serviceCredentialService.installUnlockCheck((userId) => userActivation.isUnlocked(userId))
  taskRuntimeService.recover()
  registerRecoverer('a2a', a2aTurnRecoverer)
  registerRecoverer('managed', managedTurnRecoverer)
  interruptedTurnService.finalizeLeftovers()
  userActivation.onProfileReady((userId) => { void remoteTurnRecoveryService.resume(userId) })
  remoteTurnRecoveryService.onRetryDue((userId) => {
    if (userActivation.isActivated() && getCurrentUserId() === userId) void remoteTurnRecoveryService.resume(userId)
  })
  localAgentService.configure(getSettingsScopeUserId)
  installCredentialReadiness(path => serviceCredentialService.metadataForPath(path))
  installAgentReadiness()
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
  serviceCredentialService.retire()
  stopPeriodicSync()
  stopAccountConfigPeriodicSync()
  a2aStreamingService.saveInFlight()
  localScheduleScheduler.stop()
  handoverScheduler.stop()
  taskRuntimeService.interruptAll(reason)
  taskSyncScheduler.stop()
  const processes = acpProcessPool.shutdown()
  const conductor = conductorBridge.shutdown()
  // A login waiting on a browser sign-in holds a loopback port; it ends with the app.
  const logins = shutdownEngineLogins()
  toolInstallService.shutdown()
  watcherService.stopAll()
  await Promise.all([processes, conductor, logins, mcpManager.disconnectAll()])
}
