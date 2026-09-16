/**
 * Relaunch recovery of remote agent turns the app was closed under.
 *
 * A turn's in-flight marker (`inflight_turns`) outlives a kill or a quit. For
 * a driver whose agent keeps running without us — Cinna A2A today, Managed
 * next — the boot pass (`interruptedTurnService`) leaves the marker alone, and
 * this service asks the agent how the turn ended once the profile is usable.
 *
 * The generic part lives here: which markers to take, one chat at a time, the
 * live run that makes a recovered turn look like a running one (spinner,
 * streaming state, Stop, the queue for messages sent meanwhile), replacing the
 * rows a quit flush left with what the agent reports, and settling the task,
 * job run and sidebar result. What differs per driver — how to reach the agent
 * and what it says — is a {@link TurnRecoverer}, registered by driver id.
 */
import { inflightTurnRepo, isLiveMarker, TurnUserRowGone, type InflightTurnRow } from '../db/inflightTurns'
import { chatAgentCursorRepo } from '../db/chatAgentCursors'
import { chatRepo } from '../db/chats'
import { runExecutionService, type RunScope } from './runExecutionService'
import { activeRunsByChat } from './runExecutionState'
import { finalizeInterrupted, isSuperseded, INTERRUPTED_NOTICE, INTERRUPTED_OUTCOME } from './interruptedTurnService'
import { inboxService } from './inboxService'
import { getSettingsScopeUserId } from '../auth/scope'
import { createLogger } from '../logger/logger'
import { recovererFor, type DeferReason, type RecoveryIO, type RecoveryResult, type TurnRecoverer } from './turnRecoverers'
import type { TurnOutcome } from './turnCompletion'
import { outputSizeOf, type OutputSize } from '../agents/outputSize'
import type { RunEvent } from '../../shared/runEvents'

const logger = createLogger('turn-recovery')

export { registerRecoverer, hasRecoverer, STILL_RUNNING_NOTICE, CUT_OFF_NOTICE, REPLY_CUT_OFF_CODE, TASK_FAILED_MESSAGE } from './turnRecoverers'
export type { DeferReason, RecoveryIO, RecoveryResult, RecoveryPlan, TurnRecoverer } from './turnRecoverers'

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/** The marker as it is now, or null once something else settled it. */
function current(marker: InflightTurnRow): InflightTurnRow | null {
  return inflightTurnRepo.get(marker.id)
}

function settleInterrupted(marker: InflightTurnRow): void {
  finalizeInterrupted(marker, INTERRUPTED_OUTCOME, { notice: INTERRUPTED_NOTICE })
}

/**
 * Expire the reply asks a deferred run opened, and bring the task's status
 * back from `needs_input` when none is left. Runner ownership: the turn has
 * not ended, so the task's outcome is not written. Next-message asks stay.
 * Logs, never throws (`recordRunEvent`).
 */
function abandonReplyAsks(marker: InflightTurnRow, scope: RunScope): void {
  inboxService.recordRunEvent({
    userId: scope.profileUserId,
    chatId: marker.chatId,
    agentId: marker.agentId,
    turnId: marker.id,
    rootRunId: marker.id,
    completionOwner: 'runner'
  }, { type: 'done' })
}

/** Thrown by `resend` when the turn must not be sent again; the turn settles as interrupted. */
class ResendRefused extends Error {}

/** The turn's rows as `replaceTurnRows` would find them now. */
function turnRowIds(marker: InflightTurnRow): string[] {
  const now = current(marker) ?? marker
  return inflightTurnRepo.turnRowIds({
    chatId: marker.chatId, agentId: marker.agentId, userMessageId: marker.userMessageId!, draftMessageId: now.draftMessageId
  })
}

/** How much output the turn's rows hold (see `RecoveryIO.savedOutputSize`). */
function savedOutputSize(marker: InflightTurnRow): OutputSize {
  const ids = new Set(turnRowIds(marker))
  if (!ids.size) return outputSizeOf([])
  const parts = chatRepo.listMessages(marker.chatId)
    .filter((row) => ids.has(row.id) && row.role === 'assistant')
    .flatMap((row) => row.parts ?? (row.content ? [{ text: row.content }] : []))
  return outputSizeOf(parts)
}

/**
 * Write a collected turn: rows, the ask it ended on, the cursor a finished
 * turn moves, then the bookkeeping. A turn the chat has moved on from gets
 * its rows only: its ask, cursor and result belong to the later turn now
 * (`finalizeInterrupted` skips the bookkeeping for it). A user row that is
 * gone settles the turn as interrupted. The event the live view gets for a
 * failed turn is posted by the caller's run close.
 */
function applyCollected(marker: InflightTurnRow, result: Extract<RecoveryResult, { kind: 'collected' }>,
  openAsk: (event: RunEvent) => void): TurnOutcome {
  const superseded = isSuperseded(marker)
  let inserted: string[]
  try {
    // Kept rows stay as the kill left them; they are the turn's last rows.
    inserted = result.keepRows ? keptTurnRows(marker) : inflightTurnRepo.replaceTurnRows({
      chatId: marker.chatId,
      agentId: marker.agentId,
      userMessageId: marker.userMessageId!,
      draftMessageId: (current(marker) ?? marker).draftMessageId,
      rows: result.rows
    })
  } catch (err) {
    if (!(err instanceof TurnUserRowGone)) throw err
    logger.info('a recovered turn’s message is gone; settling it as interrupted', { chatId: marker.chatId })
    settleInterrupted(marker)
    return INTERRUPTED_OUTCOME
  }
  // No `touchChat`: a turn the app recovers on its own must not move the
  // chat up the list under the pointer.
  const outcome = result.outcome
  if (!superseded) {
    try {
      result.onSettled?.()
    } catch (err) {
      logger.warn('a recovered turn could not save its driver state', { chatId: marker.chatId, error: errorText(err) })
    }
    if (result.ask) openAsk({ type: 'needs_input', requestId: result.ask.requestId, request: result.ask.request, resume: 'next_message' })
    if (outcome.state === 'completed' || outcome.state === 'needs_input') {
      try {
        chatAgentCursorRepo.advance(marker.chatId, marker.agentId, inserted.at(-1) ?? marker.userMessageId!)
      } catch (err) {
        logger.warn('a recovered turn could not move the agent’s cursor', { chatId: marker.chatId, error: errorText(err) })
      }
    }
  }
  finalizeInterrupted(marker, outcome, result.keepRows?.notice ? { notice: result.keepRows.notice } : {})
  return outcome
}

/** The turn's rows, for a result that keeps them; throws as `replaceTurnRows` does when the user row is gone. */
function keptTurnRows(marker: InflightTurnRow): string[] {
  if (!inflightTurnRepo.hasUserRow({ chatId: marker.chatId, userMessageId: marker.userMessageId! })) throw new TurnUserRowGone()
  return turnRowIds(marker)
}

/** How long a deferred marker waits before it is tried again, while its profile is active. */
export const RECOVERY_RETRY_MS = 2 * 60_000

/**
 * How old a turn may get while its agent cannot be reached. Past it, a pass
 * that finds the agent unreachable settles the turn as interrupted instead of
 * waiting on. A turn waiting for its credentials waits on whatever its age:
 * the next sign-in ends that wait.
 */
export const RECOVERY_GIVE_UP_MS = 24 * 60 * 60_000

/** Whether a turn left for later because of `reason` has waited long enough. */
function waitedTooLong(marker: InflightTurnRow, reason: DeferReason): boolean {
  return reason === 'network' && Date.now() - marker.startedAt.getTime() >= RECOVERY_GIVE_UP_MS
}

let retryListener: ((profileId: string) => void) | null = null
const retryTimers = new Map<string, ReturnType<typeof setTimeout>>()

/** One retry per profile, however many markers wait. */
function scheduleRetry(profileId: string): void {
  if (!retryListener || retryTimers.has(profileId)) return
  const timer = setTimeout(() => {
    retryTimers.delete(profileId)
    try { retryListener?.(profileId) } catch (err) {
      logger.warn('a recovery retry could not start', { error: errorText(err) })
    }
  }, RECOVERY_RETRY_MS)
  timer.unref?.()
  retryTimers.set(profileId, timer)
}

/** Why the marker was left for later, or null when it was settled (or taken by something else). */
type Deferred = DeferReason | null

/** The terminal event of a run that closes without an outcome: the watcher's own "the run ended". */
const DEFERRED_END: RunEvent = { type: 'done' }
/**
 * What a deferred run's `completed` resolves with. Nothing records it; a
 * queue behind the run reads it, and holds its messages as it does after a
 * stop, rather than sending them past a turn nobody has settled.
 */
const DEFERRED_OUTCOME: TurnOutcome = { state: 'canceled', text: '' }

async function recoverOne(marker: InflightTurnRow, recoverer: TurnRecoverer, scope: RunScope): Promise<Deferred> {
  const plan = await recoverer.plan(marker, scope)
  if (!current(marker)) return null
  if (plan.kind === 'defer' && waitedTooLong(marker, plan.reason)) {
    logger.info('a remote turn’s agent stayed unreachable too long', { chatId: marker.chatId })
    settleInterrupted(marker)
    return null
  }
  if (plan.kind === 'defer') {
    // Nothing is shown: the rows saved at quit stay as they are.
    logger.info('a remote turn waits for its agent or its credentials', { chatId: marker.chatId, reason: plan.reason })
    return plan.reason
  }
  if (plan.kind === 'interrupted') {
    logger.info('a remote turn cannot be recovered', { chatId: marker.chatId, reason: plan.reason })
    settleInterrupted(marker)
    return null
  }

  // Behind whatever holds the chat now: a message sent since the launch.
  for (let active = activeRunsByChat.get(marker.chatId); active; active = activeRunsByChat.get(marker.chatId)) {
    await active.completed
  }
  if (!current(marker)) return null

  // Set from inside `drive`; declared this way so the check below is not narrowed away.
  let deferred = null as Deferred
  const handle = runExecutionService.adopt(scope, {
    chatId: marker.chatId,
    agentId: marker.agentId,
    runId: marker.id,
    // A live replay stands in for what the kill left until the rows are
    // swapped; a turn that is only polled keeps those rows in view.
    hiddenMessageIds: plan.replaysLive ? turnRowIds(marker) : [],
    observe: (ctx, event) => inboxService.recordRunEvent(ctx, event)
  }, async (io) => {
    let noticed = false
    const recoveryIO: RecoveryIO = {
      signal: io.signal,
      notice(text) {
        if (noticed) return
        noticed = true
        io.post({ type: 'delta', kind: 'notice', text })
      },
      event(event) {
        if (event.type === 'done' || event.type === 'error') return
        io.observe(event)
      },
      async resend() {
        // The resent turn's rows go at the end of the chat, so a message
        // already below this one would end up above the answer to it.
        const messages = chatRepo.listMessages(marker.chatId)
        const at = messages.findIndex((row) => row.id === marker.userMessageId)
        if (at < 0 || messages.slice(at + 1).some((row) => row.role === 'user')) {
          throw new ResendRefused('The message cannot be sent again: it is gone, or the chat has moved on past it.')
        }
        // Rows of the turn — a draft, what the quit flush saved — prove the
        // message arrived: sending it again would lose them for nothing.
        if (turnRowIds(marker).length) {
          throw new ResendRefused('The message reached the agent: the turn already has rows.')
        }
        return io.resend(marker.userMessageId!)
      },
      hasRows: () => turnRowIds(marker).length > 0,
      savedOutputSize: () => savedOutputSize(marker)
    }
    let result: RecoveryResult
    try {
      result = await plan.recover(recoveryIO)
    } catch (err) {
      if (err instanceof ResendRefused) logger.info('a remote turn is not sent again', { chatId: marker.chatId, reason: err.message })
      else logger.error('a remote turn could not be recovered', { chatId: marker.chatId, error: errorText(err) })
      result = { kind: 'interrupted' }
    }
    switch (result.kind) {
      case 'interrupted':
        settleInterrupted(marker)
        return INTERRUPTED_OUTCOME
      case 'collected':
        return applyCollected(marker, result, (event) => io.observe(event))
      case 'kept':
      case 'resent':
        finalizeInterrupted(marker, result.outcome)
        return result.outcome
      case 'defer':
        if (waitedTooLong(marker, result.reason)) {
          logger.info('a remote turn’s agent stayed unreachable too long', { chatId: marker.chatId })
          settleInterrupted(marker)
          return INTERRUPTED_OUTCOME
        }
        // Nothing saved, nothing settled, the marker stays. The run still
        // has to end for the views that show it running, and a permission
        // ask the follow offered has no park behind it any more.
        abandonReplyAsks(marker, scope)
        deferred = result.reason
        io.post(DEFERRED_END)
        return DEFERRED_OUTCOME
    }
  })
  const outcome = await handle.completed
  if (deferred) {
    logger.info('a remote turn was left for later', { chatId: marker.chatId, driver: marker.driver, reason: deferred })
    return deferred
  }
  logger.info('a remote turn was recovered', { chatId: marker.chatId, driver: marker.driver, state: outcome.state })
  return null
}

/** Marker ids being recovered now, so a second trigger does not take them twice. */
const inProgress = new Set<string>()
/** The recovery chain of each chat: its markers run one after another. */
const chains = new Map<string, Promise<Deferred>>()

/** Resolves with why the marker was left for later, or null. Never rejects. */
function enqueue(marker: InflightTurnRow, scope: RunScope): Promise<Deferred> {
  const recoverer = recovererFor(marker.driver)
  if (!recoverer || inProgress.has(marker.id)) return Promise.resolve(null)
  inProgress.add(marker.id)
  const previous = chains.get(marker.chatId) ?? Promise.resolve(null)
  const next = previous.then(async (): Promise<Deferred> => {
    try {
      if (!current(marker)) return null
      return await recoverOne(marker, recoverer, scope)
    } catch (err) {
      logger.error('a remote turn recovery failed', { chatId: marker.chatId, error: errorText(err) })
      try {
        if (current(marker) && !activeRunsByChat.has(marker.chatId)) settleInterrupted(marker)
      } catch (settleErr) {
        logger.error('a failed recovery could not be settled', { chatId: marker.chatId, error: errorText(settleErr) })
      }
      return null
    } finally {
      inProgress.delete(marker.id)
    }
  })
  chains.set(marker.chatId, next)
  void next.finally(() => { if (chains.get(marker.chatId) === next) chains.delete(marker.chatId) })
  return next
}

export const remoteTurnRecoveryService = {
  /**
   * Recover every marker of `profileId` that has a recoverer. Called when the
   * profile becomes usable — after its activation, after a re-auth, after the
   * machine wakes — and by the retry {@link onRetryDue} asks for. Chats run
   * concurrently, each chat's markers in order. A marker left for later
   * because its agent was unreachable schedules one retry for the profile as
   * soon as it is known, whatever other chats still wait on; one left for
   * its credentials waits for the next sign-in, wake or launch instead. A
   * turn older than {@link RECOVERY_GIVE_UP_MS} whose agent is still
   * unreachable is settled as interrupted.
   * Markers of turns this process is running are not taken. The promise
   * settles when all of them have (tests await it; the app does not). Never
   * rejects.
   */
  resume(profileId: string): Promise<void> {
    let markers: InflightTurnRow[] = []
    try {
      markers = inflightTurnRepo.list().filter((marker) => marker.profileId === profileId && !isLiveMarker(marker.id))
    } catch (err) {
      logger.error('could not read the in-flight turns', { error: errorText(err) })
    }
    const scope: RunScope = { profileUserId: profileId, settingsUserId: getSettingsScopeUserId() }
    return Promise.all(markers.map((marker) => enqueue(marker, scope).then((deferred) => {
      if (deferred === 'network') scheduleRetry(profileId)
    }))).then(() => undefined)
  },

  /**
   * Who is told, {@link RECOVERY_RETRY_MS} after a pass left a marker for
   * later, to run `resume` again — the app checks the profile is still the
   * active one first. There is no "back online" event in the main process, so
   * this timer is how a network that returns is noticed.
   */
  onRetryDue(listener: ((profileId: string) => void) | null): void {
    retryListener = listener
  }
}
