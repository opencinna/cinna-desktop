/**
 * Stop for the ACP activity provider: one background task, by the AIR
 * extension's `_session/async_task/stop` ({@link ACP_ASYNC_TASK_STOP_METHOD}).
 *
 * Both engines send the task's `stopped` state update before they answer, so
 * the hub has usually moved the item already when the answer lands. Claude
 * also writes a synthetic root text chunk with no `messageId`, and Codex fails
 * the exec tool call of the turn that started it; the follow-up gate drops
 * both (`phase0_findings.md` C4).
 */

import type { SessionActivityItem } from '../../../../shared/sessionActivity'
import { createLogger } from '../../../logger/logger'
import type { SessionActivityStopOutcome, SessionActivityStopper } from '../../../services/sessionActivityStop'
import type { AsyncTaskTarget, SessionActivityRegistry } from './acpActivity'

const logger = createLogger('acp-activity-stop')

/** How long a stop may wait for the agent's answer. */
export const ACP_ASYNC_TASK_STOP_TIMEOUT_MS = 5_000

/** Send the stop and read the answer. Never throws. */
export async function stopAcpAsyncTask(
  target: AsyncTaskTarget,
  timeoutMs: number = ACP_ASYNC_TASK_STOP_TIMEOUT_MS
): Promise<SessionActivityStopOutcome> {
  const { connection, sessionId, asyncTaskId } = target
  if (!connection.alive) return 'unavailable'
  let timer: ReturnType<typeof setTimeout> | undefined
  const timedOut = new Promise<'timeout'>((resolve) => {
    timer = setTimeout(() => resolve('timeout'), timeoutMs)
  })
  const ended = connection.exited.then(() => 'exited' as const)
  try {
    const answer = await Promise.race([connection.stopAsyncTask({ sessionId, asyncTaskId }), timedOut, ended])
    if (answer === 'timeout' || answer === 'exited') {
      logger.warn('a background task stop got no answer', { sessionId, asyncTaskId, reason: answer })
      return 'unavailable'
    }
    return answer?.stopped === true ? 'stopped' : 'already_ended'
  } catch (err) {
    logger.warn('a background task stop was refused', { sessionId, asyncTaskId, error: err instanceof Error ? err.message : String(err) })
    return 'unavailable'
  } finally {
    clearTimeout(timer)
  }
}

/** The ACP driver's stopper: background items of the sessions its registry holds. */
export function createAcpActivityStopper(
  registry: SessionActivityRegistry,
  timeoutMs: number = ACP_ASYNC_TASK_STOP_TIMEOUT_MS
): SessionActivityStopper {
  return {
    async stop(chatId: string, item: SessionActivityItem): Promise<SessionActivityStopOutcome | null> {
      if (item.kind !== 'background') return null
      const target = registry.asyncTask(chatId, item.agentId, item.id)
      if (!target) return null
      return stopAcpAsyncTask(target, timeoutMs)
    }
  }
}
