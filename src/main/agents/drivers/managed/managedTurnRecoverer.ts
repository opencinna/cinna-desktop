/**
 * Relaunch recovery for the `managed` driver: follow the Claude Managed
 * session a turn the app was closed under was sent to, from the acknowledged
 * id of its `user.message`, until the turn ends.
 *
 * - No user row, no agent, an unreadable configuration, a chat or agent that
 *   changed → interrupted.
 * - A credential that needs the user → deferred (`auth`), marker kept.
 * - No session, a checkpoint that is not `inflight`, no stored kickoff id
 *   (killed before the send was acknowledged), or a kickoff stored for
 *   another user row (an earlier turn's, left by one settled without a
 *   follow) → interrupted. The message is never sent again: whether it reached
 *   the session is unknown, and a second copy would be a second turn.
 * - A session that cannot be reached within {@link PROBE_TIMEOUT_MS}, or
 *   that refuses the credential → deferred (`network` / `auth`), marker kept.
 * - Otherwise → followed as a live turn: deltas stream to the chat, a parked
 *   permission is offered again and answered through the registry, Stop
 *   interrupts the session. A turn that ended while the app was closed
 *   returns at once, from history; one still working shows the live-only
 *   still-running notice once history is read. A follow that loses the session mid-way
 *   is deferred the same way, the session left running and the checkpoint
 *   untouched. Any other failure, once the turn's kickoff has been read,
 *   interrupts the session as a live turn's does; before that, nothing is
 *   interrupted and the checkpoint is left `uncertain`.
 *
 * Nothing here sends a message. Takes the binding resolution by injection, as
 * the driver does: the production functions name Electron.
 */
import type { AgentRow } from '../../../db/agents'
import type { RecoveredRow } from '../../../db/inflightTurns'
import { STILL_RUNNING_NOTICE, type RecoveryResult, type TurnRecoverer } from '../../../services/turnRecoverers'
import type { TurnOutcome } from '../../../services/turnCompletion'
import type { MessagePart } from '../../../../shared/messageParts'
import { parseManagedAgentConfig } from '../../../../shared/managedAgents'
import { createLogger } from '../../../logger/logger'
import {
  followManagedSession,
  unreachableReason,
  type ManagedFollowTarget,
  type ManagedRunBinding,
  type ManagedRunDeps,
  type ManagedRunResult
} from './managedRun'

const logger = createLogger('managed-recovery')

/** How long the plan's reachability probe of the session may take. */
export const PROBE_TIMEOUT_MS = 30_000

export interface ManagedRecovererDeps extends ManagedRunDeps {
  /** `agentService.findAgent`. */
  findAgent(settingsUserId: string, profileUserId: string, agentId: string): { row: AgentRow; userId: string } | null
  /** `managedAgentService.readiness` — throws when the credential needs the user. */
  readiness(agent: AgentRow): void
  /** `managedAgentService.prepare` — the binding a live turn of this chat would use. */
  prepare(ownerId: string, agent: AgentRow, chatId: string): ManagedRunBinding
  /** Bound on the plan's session probe; {@link PROBE_TIMEOUT_MS} when omitted. */
  probeTimeoutMs?: number
}

const errorText = (err: unknown): string => (err instanceof Error ? err.message : String(err))

/** The same text a live turn's assistant row gets. */
function contentOf(result: ManagedRunResult): string {
  if (result.text) return result.text
  const parts: MessagePart[] = result.parts
  const answer = parts.filter((part) => part.kind === 'text').map((part) => part.text).join('')
  return answer || parts.map((part) => part.text).join('')
}

/**
 * The target a checkpoint lets recovery follow for the turn answering
 * `userMessageId`, or why it does not. A kickoff is stored only with
 * `inflight` (see `managedAgentSessionRepo.save`), so no other state has one.
 */
function targetOf(binding: ManagedRunBinding, userMessageId: string): ManagedFollowTarget | string {
  const checkpoint = binding.checkpoint
  if (!checkpoint) return 'the turn never opened a session'
  if (checkpoint.state !== 'inflight') return 'the turn never reached the send'
  if (!checkpoint.kickoffEventId) return 'the send was never acknowledged'
  if (checkpoint.kickoffMessageId !== userMessageId) return 'the saved kickoff belongs to another turn'
  return { sessionId: checkpoint.sessionId, kickoffEventId: checkpoint.kickoffEventId }
}

/**
 * A followed turn's ending, as the live wrapper would save it: notices, the
 * assistant row, then the error under it. A stop or a failure that followed
 * nothing keeps what the quit flush saved.
 */
function resultOf(result: ManagedRunResult, aborted: boolean): RecoveryResult {
  const canceled = aborted || result.taskState === 'canceled' || result.stopReason === 'canceled'
  if (!canceled && result.unreachable) {
    logger.warn('a Managed turn could not be followed for now', { reason: result.unreachable, error: result.error?.message })
    return { kind: 'defer', reason: result.unreachable }
  }
  const rows: RecoveredRow[] = result.notices.map((notice) => ({ role: 'agent_transition', content: notice.text }))
  if (result.parts.length) rows.push({ role: 'assistant', content: contentOf(result), parts: result.parts })
  if (canceled) {
    const outcome: TurnOutcome = { state: 'canceled', text: result.text }
    return rows.length ? { kind: 'collected', outcome, rows } : { kind: 'kept', outcome }
  }
  if (result.error) {
    if (!result.parts.length) {
      logger.warn('a Managed turn could not be followed', { error: result.error.message })
      return { kind: 'interrupted' }
    }
    rows.push({ role: 'error', short: result.error.message, detail: result.error.raw })
    return { kind: 'collected', outcome: { state: 'failed', text: result.text, error: { message: result.error.message } }, rows }
  }
  const state: TurnOutcome['state'] = result.stopReason === 'budget' ? 'budget' : 'completed'
  return { kind: 'collected', outcome: { state, text: result.text }, rows }
}

export function createManagedTurnRecoverer(deps: ManagedRecovererDeps): TurnRecoverer {
  return {
    async plan(marker, scope) {
      if (!marker.userMessageId) return { kind: 'interrupted', reason: 'the turn has no user message' }
      const located = deps.findAgent(scope.settingsUserId, marker.profileId, marker.agentId)
      if (!located || located.row.driver !== 'managed') return { kind: 'interrupted', reason: 'the agent is gone' }
      const { row: agent, userId: ownerId } = located
      try {
        parseManagedAgentConfig(agent.driverConfig)
      } catch (err) {
        return { kind: 'interrupted', reason: `the agent’s configuration is unreadable: ${errorText(err)}` }
      }
      try {
        deps.readiness(agent)
      } catch (err) {
        logger.info('a Managed turn waits for its credential', { error: errorText(err) })
        return { kind: 'defer', reason: 'auth' }
      }
      let binding: ManagedRunBinding
      try {
        binding = deps.prepare(ownerId, agent, marker.chatId)
      } catch (err) {
        return { kind: 'interrupted', reason: `the Managed session cannot be used: ${errorText(err)}` }
      }
      const userMessageId = marker.userMessageId
      const target = targetOf(binding, userMessageId)
      if (typeof target === 'string') return { kind: 'interrupted', reason: target }

      // Probe the session before showing the turn as running: one that cannot
      // be reached now is tried again later, not settled.
      try {
        const { config } = binding
        await binding.client.beta.sessions.retrieve(target.sessionId,
          config.workspaceId ? { workspace_id: config.workspaceId } : {},
          { timeout: deps.probeTimeoutMs ?? PROBE_TIMEOUT_MS, maxRetries: 0 })
      } catch (err) {
        const reason = unreachableReason(err)
        if (reason) {
          logger.warn('a Managed session cannot be reached for now', { reason, error: errorText(err) })
          return { kind: 'defer', reason }
        }
        return { kind: 'interrupted', reason: `the Managed session cannot be read: ${errorText(err)}` }
      }

      return {
        kind: 'recover',
        // The follow streams the turn again from its kickoff.
        replaysLive: true,
        async recover(io) {
          // A message sent since the plan was made moved the checkpoint on,
          // and the session's turn is no longer this one.
          const current = deps.prepare(ownerId, agent, marker.chatId)
          const now = targetOf(current, userMessageId)
          if (typeof now === 'string' || now.sessionId !== target.sessionId || now.kickoffEventId !== target.kickoffEventId) {
            return { kind: 'interrupted' }
          }
          const result = await followManagedSession(current, agent.id, {
            chatId: marker.chatId,
            signal: io.signal,
            onEvent: (event) => io.event(event)
          }, deps, target, {
            // Live-only, as A2A recovery shows it; a turn that already ended returns without it.
            onStillRunning: () => io.notice(STILL_RUNNING_NOTICE)
          })
          return resultOf(result, io.signal.aborted)
        }
      }
    }
  }
}
