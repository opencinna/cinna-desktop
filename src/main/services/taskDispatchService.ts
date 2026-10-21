import { agentTaskDispatchRepo, taskDispatchGateRepo, type TaskDispatchGateRow } from '../db/taskDispatch'
import { taskRepo } from '../db/tasks'
import { taskInputRequestRepo, type TaskInputRequestRow } from '../db/taskInputRequests'
import { taskRuntimeRepo } from '../db/taskRuntimes'
import { scriptRuntimeRepo } from '../db/scriptRuntimes'
import { taskHandoffRepo } from '../db/taskHandoffs'
import { delegationRepo } from '../db/delegations'
import { handoverRepo } from '../db/handovers'
import { agentOverrideRepo } from '../db/agents'
import { visibleChat } from '../auth/chatScope'
import { taskService } from './taskService'
import { taskContinuationPrompt, taskExecutionService } from './taskExecutionService'
import { inboxService } from './inboxService'
import { onRunClosed, onRunOpened } from './runExecutionState'
import { liveAgentIds } from './activeAgentSessions'
import { installTaskRunnerHooks, taskRunnerBridge } from './taskRunnerBridge'
import { setDispatchableAgentsSource, setDispatchQueuesSource } from './taskDispatchInbox'
import { getSettingsScopeUserId } from '../auth/scope'
import { runtimeAgentSlotFree, withRuntimeAgent } from '../tasks/runtimeAdmission'
import { clearDispatchedRun, markDispatchedRun, setDispatchHoldsTask, setDispatchOwnedTurnSettler, setDispatchWake, type DispatchOwnedTurnEnd } from '../tasks/dispatchedTurns'
import { publishEvent } from '../host/events'
import { createLogger } from '../logger/logger'
import { parseHandoverState } from '../../shared/handovers'
import { DELEGATION_TERMINAL_STATES } from '../../shared/delegations'
import { TASK_PRIORITIES, type TaskDto } from '../../shared/tasks'
import { folderCategoryForStatus } from '../../shared/folderTasks'
import { parseTaskStatus } from '../../shared/taskStatus'
import type { InboxQueuedFor, TaskDispatchGateAction, TaskDispatchGateDeferral, TaskDispatchGateResult } from '../../shared/inbox'
import {
  DISPATCH_NOTE_INTERRUPTED,
  DISPATCH_NOTE_UNREPORTED,
  TASK_DISPATCH_CHANGED_CHANNEL,
  TASK_DISPATCH_MAX_RUNS,
  isTaskDispatchMaxRuns,
  type AgentDispatchState,
  type TaskDispatchMode,
  type TaskDispatchPauseReason,
  type TaskDispatchRunResult,
  type TaskDispatchUpdateResult,
  type TaskDispatchWaiting
} from '../../shared/taskDispatch'
import { runExecutionService, type RunOutcome, type RunScope } from './runExecutionService'

/**
 * The task dispatcher — Cinna working a folder agent's queue of Ready tasks
 * one at a time (unified tasks, phase 4). Hub core: no window is needed for
 * any of it, and nothing here imports Electron.
 *
 * **Which agents.** Every enabled local folder agent, bare and kit alike. A
 * remote cinna agent, the model and an unassigned task are never dispatched.
 *
 * **Which task.** Assigned to the agent, `open` (Ready), running here, with no
 * open ask, no runtime or script owning it, no remote handoff pending and no
 * delegation or file handover still starting it on its own; every
 * `blocked_by` id done (an id naming nothing blocks). Highest priority first,
 * then oldest. A task that already has a conversation continues in it.
 *
 * **When.** The queue's own starts keep a count: in `one` mode, whenever the
 * agent has no dispatched run; in `up_to` mode, whenever it has fewer than N
 * (its flights, of every origin — a Run next beyond the count included, so
 * the queue waits until the agent is back under it). Nothing else in the
 * folder holds a start back: another agent's run or settle there, a chat
 * typed there, a live turn on the same agent. Sessions side by side on one
 * agent are the user's call; the surfaces that start one only warn
 * (`activeAgentSessions`). A start still waits for the task's own chat (one
 * turn per chat) and for a global runner slot ({@link withRuntimeAgent}),
 * which each dispatched turn holds until it ends. No two flights ever hold
 * the same task. Woken by a mode change, a Resume, any task write (status,
 * create, folder pull), any turn ending, the profile becoming ready, and a
 * {@link TICK_MS} tick; passes are debounced and serialized, so two wakes
 * cannot start two runs. Only while the app is open.
 *
 * **Explicit starts.** Run next (the agent's Tasks tab, the Tasks view, Start
 * on a task page), Approve and run, and Run next sending a stored answer are
 * the user's own acts: they ignore the count and the pause, and start beside
 * whatever the agent already runs.
 *
 * **The report rule.** A dispatched turn is not settled by how it ended
 * (`inboxService.endTurn` leaves that one run to {@link settle}). The agent
 * reported when the task is in a done, failed, waiting or cancelled category
 * at the end — `tasks_report` (on its own task or, delegated, through the bus),
 * or the task file's status word moving on (read again, freshly, before
 * deciding) — and the
 * queue simply continues. Back in Ready or Backlog is no report: it would only
 * run again. A normal end without a report flags the task `blocked` with a
 * dispatch note and pauses the queue;
 * an error ending maps the task as today (`error`) and pauses; a Stop maps it
 * `cancelled` and pauses. A turn that ended on an open ask leaves the task
 * waiting on that ask and the queue continues.
 *
 * **Answers.** An Inbox answer to an ask on a task a queue owns is stored on
 * the ask (`queued_answer`), and the queue sends it as a flight of its own
 * (`origin: 'resume'`) before it picks a new task for that agent: the same
 * count, chat and slot rules as a launch, in any mode and while paused, since
 * the answer is the user's own act. Its turn ends by the report rule like any
 * dispatched turn.
 *
 * **Outside content.** A task whose file was written outside Cinna is not run
 * until the user approves that exact content in the Inbox (one card per
 * digest); meanwhile the queue moves on to the next task.
 */

const logger = createLogger('task-dispatch')

/** The sentence an answer stored for an agent that can no longer work its queue is cleared with. */
export const NOT_DISPATCHABLE_ANSWER = 'This agent can no longer work its queue. Answer again to send it.'

/** The fallback wake, for whatever no event announced. */
export const TICK_MS = 30_000
/** Wakes closer together than this are one pass. */
export const WAKE_DEBOUNCE_MS = 150

export interface DispatchAgent {
  id: string
  name: string
  /** Absolute path of the agent folder. */
  path: string
}

export interface DispatchStart {
  chatId: string
  runId: string
  completed: Promise<RunOutcome>
}

/** What the dispatcher needs from the rest of the app — the seams its tests replace. */
export interface TaskDispatchDeps {
  /** Enabled local folder agents (bare and kit) for this scope. */
  agents(scope: RunScope): Promise<DispatchAgent[]>
  /**
   * Start the task's turn. `onRunAccepted` is called inside the run's
   * acceptance, before any of its events, with the chat and run id the turn's
   * end will carry.
   */
  start(scope: RunScope, taskId: string, agentId: string, options: {
    continueInChat: boolean
    onRunAccepted: (run: { chatId: string; runId: string }) => void
    /** `user` for the user's own Run next (`taskExecutionService` `startedBy`). */
    startedBy?: 'user'
  }): Promise<DispatchStart>
  /**
   * Send an answer stored on a `next_message` ask: the turn that answers it,
   * started as an Inbox answer starts it. `onRunAccepted` as for {@link start}.
   */
  resume(scope: RunScope, ask: TaskInputRequestRow, content: string, options: {
    onRunAccepted: (run: { chatId: string; runId: string }) => void
  }): Promise<DispatchStart>
  /** A turn holds this chat now. */
  chatRunning(chatId: string): boolean
  withSlot<T>(agentId: string, signal: AbortSignal, run: () => Promise<T>): Promise<T>
  slotFree(): boolean
  /** The user approved this content: the task and its home's binding trust `digest`. */
  trust(userId: string, taskId: string, digest: string): Promise<void>
  /**
   * Read a file task's home again, so a status word the agent just wrote is
   * seen. A read that starts now: one already in flight began before the turn
   * ended and is not enough.
   */
  refreshTask(userId: string, taskId: string): Promise<void>
  /** The agents of every turn running now, whoever started it (boot recovery reads it). */
  liveAgentIds(profileUserId: string): string[]
  publish(agentId: string | null): void
}

interface Flight {
  userId: string
  agentId: string
  taskId: string
  title: string
  chatId: string | null
  /** Waiting for a slot, starting, or running its turn. */
  phase: 'slot' | 'starting' | 'running'
  /** When it was launched: the agent's running list is oldest first. */
  launchedAt: number
  /**
   * `queue`: the `one` mode started it; `manual`: Run next or an approval did;
   * `resume`: it sends an answer stored on the task's ask ({@link Flight.answer}).
   */
  origin: 'queue' | 'manual' | 'resume'
  /**
   * The user asked for this start (Run next, Approve and run, Run next sending
   * a stored answer): it ignores the agent's count and its pause. The queue's
   * own starts, its stored answers included, keep the count.
   */
  explicit: boolean
  /** The ask whose stored answer a `resume` flight sends, and when it was stored. */
  answer: { requestId: string; queuedAt: number } | null
  /**
   * The user pressed Run next for this flight (the `taskDispatch:run-next`
   * channel). Not an approval's run, which is `manual` too, and never the
   * queue's own: only this marks the task as started by the user.
   */
  startedByUser: boolean
  controller: AbortController
  /** The dispatched run, once accepted: the only turn `endTurn` leaves to {@link settle}. */
  run: { chatId: string; runId: string } | null
}

interface Candidate {
  task: TaskDto
  /** Content from outside Cinna that nobody approved yet. */
  gated: boolean
}

/** The task's own chat is running a turn (one turn per chat): end quietly, the turn's close wakes the queue. */
class LiveTurnError extends Error {}
/** The agent already has as many runs as its mode allows (the mode changed during the wait): end quietly. */
class AgentFullError extends Error {}
/** The task stopped qualifying while its flight waited for a slot: end quietly. */
class NoLongerEligibleError extends Error {}
/** Cinna is quitting, or the queue's wait was abandoned. */
class AbandonedError extends Error {}

/**
 * Whether a dispatched turn's task says how the work went: the agent moved it
 * to done, failed, waiting or cancelled. Still Active — or moved back to Ready
 * or Backlog, which would only run it again — is no report.
 */
function reported(status: string): boolean {
  const category = folderCategoryForStatus(parseTaskStatus(status))
  return category === 'done' || category === 'failed' || category === 'waiting' || category === 'cancelled'
}

const PRIORITY_RANK = new Map(TASK_PRIORITIES.map((priority, index) => [priority, index]))

function flightKey(userId: string, agentId: string): string {
  return JSON.stringify([userId, agentId])
}

function taskSettleKey(userId: string, taskId: string): string {
  return JSON.stringify([userId, taskId])
}

/** A flight is held per task: two flights never take the same task. */
function taskFlightKey(userId: string, agentId: string, taskId: string): string {
  return JSON.stringify([userId, agentId, taskId])
}

/** How many dispatched runs this agent may have at once: N in `up_to`, else one. */
function limitOf(row: { mode: TaskDispatchMode; maxRuns: number | null }): number {
  if (row.mode !== 'up_to') return 1
  return isTaskDispatchMaxRuns(row.maxRuns) ? row.maxRuns : TASK_DISPATCH_MAX_RUNS.default
}

/**
 * What an answer stored for this agent's queue waits on, as the Inbox names
 * it: the agent, and N in `up_to` (room under N); otherwise its running task.
 */
export function dispatchQueueOf(userId: string, agent: { name: string; id: string }): InboxQueuedFor {
  const row = agentTaskDispatchRepo.get(userId, agent.id)
  return { agentName: agent.name, maxRuns: row.mode === 'up_to' ? limitOf(row) : null }
}

export function createTaskDispatchService(deps: TaskDispatchDeps) {
  /** Every flight, by {@link taskFlightKey}: several per agent in `up_to`. */
  const flights = new Map<string, Flight>()
  /**
   * Agents whose owned (resumed) turn is being settled now, by
   * {@link flightKey}, with how many settles are under way. Until the settle
   * lands — it reads the task file again first — the agent is busy to its
   * queue's own starts, or a pass woken by the turn closing could start the
   * next task before the pause is written. The user's own starts ignore it.
   */
  const settlingOwned = new Map<string, number>()
  /**
   * The tasks those owned turns belong to, by {@link taskSettleKey}, with how
   * many settles are under way. The user's own starts ignore the agent's
   * settle, but not the task's: a Run next or an approval that took the task
   * itself mid-settle (its file re-read back to Ready) would have the settle's
   * release and unreported flag land on the run it just started.
   */
  const settlingTasks = new Map<string, number>()
  /**
   * Each agent's state as last announced, by {@link flightKey}. A pass compares
   * and publishes what moved, so a surface showing a queue needs no poll: a
   * task made Ready, a file saved, a turn opening or closing all wake a pass,
   * and the pass says when "Next" or "Waiting" changed.
   */
  const announced = new Map<string, string>()
  let scope: RunScope | null = null
  let epoch = 0
  let tick: ReturnType<typeof setInterval> | null = null
  let wakeTimer: ReturnType<typeof setTimeout> | null = null
  let passes: Promise<void> = Promise.resolve()
  let quitting = false
  /** Launch order, so an agent's flights list oldest first. */
  let nextLaunch = 0

  // ---- reading -------------------------------------------------------------

  /** Why this task cannot be dispatched to this agent now, or null when it can. */
  function refusal(userId: string, task: TaskDto, agentId: string): string | null {
    if (task.assignee.kind !== 'agent' || task.assignee.agentId !== agentId) return 'This task is not assigned to this agent.'
    // Its last turn is still being settled ({@link settlingTasks}): no start
    // of any kind takes it until that lands. The settle's end wakes the queue.
    if (settlingTask(userId, task.id)) return 'This task is still being wrapped up. Try again in a moment.'
    if (task.status !== 'open') return 'Only a Ready task can be run.'
    if (task.executor !== 'desktop' || !task.runsHere) return 'This task is running elsewhere. Take it over first.'
    if (task.router === 'script' || task.script != null) return 'This task needs its script runner.'
    if (taskInputRequestRepo.listOpenForTask(task.id).length > 0) return 'Answer this task’s question in the Inbox first.'
    if (taskRuntimeRepo.get(userId, task.id) || scriptRuntimeRepo.owner(userId, task.id)) return 'This task is run by its runtime.'
    if (taskHandoffRepo.unresolved(userId, task.id)) return 'Resolve this task’s remote handoff first.'
    const delegation = delegationRepo.byTaskId(userId, task.id)
    const handover = handoverRepo.byTaskId(userId, task.id)
    const state = delegation?.state ?? (handover ? parseHandoverState(handover.state) : null)
    if (state && !DELEGATION_TERMINAL_STATES.has(state)) return 'This task is a handover; it starts through its own approval.'
    const waiting = task.blockedBy.filter((blocker) => !blocker.done)
    if (waiting.length > 0) {
      return `This task waits on ${waiting.map((blocker) => blocker.title ? `“${blocker.title}”` : `${blocker.id} (not found)`).join(', ')}.`
    }
    return null
  }

  /**
   * The agent's dispatchable tasks, in the order the queue takes them. A task
   * a flight already holds (still waiting for its slot, so still Ready) is not
   * one of them.
   */
  function candidates(userId: string, agentId: string): Candidate[] {
    return taskService.list(userId, { statuses: ['open'] })
      .filter((task) => task.assignee.agentId === agentId && !held(userId, task.id) && refusal(userId, task, agentId) === null)
      .sort((a, b) => (PRIORITY_RANK.get(b.priority) ?? 0) - (PRIORITY_RANK.get(a.priority) ?? 0) ||
        a.createdAt.getTime() - b.createdAt.getTime() || a.id.localeCompare(b.id))
      .map((task) => ({ task, gated: task.fromOutside }))
  }

  /** This agent's flights, of every origin and phase, oldest first. */
  function flightsOf(userId: string, agentId: string): Flight[] {
    return [...flights.values()].filter((flight) => flight.userId === userId && flight.agentId === agentId)
      .sort((a, b) => a.launchedAt - b.launchedAt)
  }

  /** Whether a flight (of any agent, in any phase) already holds this task. */
  function held(userId: string, taskId: string): boolean {
    for (const flight of flights.values()) if (flight.userId === userId && flight.taskId === taskId) return true
    return false
  }

  /** Whether an owned turn on this task is being settled ({@link settlingTasks}). */
  function settlingTask(userId: string, taskId: string): boolean {
    return settlingTasks.has(taskSettleKey(userId, taskId))
  }

  /** Whether an owned turn of this agent is being settled ({@link settlingOwned}). */
  function settling(userId: string, agentId: string): boolean {
    return settlingOwned.has(flightKey(userId, agentId))
  }

  /** Whether a turn holds this task's own chat now: starting it would only refuse. */
  function chatBusy(task: TaskDto): boolean {
    return !!task.chatId && deps.chatRunning(task.chatId)
  }

  function stateFor(userId: string, agent: DispatchAgent): AgentDispatchState {
    const row = agentTaskDispatchRepo.get(userId, agent.id)
    const own = flightsOf(userId, agent.id)
    const waitingFlight = own.find((flight) => flight.phase === 'slot')
    const pausedTask = row.pausedTaskId ? taskRepo.getById(userId, row.pausedTaskId) : undefined
    const list = candidates(userId, agent.id)
    const runnable = list.find((candidate) => !candidate.gated)
    let waiting: TaskDispatchWaiting | null = waitingFlight ? 'slot' : null
    // Only gated tasks left. Waiting on the gate means a card is actually in
    // the Inbox for one of them; with none (Manual, a paused queue, a skipped
    // card) the top one is the next task, and Run next asks for its approval.
    let next: AgentDispatchState['next'] = waitingFlight
      ? { taskId: waitingFlight.taskId, title: waitingFlight.title, needsApproval: false }
      : runnable ? { taskId: runnable.task.id, title: runnable.task.title, needsApproval: false } : null
    if (own.length === 0 && !runnable && list.length > 0) {
      if (hasOpenGate(userId, agent.id, list)) {
        if (!waiting) waiting = 'gate'
      } else {
        next = { taskId: list[0].task.id, title: list[0].task.title, needsApproval: true }
      }
    }
    return {
      agentId: agent.id,
      mode: row.mode,
      maxRuns: row.mode === 'up_to' ? limitOf(row) : null,
      paused: row.pausedReason
        ? {
            reason: row.pausedReason,
            taskId: row.pausedTaskId,
            taskTitle: pausedTask && !pausedTask.deletedAt ? pausedTask.title : null,
            at: (row.pausedAt ?? row.updatedAt).getTime()
          }
        : null,
      running: own.filter((flight) => flight.chatId)
        .map((flight) => ({ taskId: flight.taskId, chatId: flight.chatId!, title: flight.title })),
      next,
      waiting
    }
  }

  // ---- the gate ------------------------------------------------------------

  /** Whether an unanswered card asks about the current content of one of these gated tasks. */
  function hasOpenGate(userId: string, agentId: string, list: Candidate[]): boolean {
    const open = taskDispatchGateRepo.listOpen(userId).filter((gate) => gate.agentId === agentId)
    if (open.length === 0) return false
    return list.some((candidate) => candidate.gated && open.some((gate) =>
      gate.taskId === candidate.task.id && gate.digest === taskRepo.getById(userId, candidate.task.id)?.localFile?.digest))
  }

  /**
   * The approval for this task's current content: the existing card for the
   * digest (reopened when `reopenSkipped` and the user had skipped it), else
   * a new one, which supersedes the cards of older content.
   */
  function gateFor(userId: string, agentId: string, task: TaskDto, reopenSkipped: boolean): TaskDispatchGateRow | null {
    const row = taskRepo.getById(userId, task.id)
    const digest = row?.localFile?.digest
    if (!row || !digest) return null
    const existing = taskDispatchGateRepo.forDigest(userId, task.id, digest)
    if (existing) {
      // A skipped card stays skipped unless Run next asks for it. One that was
      // approved or superseded and whose content is untrusted again (the file
      // went back to it, or the trust could not be saved) is asked again.
      if (existing.status === 'approved' || existing.status === 'superseded' || (existing.status === 'skipped' && reopenSkipped)) {
        taskDispatchGateRepo.reopen(userId, existing.id)
        deps.publish(agentId)
      }
      return taskDispatchGateRepo.getById(userId, existing.id) ?? existing
    }
    const opened = taskDispatchGateRepo.open(userId, {
      taskId: task.id,
      agentId,
      digest,
      title: task.title,
      filePath: task.file?.path ?? null,
      body: taskContinuationPrompt(task)
    })
    logger.info('a task waits on approval of content written outside Cinna', { taskId: task.id, agentId })
    deps.publish(agentId)
    return opened
  }

  // ---- running -------------------------------------------------------------

  /**
   * Pause the queue on this task. A queue already paused keeps its first
   * pause: that is the card in the Inbox and the task the user was shown
   * first. A later flagged run (an `up_to` queue's other runs, a Run next
   * while paused) carries its own dispatch note on its task.
   */
  function pause(userId: string, agentId: string, reason: TaskDispatchPauseReason, taskId: string | null): void {
    if (agentTaskDispatchRepo.get(userId, agentId).pausedReason) {
      logger.info('a task queue already paused flagged another task', { agentId, taskId, reason })
      return
    }
    agentTaskDispatchRepo.pause(userId, agentId, reason, taskId)
    logger.info('a task queue paused', { agentId, taskId, reason })
  }

  function writeStatus(userId: string, taskId: string, status: 'in_progress' | 'blocked' | 'error' | 'cancelled', opts: { errorMessage?: string; dispatchNote?: string } = {}): void {
    try {
      taskService.setStatus(userId, taskId, status, opts)
    } catch (error) {
      logger.warn('a dispatched task could not be settled', { taskId, status, error: String(error) })
    }
  }

  /** How a dispatched turn's end leaves its task and its queue. See the module comment. */
  async function settle(flight: Flight, outcome: RunOutcome): Promise<void> {
    await settleTask(flight.userId, flight.agentId, flight.taskId, outcome, () => {
      agentTaskDispatchRepo.clearActive(flight.userId, flight.agentId, flight.taskId)
    })
  }

  /**
   * The report rule, for the dispatched turn and for any later turn on a task
   * the queue still owns. `afterRead` runs once the file is read again, just
   * before the decision. The task stays the queue's only while it waits on an
   * open ask; every other ending gives it up.
   */
  async function settleTask(
    userId: string, agentId: string, taskId: string,
    outcome: { state: RunOutcome['state']; error?: { message: string } },
    afterRead: () => void = () => {}
  ): Promise<void> {
    // Quitting: the persisted in-flight row stays, and the next boot flags it.
    if (quitting) return
    const before = taskRepo.getById(userId, taskId)
    if (before?.localFile) {
      try { await deps.refreshTask(userId, taskId) } catch (error) {
        logger.warn('a dispatched task’s file could not be read again', { taskId, error: String(error) })
      }
    }
    if (quitting) return
    afterRead()
    const task = taskRepo.getById(userId, taskId)
    if (!task) return
    // Archived or deleted meanwhile, however the turn ended: the user put the
    // task away, which says all there is to say. Released, no status written,
    // no pause — the queue continues.
    if (task.deletedAt || task.status === 'archived') {
      release(userId, taskId)
      logger.info('a dispatched task was put away before its turn ended', { taskId, agentId })
      return
    }
    // Ended on a question: the task waits on its ask, which is a report of its
    // own, and stays the queue's — the turn the answer resumes ends by this rule.
    if ((outcome.state === 'completed' || outcome.state === 'needs_input') &&
      taskInputRequestRepo.listOpenForTask(taskId).length > 0) return
    release(userId, taskId)
    const running = task.status === 'in_progress'
    if (outcome.state === 'canceled') {
      if (running) writeStatus(userId, taskId, 'cancelled')
      pause(userId, agentId, 'stopped', taskId)
      return
    }
    if (outcome.state === 'failed' || outcome.state === 'budget') {
      if (running) writeStatus(userId, taskId, 'error', { errorMessage: outcome.error?.message ?? 'The turn failed.' })
      pause(userId, agentId, 'error', taskId)
      return
    }
    if (!reported(task.status)) {
      // Back in Ready or Backlog goes through Active: neither may move to
      // `blocked` directly, and left there the queue would run it again.
      if (!running) writeStatus(userId, taskId, 'in_progress')
      writeStatus(userId, taskId, 'blocked', { dispatchNote: DISPATCH_NOTE_UNREPORTED })
      pause(userId, agentId, 'unreported', taskId)
      return
    }
    logger.info('a dispatched task was reported', { taskId, agentId, status: task.status })
  }

  /** The queue no longer owns how this task settles. */
  function release(userId: string, taskId: string): void {
    try { taskRepo.setDispatchAgent(userId, taskId, null) } catch (error) {
      logger.warn('a dispatched task could not be released', { taskId, error: String(error) })
    }
  }

  /** A start that never got going. The queue pauses on it, so it is not retried every tick. */
  function startFailed(flight: Flight, error: unknown): void {
    agentTaskDispatchRepo.clearActive(flight.userId, flight.agentId, flight.taskId)
    if (error instanceof LiveTurnError || error instanceof AgentFullError ||
      error instanceof NoLongerEligibleError || error instanceof AbandonedError ||
      flight.controller.signal.aborted || quitting) return
    logger.warn('a dispatched task could not be started', { taskId: flight.taskId, agentId: flight.agentId, error: String(error) })
    if (flight.origin === 'queue') pause(flight.userId, flight.agentId, 'error', flight.taskId)
    // An answer that could not be sent says why on its ask, which can be
    // answered again. No pause: nothing ran.
    if (flight.answer) {
      dropAnswer(flight, error instanceof Error && error.message ? error.message : 'The answer could not be sent.')
    }
  }

  /** Clear the stored answer the flight was sending, with the sentence its card shows. */
  function dropAnswer(flight: Flight, error: string): void {
    if (!flight.answer) return
    try { taskInputRequestRepo.dropQueuedAnswer(flight.answer.requestId, new Date(flight.answer.queuedAt), error) } catch (err) {
      logger.warn('a stored answer could not be cleared', { requestId: flight.answer.requestId, error: String(err) })
    }
  }

  /**
   * The flight's task as it is now, when it still qualifies. Otherwise throws
   * {@link NoLongerEligibleError} — after opening the approval card when it is
   * content from outside Cinna that nobody approved, as a pass would.
   */
  function recheck(flight: Flight): TaskDto {
    const row = taskRepo.getById(flight.userId, flight.taskId)
    if (!row || row.deletedAt) throw new NoLongerEligibleError('This task is gone.')
    const task = taskService.getById(flight.userId, flight.taskId)
    const reason = refusal(flight.userId, task, flight.agentId)
    if (reason) throw new NoLongerEligibleError(reason)
    if (task.fromOutside) {
      gateFor(flight.userId, flight.agentId, task, false)
      throw new NoLongerEligibleError('This task’s file changed outside Cinna. Approve it in the Inbox to run it.')
    }
    return task
  }

  /** The run was accepted: it is the queue's to settle (marked before any of its events). */
  function accepted(flight: Flight, run: { chatId: string; runId: string }): void {
    flight.run = run
    markDispatchedRun(run.chatId, run.runId)
    // Persisted: a turn this task's chat runs after an ask is the queue's to
    // settle too, across a restart.
    taskRepo.setDispatchAgent(flight.userId, flight.taskId, flight.agentId)
  }

  /** Start a Ready task, chosen again after the slot wait ({@link recheck}). */
  async function startTask(runScope: RunScope, flight: Flight): Promise<DispatchStart> {
    // The wait for a slot can be long: the task may have been started by
    // hand, finished, reassigned, deleted or rewritten outside Cinna since
    // it was chosen. Choose it again, as a pass would.
    const current = recheck(flight)
    // The task's own chat may have taken a turn during the wait (one typed
    // there): one turn per chat, so wait for it, quietly.
    if (current.chatId && deps.chatRunning(current.chatId)) throw new LiveTurnError('This task’s conversation is still running a turn.')
    flight.title = current.title
    agentTaskDispatchRepo.setActive(flight.userId, flight.agentId, flight.taskId, null)
    return deps.start(runScope, flight.taskId, flight.agentId, {
      continueInChat: !!current.chatId,
      onRunAccepted: (run) => accepted(flight, run),
      ...(flight.startedByUser ? { startedBy: 'user' as const } : {})
    })
  }

  /**
   * The stored answer a `resume` flight sends, as it is now, when it can still
   * be sent. Otherwise throws {@link NoLongerEligibleError} — after clearing
   * the answer with a reason when the ask stays open but this queue cannot
   * send it — or {@link LiveTurnError} while the chat is still running, which
   * leaves the answer for a later pass.
   */
  function recheckAnswer(flight: Flight): { ask: TaskInputRequestRow; content: string } {
    const stored = flight.answer!
    const ask = taskInputRequestRepo.getById(stored.requestId)
    if (!ask || ask.status !== 'open' || ask.queuedAnswer == null || ask.queuedAt?.getTime() !== stored.queuedAt) {
      throw new NoLongerEligibleError('This answer is no longer waiting to be sent.')
    }
    const row = taskRepo.getById(flight.userId, ask.taskId)
    if (!row || row.deletedAt) throw new NoLongerEligibleError('This task is gone.')
    const refuse = (reason: string): never => {
      dropAnswer(flight, reason)
      throw new NoLongerEligibleError(reason)
    }
    if (row.dispatchAgentId !== flight.agentId) refuse('This task left its queue before the answer was sent. Answer again to send it.')
    if (!['blocked', 'in_progress'].includes(row.status)) {
      // As an Inbox answer finds it: the task no longer waits on anybody.
      taskInputRequestRepo.settle(ask.id, 'expired')
      throw new NoLongerEligibleError('This task is no longer waiting for this answer.')
    }
    const task = taskService.getById(flight.userId, ask.taskId)
    if (task.executor !== 'desktop' || !task.runsHere) refuse('This task is now running elsewhere.')
    if (!visibleChat(flight.userId, ask.chatId)) refuse('The conversation or its agent is no longer available.')
    if (deps.chatRunning(ask.chatId)) throw new LiveTurnError('This conversation is still finishing its turn.')
    flight.title = task.title
    return { ask, content: ask.queuedAnswer }
  }

  /** Send the answer stored on the task's ask: the turn it resumes is this flight's. */
  async function sendAnswer(runScope: RunScope, flight: Flight): Promise<DispatchStart> {
    const { ask, content } = recheckAnswer(flight)
    agentTaskDispatchRepo.setActive(flight.userId, flight.agentId, flight.taskId, null)
    return deps.resume(runScope, ask, content, { onRunAccepted: (run) => accepted(flight, run) })
  }

  /**
   * Reserve the task (and a place in the agent's count) now, synchronously,
   * so a second wake sees it taken, then take a slot, start the turn (`begin`:
   * a task, or a stored answer) and follow it to the end. Resolves once the
   * turn is accepted; rejects when it never starts. `begin` checks again what
   * it was chosen for; one that no longer qualifies ends the flight quietly —
   * no pause — and the queue moves on.
   */
  function launch(
    runScope: RunScope, agent: DispatchAgent, task: { id: string; title: string }, origin: Flight['origin'],
    options: { answer?: Flight['answer']; startedByUser?: boolean; explicit?: boolean } = {}
  ): Promise<DispatchStart> {
    const flight: Flight = {
      userId: runScope.profileUserId,
      agentId: agent.id,
      taskId: task.id,
      title: task.title,
      chatId: null,
      phase: 'slot',
      launchedAt: nextLaunch++,
      origin,
      explicit: options.explicit ?? false,
      answer: options.answer ?? null,
      startedByUser: options.startedByUser ?? false,
      controller: new AbortController(),
      run: null
    }
    const key = taskFlightKey(flight.userId, agent.id, task.id)
    flights.set(key, flight)
    deps.publish(agent.id)
    let isAccepted = false
    let resolveStart!: (start: DispatchStart) => void
    let rejectStart!: (error: unknown) => void
    const started = new Promise<DispatchStart>((resolve, reject) => { resolveStart = resolve; rejectStart = reject })
    void deps.withSlot(agent.id, flight.controller.signal, async () => {
      flight.phase = 'starting'
      if (quitting || flight.controller.signal.aborted) throw new AbandonedError('The dispatch was abandoned.')
      // The user's own start goes beside whatever the agent runs, in any mode
      // and while paused. The queue's own keeps the rules of the agent's mode
      // as they are now: they may have changed during the wait.
      if (!flight.explicit) {
        const row = agentTaskDispatchRepo.get(flight.userId, agent.id)
        // Every other flight that got going counts, an explicit one beyond the
        // count included: the queue waits until the agent is back under it.
        const working = (other: Flight): boolean => other !== flight && other.phase !== 'slot'
        if (flightsOf(flight.userId, agent.id).filter(working).length >= limitOf(row)) {
          throw new AgentFullError('This agent is already running as many tasks as its queue allows.')
        }
        // The queue paused during the wait (another of its runs was flagged):
        // its own flights stop here. A stored answer is the user's act, and
        // goes on while paused.
        if (flight.origin === 'queue' && row.pausedReason) throw new AbandonedError('The queue paused while this run waited.')
        // An owned turn of this agent is being settled: its pause may be about
        // to be written. The settle's end wakes the queue again.
        if (settling(flight.userId, agent.id)) throw new AgentFullError('This agent is still settling its last turn.')
      }
      const start = await (flight.answer ? sendAnswer(runScope, flight) : startTask(runScope, flight))
      isAccepted = true
      flight.chatId = start.chatId
      flight.phase = 'running'
      agentTaskDispatchRepo.setActive(flight.userId, agent.id, task.id, start.chatId)
      deps.publish(agent.id)
      logger.info('a task was dispatched', { taskId: task.id, agentId: agent.id, chatId: start.chatId, origin })
      resolveStart(start)
      const outcome = await start.completed
      await settle(flight, outcome)
    }).catch((error) => {
      if (!isAccepted) {
        startFailed(flight, error)
        rejectStart(error)
      } else {
        logger.warn('a dispatched turn could not be settled', { taskId: task.id, error: String(error) })
      }
    }).finally(() => {
      if (flight.run) clearDispatchedRun(flight.run.chatId, flight.run.runId)
      if (quitting) return
      if (flights.get(key) === flight) flights.delete(key)
      deps.publish(agent.id)
      wake()
    })
    void started.catch(() => {})
    return started
  }

  /** A `resume` flight for this stored answer; `explicit` when Run next sends it. */
  function launchAnswer(runScope: RunScope, agent: DispatchAgent, answer: TaskInputRequestRow, explicit = false): Promise<DispatchStart> {
    const task = taskRepo.getById(runScope.profileUserId, answer.taskId)
    return launch(runScope, agent, { id: answer.taskId, title: task?.title ?? '' }, 'resume',
      { answer: { requestId: answer.id, queuedAt: answer.queuedAt!.getTime() }, explicit })
  }

  /**
   * Answers stored for queues, by the agent whose queue owns the task, oldest
   * first. One whose task no longer belongs to a queue (taken over, handed
   * off, moved on) is cleared with a reason: nobody else would send it.
   */
  function storedAnswers(userId: string): Map<string, TaskInputRequestRow[]> {
    const byAgent = new Map<string, TaskInputRequestRow[]>()
    for (const ask of taskInputRequestRepo.listQueued(userId)) {
      const task = taskRepo.getById(userId, ask.taskId)
      if (!task?.dispatchAgentId) {
        if (ask.queuedAt) {
          taskInputRequestRepo.dropQueuedAnswer(ask.id, ask.queuedAt, 'This task left its queue before the answer was sent. Answer again to send it.')
        }
        continue
      }
      if (!ask.queuedAt || ask.queuedAnswer == null) continue
      const list = byAgent.get(task.dispatchAgentId) ?? []
      list.push(ask)
      byAgent.set(task.dispatchAgentId, list)
    }
    return byAgent
  }

  /** Publish every agent whose state differs from what was last announced. */
  function announceChanges(userId: string, agents: DispatchAgent[]): void {
    for (const agent of agents) {
      const key = flightKey(userId, agent.id)
      let state: string
      try { state = JSON.stringify(stateFor(userId, agent)) } catch (error) {
        logger.warn('a queue’s state could not be read', { agentId: agent.id, error: String(error) })
        continue
      }
      if (announced.get(key) === state) continue
      announced.set(key, state)
      deps.publish(agent.id)
    }
  }

  /**
   * An `up_to` agent's part of a pass: fill its free runs, stored answers
   * first (in any mode and while paused), then Ready tasks (unless paused),
   * each held by its own flight so none is taken twice. At most one of its
   * flights waits for a runner slot at a time: after each launch the pass
   * lets the slot be granted, and stops for this agent while one still waits,
   * so a full set of slots never queues N waits.
   */
  async function passWide(passScope: RunScope, agent: DispatchAgent, row: { mode: TaskDispatchMode; maxRuns: number | null; pausedReason: TaskDispatchPauseReason | null }, answers: TaskInputRequestRow[]): Promise<void> {
    const userId = passScope.profileUserId
    const passEpoch = epoch
    const room = (): boolean => {
      if (passEpoch !== epoch || quitting || settling(userId, agent.id)) return false
      const own = flightsOf(userId, agent.id)
      return own.length < limitOf(row) && !own.some((flight) => flight.phase === 'slot')
    }
    /** Let the flight just launched take its slot, if one is free. */
    const settleLaunch = (): Promise<void> => new Promise((resolve) => setImmediate(resolve))
    for (const answer of answers) {
      if (!room()) return
      // Its chat still running: it waits for that turn; the others go on.
      if (held(userId, answer.taskId) || deps.chatRunning(answer.chatId)) continue
      void launchAnswer(passScope, agent, answer).catch(() => {})
      await settleLaunch()
    }
    if (row.pausedReason) return
    for (const candidate of candidates(userId, agent.id)) {
      if (candidate.gated) {
        gateFor(userId, agent.id, candidate.task, false)
        continue
      }
      if (!room()) return
      // Chosen again: the slot wait above may have let anything happen.
      if (held(userId, candidate.task.id)) continue
      // Its own chat busy with a turn (one typed there, beside the queue):
      // it waits for that turn, whose close wakes the queue; the others go on.
      // Launched, it would take a slot only to refuse, and wake again at once.
      if (chatBusy(candidate.task)) continue
      void launch(passScope, agent, candidate.task, 'queue').catch(() => {})
      await settleLaunch()
    }
  }

  /** One pass over the active profile's queues: start whatever may start. */
  async function pass(passScope: RunScope, passEpoch: number): Promise<void> {
    if (passEpoch !== epoch || quitting) return
    const agents = await deps.agents(passScope)
    if (passEpoch !== epoch || quitting) return
    const userId = passScope.profileUserId
    const answers = storedAnswers(userId)
    // An answer stored for an agent that can no longer work a queue (disabled,
    // its folder gone) would wait forever: cleared, so its card offers the
    // question again, and answered then it goes straight to the chat.
    const present = new Set(agents.map((agent) => agent.id))
    for (const [agentId, stored] of answers) {
      if (present.has(agentId)) continue
      for (const ask of stored) {
        try { taskInputRequestRepo.dropQueuedAnswer(ask.id, ask.queuedAt!, NOT_DISPATCHABLE_ANSWER) } catch (error) {
          logger.warn('a stored answer could not be cleared', { requestId: ask.id, error: String(error) })
        }
      }
      logger.info('answers stored for an agent that cannot work a queue were cleared', { agentId, count: stored.length })
    }
    for (const agent of agents) {
      if (passEpoch !== epoch || quitting) return
      if (settling(userId, agent.id)) continue
      const row = agentTaskDispatchRepo.get(userId, agent.id)
      if (row.mode === 'up_to') {
        await passWide(passScope, agent, row, answers.get(agent.id) ?? [])
        continue
      }
      // One run at most (Manual and One at a time): any flight counts, a Run
      // next's included. Nothing else in the folder holds the start back.
      if (flightsOf(userId, agent.id).length > 0) continue
      // A stored answer first, in any mode and while paused: the user gave it.
      const answer = answers.get(agent.id)?.[0]
      if (answer) {
        // Its chat still running a turn: wait for it rather than take a slot
        // and fail; the turn closing wakes the next pass. Nothing else starts
        // for this agent meanwhile — the answer is the head of its queue.
        if (!deps.chatRunning(answer.chatId)) void launchAnswer(passScope, agent, answer).catch(() => {})
        continue
      }
      if (row.mode !== 'one' || row.pausedReason) continue
      for (const candidate of candidates(userId, agent.id)) {
        if (candidate.gated) {
          // Ask once per content; the queue moves on meanwhile.
          gateFor(userId, agent.id, candidate.task, false)
          continue
        }
        // As in `passWide`: a task whose chat runs a turn waits for it.
        if (chatBusy(candidate.task)) continue
        void launch(passScope, agent, candidate.task, 'queue').catch(() => {})
        break
      }
    }
    if (passEpoch !== epoch || quitting) return
    announceChanges(userId, agents)
  }

  function wake(): void {
    if (!scope || quitting || wakeTimer) return
    wakeTimer = setTimeout(() => {
      wakeTimer = null
      const current = scope
      if (!current) return
      const passEpoch = epoch
      passes = passes.then(() => pass(current, passEpoch)).catch((error) => {
        logger.warn('a dispatch pass failed', { error: String(error) })
      })
    }, WAKE_DEBOUNCE_MS)
    wakeTimer.unref?.()
  }

  /** Stop queued waits the queue itself started (a Run next keeps its own). */
  function abortQueued(filter: (flight: Flight) => boolean): void {
    for (const flight of flights.values()) {
      if (flight.phase === 'slot' && filter(flight)) flight.controller.abort()
    }
  }

  async function dispatchable(runScope: RunScope, agentId: unknown): Promise<DispatchAgent | null> {
    if (typeof agentId !== 'string' || !agentId) return null
    const agents = await deps.agents(runScope)
    return agents.find((candidate) => candidate.id === agentId) ?? null
  }

  /** A gate was answered: the queue's state and the task (now trusted, or not) changed. */
  function announce(userId: string, gate: TaskDispatchGateRow): void {
    deps.publish(gate.agentId)
    try { taskRunnerBridge.taskChanged(userId, gate.taskId) } catch (error) {
      logger.warn('a task change could not be announced', { taskId: gate.taskId, error: String(error) })
    }
  }

  /** Why an approved task did not start at once, in the card's words. */
  function deferral(result: TaskDispatchRunResult): TaskDispatchGateDeferral {
    if (result.ok) return 'not_eligible'
    switch (result.code) {
      case 'live_turn':
        return 'live_turn'
      case 'slot':
        return 'slot'
      default:
        return 'not_eligible'
    }
  }

  const NOT_DISPATCHABLE = {
    ok: false as const,
    code: 'not_dispatchable' as const,
    message: 'Only an enabled local folder agent can work a task queue.'
  }

  return {
    /** Begin waking for this profile (its activation finished). */
    start(next: RunScope): void {
      this.stop()
      quitting = false
      scope = next
      tick = setInterval(wake, TICK_MS)
      tick.unref?.()
      wake()
    },

    /**
     * Stop waking: a profile switch or sign-out. Runs already under way finish
     * and are settled; only waits for a slot the queue started are abandoned.
     */
    stop(): void {
      epoch += 1
      scope = null
      if (tick) clearInterval(tick)
      tick = null
      if (wakeTimer) clearTimeout(wakeTimer)
      wakeTimer = null
      announced.clear()
      // A stored answer's wait too: it stays stored, and the next start sends it.
      abortQueued((flight) => flight.origin !== 'manual')
    },

    /**
     * Cinna is quitting: settle nothing more. A run still going keeps its
     * persisted in-flight row, and the next boot flags its task.
     */
    shutdown(): void {
      this.stop()
      quitting = true
      abortQueued(() => true)
    },

    wake,

    /**
     * Boot: every run the dispatcher had in flight when Cinna last stopped
     * died with it. Its task is flagged blocked (when it was still running),
     * its queue paused, the in-flight row cleared.
     *
     * So did a resumed turn on a task a queue still owns (an answer to a
     * dispatched ask; it is no flight and has no in-flight row): a task the
     * queue owns that is still running, with no open ask and no live turn, is
     * flagged the same way, its agent's queue paused and the task released.
     */
    recoverInterrupted(): void {
      // Every run in flight, oldest first: an `up_to` queue can have several,
      // and the first keeps the pause (see `pause`).
      for (const row of agentTaskDispatchRepo.listActive()) {
        const taskId = row.taskId
        try {
          const task = taskRepo.getById(row.userId, taskId)
          if (task && !task.deletedAt && task.status === 'in_progress') {
            writeStatus(row.userId, task.id, 'blocked', { dispatchNote: DISPATCH_NOTE_INTERRUPTED })
          }
          if (task) release(row.userId, task.id)
          agentTaskDispatchRepo.clearActive(row.userId, row.agentId, taskId)
          pause(row.userId, row.agentId, 'interrupted', taskId)
          logger.info('a dispatched run was interrupted by quitting; its queue is paused', { agentId: row.agentId, taskId })
        } catch (error) {
          logger.warn('an interrupted dispatched run could not be flagged', { agentId: row.agentId, taskId, error: String(error) })
        }
      }
      for (const task of taskRepo.listDispatchOwned()) {
        const agentId = task.dispatchAgentId
        if (!agentId || task.status !== 'in_progress') continue
        try {
          if (taskInputRequestRepo.listOpenForTask(task.id).length > 0) continue
          if (deps.liveAgentIds(task.userId).includes(agentId)) continue
          writeStatus(task.userId, task.id, 'blocked', { dispatchNote: DISPATCH_NOTE_INTERRUPTED })
          release(task.userId, task.id)
          pause(task.userId, agentId, 'interrupted', task.id)
          logger.info('a resumed dispatched turn was interrupted by quitting; its queue is paused', { agentId, taskId: task.id })
        } catch (error) {
          logger.warn('an interrupted resumed turn could not be flagged', { agentId, taskId: task.id, error: String(error) })
        }
      }
    },

    /**
     * A turn on a task this queue still owns ended — one the dispatcher did
     * not start: the turn a message typed in the chat resumed after a
     * dispatched turn stopped on an ask (`inboxService.endTurn` hands it over).
     * Settled by the same report rule, and the queue pauses the same way. An
     * Inbox answer is not one of these: it is stored and sent as a flight.
     *
     * While it is being settled the agent counts as busy to its queue's own
     * starts; Run next and an approval's start go ahead, as they would on a
     * paused queue — on any task but this one, which no start takes until
     * its settle lands.
     *
     * A typed message is the user's own turn: it holds no runner slot and is
     * not a flight, so it can start beside any dispatched run, as any typed
     * message can.
     */
    settleOwnedTurn(end: DispatchOwnedTurnEnd): void {
      if (quitting) return
      const row = taskRepo.getById(end.userId, end.taskId)
      if (!row || row.deletedAt || row.dispatchAgentId !== end.agentId) return
      // Busy until settled, synchronously: the wake the turn's close sends
      // must not start the next task before this one's pause is written.
      // The task too: a Run next or an approval may not take it meanwhile.
      const key = flightKey(end.userId, end.agentId)
      const taskKey = taskSettleKey(end.userId, end.taskId)
      settlingOwned.set(key, (settlingOwned.get(key) ?? 0) + 1)
      settlingTasks.set(taskKey, (settlingTasks.get(taskKey) ?? 0) + 1)
      void settleTask(end.userId, end.agentId, end.taskId, { state: end.state, error: end.error })
        .catch((error) => logger.warn('a resumed dispatched turn could not be settled', { taskId: end.taskId, error: String(error) }))
        .finally(() => {
          const left = (settlingOwned.get(key) ?? 1) - 1
          if (left > 0) settlingOwned.set(key, left)
          else settlingOwned.delete(key)
          const leftOnTask = (settlingTasks.get(taskKey) ?? 1) - 1
          if (leftOnTask > 0) settlingTasks.set(taskKey, leftOnTask)
          else settlingTasks.delete(taskKey)
          deps.publish(end.agentId)
          wake()
        })
    },

    /**
     * Whether a flight holds this task (still waiting for its slot, or
     * running), or its last owned turn is being settled: no one else may take
     * it on (`tasks_report`'s attach asks this).
     */
    holdsTask(userId: string, taskId: string): boolean {
      return held(userId, taskId) || settlingTask(userId, taskId)
    },

    async list(runScope: RunScope): Promise<AgentDispatchState[]> {
      const agents = await deps.agents(runScope)
      return agents.map((agent) => stateFor(runScope.profileUserId, agent))
    },

    async get(runScope: RunScope, agentId: unknown): Promise<AgentDispatchState | null> {
      const found = await dispatchable(runScope, agentId)
      return found ? stateFor(runScope.profileUserId, found) : null
    },

    /** `maxRuns` is N for `up_to` (2–8; `invalid_input` otherwise) and ignored for the other modes. */
    async setMode(runScope: RunScope, agentId: unknown, mode: TaskDispatchMode, maxRuns?: unknown): Promise<TaskDispatchUpdateResult> {
      if (mode === 'up_to' && !isTaskDispatchMaxRuns(maxRuns)) {
        return { ok: false, code: 'invalid_input', message: `Choose from ${TASK_DISPATCH_MAX_RUNS.min} to ${TASK_DISPATCH_MAX_RUNS.max} tasks at once.` }
      }
      const found = await dispatchable(runScope, agentId)
      if (!found) return NOT_DISPATCHABLE
      const before = agentTaskDispatchRepo.get(runScope.profileUserId, found.id)
      const after = agentTaskDispatchRepo.setMode(runScope.profileUserId, found.id, mode, mode === 'up_to' ? maxRuns as number : null)
      // The queue's own waits for a slot that the new mode no longer wants:
      // all of them for Manual, and any beyond a tighter limit (fewer runs).
      // The next pass starts what it should.
      const tighter = mode === 'manual' || limitOf(after) < limitOf(before)
      if (tighter) {
        abortQueued((flight) => flight.origin === 'queue' && flight.userId === runScope.profileUserId && flight.agentId === found.id)
      }
      deps.publish(found.id)
      wake()
      return { ok: true, state: stateFor(runScope.profileUserId, found) }
    },

    /** Clear the pause; the flagged task stays where it is until the user moves it. */
    async resume(runScope: RunScope, agentId: unknown): Promise<TaskDispatchUpdateResult> {
      const found = await dispatchable(runScope, agentId)
      if (!found) return NOT_DISPATCHABLE
      agentTaskDispatchRepo.resume(runScope.profileUserId, found.id)
      deps.publish(found.id)
      wake()
      return { ok: true, state: stateFor(runScope.profileUserId, found) }
    },

    /**
     * Run one task now, in any mode and while paused (which it does not
     * clear): `taskId` when it is eligible, else the top of the queue — an
     * answer stored for this queue first, which it sends. A task waiting on
     * approval answers with its card instead of running.
     *
     * The user's own start: it ignores the agent's count and goes beside
     * whatever the agent already runs — its other tasks, a chat, an owned
     * turn being settled on another task (whose pause it would ignore
     * anyway). It still waits for nothing: a task already starting, a task
     * whose own last turn is still being settled, the task's own chat running
     * a turn, or no free runner slot is a refusal.
     */
    async runNext(runScope: RunScope, agentId: unknown, taskId?: unknown, options: { startedBy?: 'user' } = {}): Promise<TaskDispatchRunResult> {
      if (taskId !== undefined && taskId !== null && (typeof taskId !== 'string' || !taskId)) {
        return { ok: false, code: 'invalid_input', message: 'That task id is not valid.' }
      }
      const found = await dispatchable(runScope, agentId)
      if (!found) return NOT_DISPATCHABLE
      const agent = found
      const userId = runScope.profileUserId
      if (typeof taskId === 'string' && held(userId, taskId)) {
        return { ok: false, code: 'not_eligible', message: 'This task is already starting.' }
      }
      // An answer stored for this queue is its head: Run next sends it rather
      // than start a new task. One that is no longer waiting falls through.
      const answer = typeof taskId === 'string' ? undefined
        : storedAnswers(userId).get(agent.id)?.find((stored) => !held(userId, stored.taskId) && !settlingTask(userId, stored.taskId))
      if (answer) {
        if (deps.chatRunning(answer.chatId)) {
          return { ok: false, code: 'live_turn', message: 'This task’s conversation is still finishing its turn. Try again when it finishes.' }
        }
        if (!deps.slotFree()) {
          return { ok: false, code: 'slot', message: 'Every task runner slot is busy. Try again when a run finishes.' }
        }
        try {
          const start = await launchAnswer(runScope, agent, answer, true)
          return { ok: true, taskId: answer.taskId, chatId: start.chatId }
        } catch (error) {
          if (error instanceof LiveTurnError) return { ok: false, code: 'live_turn', message: error.message }
          if (!(error instanceof NoLongerEligibleError)) {
            return { ok: false, code: 'start_failed', message: error instanceof Error ? error.message : 'The answer could not be sent.' }
          }
        }
      }
      const list = candidates(userId, agent.id)
      let choice: Candidate | undefined
      if (typeof taskId === 'string') {
        choice = list.find((candidate) => candidate.task.id === taskId)
        if (!choice) {
          const row = taskRepo.getById(userId, taskId)
          const reason = row && !row.deletedAt ? refusal(userId, taskService.getById(userId, taskId), agent.id) : 'This task is gone.'
          return { ok: false, code: 'not_eligible', message: reason ?? 'This task cannot run now.' }
        }
      } else {
        choice = list.find((candidate) => !candidate.gated && !chatBusy(candidate.task)) ??
          list.find((candidate) => !candidate.gated) ?? list[0]
      }
      if (!choice) return { ok: false, code: 'nothing_eligible', message: 'This agent has no Ready task that can run now.' }
      if (!choice.gated && chatBusy(choice.task)) {
        return { ok: false, code: 'live_turn', message: 'This task’s conversation is still running a turn. Try again when it finishes.' }
      }
      if (choice.gated) {
        const gate = gateFor(userId, agent.id, choice.task, true)
        if (gate) return { ok: true, gate: gate.id }
        return { ok: false, code: 'not_eligible', message: 'This task’s file could not be read.' }
      }
      if (!deps.slotFree()) {
        return { ok: false, code: 'slot', message: 'Every task runner slot is busy. Try again when a run finishes.' }
      }
      try {
        const start = await launch(runScope, agent, choice.task, 'manual', { startedByUser: options.startedBy === 'user', explicit: true })
        return { ok: true, taskId: choice.task.id, chatId: start.chatId }
      } catch (error) {
        if (error instanceof LiveTurnError) return { ok: false, code: 'live_turn', message: error.message }
        if (error instanceof NoLongerEligibleError) return { ok: false, code: 'not_eligible', message: error.message }
        return { ok: false, code: 'start_failed', message: error instanceof Error ? error.message : 'The task could not be started.' }
      }
    },

    /**
     * The Inbox answer to an outside-content approval. Approve trusts exactly
     * the content the card showed and runs the task at once, as Run next does
     * (beside whatever the agent already runs), unless its chat is running a
     * turn or no runner slot is free — then it is simply eligible now; Skip
     * leaves it untrusted, and no card is asked again for the same content.
     */
    async answerGate(runScope: RunScope, gateId: unknown, action: TaskDispatchGateAction): Promise<TaskDispatchGateResult> {
      const userId = runScope.profileUserId
      const gate = typeof gateId === 'string' ? taskDispatchGateRepo.getById(userId, gateId) : undefined
      if (!gate) return { ok: false, code: 'no_longer_waiting', reason: 'This approval is no longer waiting.' }
      if (gate.status !== 'open') return { ok: false, code: 'already_answered', reason: 'This approval has already been answered.' }
      const row = taskRepo.getById(userId, gate.taskId)
      if (!row || row.deletedAt) {
        taskDispatchGateRepo.settle(userId, gate.id, 'superseded')
        return { ok: false, code: 'no_longer_waiting', reason: 'This task is gone.' }
      }
      if (row.localFile?.digest !== gate.digest) {
        taskDispatchGateRepo.settle(userId, gate.id, 'superseded')
        deps.publish(gate.agentId)
        wake()
        return { ok: false, code: 'changed', reason: 'The task file changed since this was asked. A new approval will show what it says now.' }
      }
      const mode = agentTaskDispatchRepo.get(userId, gate.agentId).mode
      if (action === 'skip') {
        taskDispatchGateRepo.settle(userId, gate.id, 'skipped')
        announce(userId, gate)
        return { ok: true, started: null, mode }
      }
      if (!taskDispatchGateRepo.settle(userId, gate.id, 'approved')) {
        return { ok: false, code: 'already_answered', reason: 'This approval has already been answered.' }
      }
      try {
        await deps.trust(userId, gate.taskId, gate.digest)
      } catch (error) {
        logger.warn('approved content could not be recorded as trusted', { taskId: gate.taskId, error: String(error) })
        taskDispatchGateRepo.reopen(userId, gate.id)
        return { ok: false, code: 'unavailable', reason: 'The approval could not be saved. Try again.' }
      }
      // As an explicit Run next: in any mode and while paused (not resuming).
      const result = await this.runNext(runScope, gate.agentId, gate.taskId)
      announce(userId, gate)
      wake()
      if (result.ok && 'chatId' in result) return { ok: true, started: { taskId: result.taskId, chatId: result.chatId }, mode }
      const reason = deferral(result)
      logger.info('an approved task did not start at once', { taskId: gate.taskId, reason })
      return { ok: true, started: null, reason, mode }
    }
  }
}

export type TaskDispatchService = ReturnType<typeof createTaskDispatchService>

// ---------------------------------------------------------------------------
// The production wiring
// ---------------------------------------------------------------------------

function productionDeps(): TaskDispatchDeps {
  return {
    async agents(runScope) {
      // Imported on first use: the local-agent stack is large and loads
      // behind everything that reaches a task otherwise.
      const { localAgentService } = await import('./localAgents/localAgentService')
      return localAgentService.list(runScope.settingsUserId).agents
        .filter((agent) => !!agent.path && (agentOverrideRepo.get(runScope.profileUserId, agent.id)?.enabled ?? agent.enabled))
        .map((agent) => ({ id: agent.id, name: agent.name, path: agent.path }))
    },
    async start(runScope, taskId, agentId, options) {
      const result = await taskExecutionService.start(runScope, taskId, { kind: 'agent', agentId }, {
        continueInChat: options.continueInChat,
        onRunAccepted: options.onRunAccepted,
        ...(options.startedBy ? { startedBy: options.startedBy } : {})
      })
      return { chatId: result.chatId, runId: result.runId, completed: result.completed }
    },
    async resume(runScope, ask, content, options) {
      const handle = inboxService.startNextMessageTurn(runScope, ask, content, (ctx) => {
        if (ctx.turnId) options.onRunAccepted({ chatId: ask.chatId, runId: ctx.turnId })
      })
      await handle.accepted
      return { chatId: ask.chatId, runId: handle.id, completed: handle.completed }
    },
    chatRunning: (chatId) => runExecutionService.isRunning(chatId),
    withSlot: (agentId, signal, run) => withRuntimeAgent(agentId, signal, run),
    slotFree: () => runtimeAgentSlotFree(),
    async trust(userId, taskId, digest) {
      const { taskSyncService } = await import('./taskSyncService')
      await taskSyncService.trustLocalContent(userId, taskId, digest)
    },
    async refreshTask(userId, taskId) {
      const { taskSyncService } = await import('./taskSyncService')
      await taskSyncService.pullFresh(userId, taskId)
    },
    liveAgentIds,
    publish(agentId) {
      publishEvent(TASK_DISPATCH_CHANGED_CHANNEL, { agentId })
    }
  }
}

export const taskDispatchService = createTaskDispatchService(productionDeps())

/** Any task write may make a task Ready or finish a blocker. */
installTaskRunnerHooks(
  {
    answer: () => null,
    taskChanged: () => taskDispatchService.wake(),
    chatRemoved: () => {},
    profileRemoved: () => {}
  },
  'task-dispatch'
)

/** A later turn on a task a queue still owns (after an ask) ends by the report rule. */
setDispatchOwnedTurnSettler((end) => taskDispatchService.settleOwnedTurn(end))

/** An answer stored for a queue is sent by the next pass. */
setDispatchWake(() => taskDispatchService.wake())

/** A task a flight holds is no conversation's to take on. */
setDispatchHoldsTask((userId, taskId) => taskDispatchService.holdsTask(userId, taskId))

/**
 * The agents of this profile that can work a queue now: the dispatcher's own
 * list, so a disabled agent or one whose folder is gone drops out.
 */
export async function dispatchableAgentIds(userId: string): Promise<ReadonlySet<string>> {
  const agents = await productionDeps().agents({ profileUserId: userId, settingsUserId: getSettingsScopeUserId() })
  return new Set(agents.map((agent) => agent.id))
}

/** The Inbox lists a paused queue only for an agent that can still work one. */
setDispatchableAgentsSource(dispatchableAgentIds)

/** An answer waiting for its queue names the agent, and N when it runs Up to N. */
setDispatchQueuesSource(async (userId) => {
  const agents = await productionDeps().agents({ profileUserId: userId, settingsUserId: getSettingsScopeUserId() })
  return new Map(agents.map((agent) => [agent.id, dispatchQueueOf(userId, agent)]))
})

/** A turn letting go of its chat may free a task's chat, or an answer's, the queue was waiting on. */
onRunClosed(() => taskDispatchService.wake())
/** A turn taking a chat may take a Ready task's chat: the queue's announced state moves. */
onRunOpened(() => taskDispatchService.wake())
