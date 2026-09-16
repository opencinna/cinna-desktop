import { createAcpProcessPool, type AcpProcessPoolDeps } from './acpProcessPool'
import { startAcpConnection } from './acpConnection'
import { sessionActivityHub, type SessionActivityHub } from '../../../services/sessionActivityHub'
import type { AcpProcessPool } from './types'

/**
 * What the reaper reads from session activity: an agent with running work is
 * not idle, and the busy ceiling counts from that work's last change.
 */
export function activityReapDeps(
  hub: Pick<SessionActivityHub, 'hasRunning' | 'lastChangeAt'>
): Pick<AcpProcessPoolDeps, 'isBusy' | 'lastActivityAt'> {
  return {
    isBusy: (agentId) => hub.hasRunning({ agentId }),
    lastActivityAt: (agentId) => hub.lastChangeAt(agentId)?.getTime()
  }
}

/**
 * A process that is gone (exited, retired, reaped, shut down) took its work
 * with it: whatever the hub still shows running for that agent is `lost`.
 * Returns the unsubscribe.
 */
export function wirePoolToActivity(
  pool: Pick<AcpProcessPool, 'onStatus'>,
  hub: Pick<SessionActivityHub, 'endAll'>
): () => void {
  return pool.onStatus((agentId, state) => {
    if (state.state === 'stopped' || state.state === 'exited') hub.endAll({ agentId }, 'lost')
  })
}

/** Shared by runtime dispatch and command configuration lifecycle operations. */
export const acpProcessPool = createAcpProcessPool({
  start: startAcpConnection,
  ...activityReapDeps(sessionActivityHub)
})
wirePoolToActivity(acpProcessPool, sessionActivityHub)
