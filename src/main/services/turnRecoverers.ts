/**
 * The per-driver half of relaunch recovery: what a driver registers so
 * `remoteTurnRecoveryService` can recover its turns, and the registry itself.
 * Kept apart from the service so the boot pass can ask "is this recoverable?"
 * without importing the service (which imports the boot pass).
 */
import type { InflightTurnRow, RecoveredRow, TurnEndNotice } from '../db/inflightTurns'
import type { RunScope } from './runExecutionService'
import type { TurnOutcome } from './turnCompletion'
import type { InputRequest, RunEvent } from '../../shared/runEvents'
import type { OutputSize } from '../agents/outputSize'

/** The live-only line a recovered turn shows while its agent is still working. */
export const STILL_RUNNING_NOTICE = 'Still running on the agent. The reply will appear here when it finishes.'
/** The error row under a turn the agent reports was cut off by an error or a crash. */
export const CUT_OFF_NOTICE = 'The agent’s reply was cut off before it finished. Send your message again to retry.'
/** Its code. */
export const REPLY_CUT_OFF_CODE = 'reply_cut_off'
/** The error row under a turn the agent reports failed. */
export const TASK_FAILED_MESSAGE = 'The agent reported that its task failed. Send your message again to retry.'

/** What a recoverer's `recover` can use while the turn shows as running. */
export interface RecoveryIO {
  /** Aborted when the user presses Stop. */
  signal: AbortSignal
  /** A live-only notice line. Never saved. */
  notice(text: string): void
  /**
   * A live event of a turn the recoverer follows as it runs (Managed): a
   * delta, a status, a permission ask opening or settling. Handled as a live
   * turn's are — an ask is recorded before it is shown, so the user can answer
   * it — and nothing is saved. Terminal events are ignored: the service ends
   * the run once `recover` resolves.
   */
  event(event: RunEvent): void
  /**
   * Send the turn's user message again (it never reached the agent), through
   * the normal send path with the row's id as its `messageId` and no new user
   * row. Only for a turn that left no rows (no draft, nothing a quit flush
   * saved): rows prove the message arrived. Rejects, having sent nothing, when
   * the row is gone, a later user message follows it, or the turn has rows —
   * the turn then settles as interrupted; otherwise resolves with the turn's
   * outcome.
   */
  resend(): Promise<TurnOutcome>
  /**
   * Whether the kill left rows of the turn under its user row (a draft, what
   * the quit flush saved): the output the user saw stream before the app
   * closed.
   */
  hasRows(): boolean
  /**
   * How much output those rows hold: their assistant parts (an assistant row
   * saved without parts counts as one text part), notices left out. What a
   * cut-off reply on the server is weighed against.
   */
  savedOutputSize(): OutputSize
}

/** How a recovered turn ended. */
export type RecoveryResult =
  /** Nothing can be learned: an interrupted notice, a failed outcome. */
  | { kind: 'interrupted' }
  /**
   * The agent's record of the turn: `rows` replace what the kill left under
   * the user row, `ask` (for a turn that ended asking) opens the next-message
   * ask, and `outcome` settles the bookkeeping. `onSettled` is the driver's
   * own bookkeeping (the A2A session's task state), run once the rows are
   * written, and only when the chat has not moved on past the turn: a later
   * turn owns that state then. A throw from it is logged, not raised.
   */
  | {
      kind: 'collected'
      outcome: TurnOutcome
      rows: RecoveredRow[]
      ask?: { requestId: string; request: InputRequest }
      onSettled?: () => void
      /**
       * The agent has no reply to replace the rows the kill left with (its
       * backend lost it): they stay, and `rows` is ignored. `notice`, when
       * set, is the error card that goes under them.
       */
      keepRows?: { notice?: TurnEndNotice }
    }
  /** The rows stay as the kill left them; only the bookkeeping is settled. */
  | { kind: 'kept'; outcome: TurnOutcome }
  /** `io.resend()` ran the turn; its rows are saved. */
  | { kind: 'resent'; outcome: TurnOutcome }
  /**
   * The agent could not be asked after all (network gone, session expired
   * mid-poll): nothing is saved or settled, the run closes, and the marker
   * stays for a later pass.
   */
  | { kind: 'defer'; reason: DeferReason }

/**
 * Why a marker is left for later. `network` is retried on a timer; `auth`
 * waits for the next sign-in, wake or launch.
 */
export type DeferReason = 'network' | 'auth'

/** What a recoverer decides before anything is shown. */
export type RecoveryPlan =
  /** The agent can't be asked now: the marker stays for a later pass (see {@link DeferReason}). */
  | { kind: 'defer'; reason: DeferReason }
  /** Nothing to ask (the agent is gone, the turn never reached it): settle it as interrupted. */
  | { kind: 'interrupted'; reason: string }
  /**
   * Show the turn as running and recover it. A throw settles it as
   * interrupted. `replaysLive` says `recover` streams the turn again from its
   * start (Managed): the rows the kill left are then hidden from the live
   * view, which the replay stands in for. Without it (A2A, which only polls)
   * they stay in view under the live notice until the rows are swapped.
   */
  | { kind: 'recover'; replaysLive?: boolean; recover: (io: RecoveryIO) => Promise<RecoveryResult> }

export interface TurnRecoverer {
  plan(marker: InflightTurnRow, scope: RunScope): Promise<RecoveryPlan>
}

const recoverers = new Map<string, TurnRecoverer>()

/** Register how turns of `driverId` are recovered. The last registration wins. */
export function registerRecoverer(driverId: string, recoverer: TurnRecoverer): void {
  recoverers.set(driverId, recoverer)
}

/** Whether a turn of `driverId` has a recoverer. */
export function hasRecoverer(driverId: string): boolean {
  return recoverers.has(driverId)
}

/** Recoverer of `driverId`, if one is registered. */
export function recovererFor(driverId: string): TurnRecoverer | undefined {
  return recoverers.get(driverId)
}
