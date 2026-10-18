import { useCallback, useEffect, useRef, useState } from 'react'
import { useQuery, useQueryClient, type QueryClient, type UseQueryResult } from '@tanstack/react-query'
import { useUIStore } from '../stores/ui.store'
import { INBOX_QUERY_KEY } from './useInbox'
import { unwrapIpcError } from '../utils/ipcError'
import { TASK_DISPATCH_MAX_RUNS } from '../../../shared/taskDispatch'
import type {
  AgentDispatchState,
  TaskDispatchMode,
  TaskDispatchPauseReason,
  TaskDispatchRefusalCode,
  TaskDispatchRunResult,
  TaskDispatchWaiting
} from '../../../shared/taskDispatch'
import type { TaskDispatchGateAction, TaskDispatchGateResult } from '../../../shared/inbox'

/**
 * An agent's task queue (the task dispatcher in main): its run mode, its
 * pause, and Run next.
 *
 * Main decides everything; this module reads what it decided and asks it to
 * do things. Refusals come back as data (`ok: false` with main's sentence) and
 * a rejected call is unwrapped with `unwrapIpcError`, so every surface shows
 * the user's words beside the control that was pressed (`ux_rules.md` §6).
 *
 * Kept fresh by main's `taskDispatch:changed` push alone (plus a re-read when
 * the window regains focus), with no poll: main publishes every change of a
 * queue's state, including the ones its queue did not cause — a task the user
 * moves to Ready, a file an editor saves, a turn opening in the folder — by
 * comparing each agent's state after every dispatch pass.
 */
export const TASK_DISPATCH_KEY = ['task-dispatch'] as const
const LIST_KEY = ['task-dispatch', 'list'] as const
const AGENT_KEY = (agentId: string): readonly unknown[] => ['task-dispatch', 'agent', agentId]

/**
 * Everything a dispatch change can move: the queues, the task rows, every
 * open task page (`['task', id]`, so a page updates without waiting for its
 * own read), the Inbox cards.
 */
export function refreshAfterDispatch(queryClient: QueryClient): void {
  void queryClient.invalidateQueries({ queryKey: TASK_DISPATCH_KEY })
  void queryClient.invalidateQueries({ queryKey: ['tasks'] })
  void queryClient.invalidateQueries({ queryKey: ['task'] })
  void queryClient.invalidateQueries({ queryKey: INBOX_QUERY_KEY })
}

/** Re-read on main's push. One listener per mounted reader; each unsubscribes on unmount. */
function useDispatchChanges(): void {
  const queryClient = useQueryClient()
  useEffect(() => window.api.taskDispatch.onChanged(() => refreshAfterDispatch(queryClient)), [queryClient])
}

/** Every dispatchable agent's queue — enabled local folder agents, bare and kit. */
export function useTaskDispatchList(): UseQueryResult<AgentDispatchState[]> {
  useDispatchChanges()
  return useQuery({
    queryKey: LIST_KEY,
    queryFn: () => window.api.taskDispatch.list(),
    refetchOnWindowFocus: true,
    retry: 1
  })
}

/** One agent's queue; `null` for an agent that cannot work one (a disabled folder agent). */
export function useAgentDispatch(agentId: string | null): UseQueryResult<AgentDispatchState | null> {
  useDispatchChanges()
  return useQuery({
    queryKey: AGENT_KEY(agentId ?? ''),
    queryFn: () => window.api.taskDispatch.get(agentId as string),
    enabled: !!agentId,
    refetchOnWindowFocus: true,
    retry: 1
  })
}

/** Open the Inbox on one dispatcher approval: it scrolls to the card and marks it once. */
export function useOpenInboxGate(): (gateId: string) => void {
  const queryClient = useQueryClient()
  const setReveal = useUIStore((s) => s.setRevealInboxGateId)
  const setActiveView = useUIStore((s) => s.setActiveView)
  return useCallback(
    (gateId: string) => {
      // The card may be newer than the Inbox's last read.
      void queryClient.invalidateQueries({ queryKey: INBOX_QUERY_KEY })
      setReveal(gateId)
      setActiveView('inbox')
    },
    [queryClient, setReveal, setActiveView]
  )
}

export type DispatchAction = 'mode' | 'resume' | 'run'

type Refusal = { code: TaskDispatchRefusalCode; message: string }

/**
 * The three things a user does to a queue, owned by the surface that shows
 * the queue — the agent's Tasks tab, the Tasks view, the task page — and never
 * by the menu or row that triggers them, so a result is never dropped with a
 * popover that closed on the way (`ux_rules.md` §5).
 *
 * `error` names the action it belongs to and the agent it was for, so each
 * surface shows it beside the control that was pressed and a refusal for one
 * agent is not shown under another.
 *
 * Run next: a started task stays where it is (its row moves to In progress by
 * itself) unless `onStarted` says otherwise; `{ gate }` opens the Inbox on the
 * approval it is waiting for.
 */
export function useDispatchControls(
  agentId: string | null,
  options: { onStarted?: (started: { taskId: string; chatId: string }) => void } = {}
): {
  /** Each resolves true when main did it, false on a refusal or failure (shown in `error`). `maxRuns` is N for `up_to`. */
  setMode: (mode: TaskDispatchMode, maxRuns?: number) => Promise<boolean>
  resume: () => Promise<boolean>
  runNext: (taskId?: string) => Promise<boolean>
  pending: DispatchAction | null
  /** The mode being saved, so a select shows the choice rather than snapping back. */
  pendingMode: TaskDispatchMode | null
  /** The N being saved with `up_to`, for the same reason. */
  pendingMaxRuns: number | null
  /** `code` is main's refusal code, or null for a failed call. */
  error: { action: DispatchAction; code: TaskDispatchRefusalCode | null; message: string } | null
  clearError: () => void
} {
  const queryClient = useQueryClient()
  const openGate = useOpenInboxGate()
  const [pending, setPending] = useState<DispatchAction | null>(null)
  const [pendingMode, setPendingMode] = useState<TaskDispatchMode | null>(null)
  const [pendingMaxRuns, setPendingMaxRuns] = useState<number | null>(null)
  const [error, setError] = useState<{
    agentId: string
    action: DispatchAction
    code: TaskDispatchRefusalCode | null
    message: string
  } | null>(null)
  const pendingRef = useRef(false)
  const onStarted = options.onStarted

  const run = useCallback(
    async (action: DispatchAction, call: () => Promise<Refusal | null>, fallback: string): Promise<boolean> => {
      if (!agentId || pendingRef.current) return false
      pendingRef.current = true
      setPending(action)
      setError(null)
      try {
        const refusal = await call()
        if (refusal) setError({ agentId, action, code: refusal.code, message: refusal.message })
        return !refusal
      } catch (cause) {
        setError({ agentId, action, code: null, message: unwrapIpcError(cause, fallback) })
        return false
      } finally {
        pendingRef.current = false
        setPending(null)
        setPendingMode(null)
        setPendingMaxRuns(null)
      }
    },
    [agentId]
  )

  const setMode = useCallback(
    async (mode: TaskDispatchMode, maxRuns?: number): Promise<boolean> => {
      if (!agentId || pendingRef.current) return false
      setPendingMode(mode)
      setPendingMaxRuns(mode === 'up_to' ? maxRuns ?? null : null)
      return run('mode', async () => {
        const result = mode === 'up_to'
          ? await window.api.taskDispatch.setMode(agentId as string, mode, maxRuns)
          : await window.api.taskDispatch.setMode(agentId as string, mode)
        if (!result.ok) return result
        queryClient.setQueryData(AGENT_KEY(result.state.agentId), result.state)
        refreshAfterDispatch(queryClient)
        return null
      }, 'The run mode could not be saved.')
    },
    [agentId, queryClient, run]
  )

  const resume = useCallback(
    () =>
      run('resume', async () => {
        const result = await window.api.taskDispatch.resume(agentId as string)
        if (!result.ok) return result
        queryClient.setQueryData(AGENT_KEY(result.state.agentId), result.state)
        refreshAfterDispatch(queryClient)
        return null
      }, 'The queue could not be resumed.'),
    [agentId, queryClient, run]
  )

  const runNext = useCallback(
    (taskId?: string) =>
      run('run', async () => {
        const result: TaskDispatchRunResult = taskId === undefined
          ? await window.api.taskDispatch.runNext(agentId as string)
          : await window.api.taskDispatch.runNext(agentId as string, taskId)
        if (!result.ok) return result
        refreshAfterDispatch(queryClient)
        if ('gate' in result) openGate(result.gate)
        else {
          void queryClient.invalidateQueries({ queryKey: ['chats'] })
          onStarted?.({ taskId: result.taskId, chatId: result.chatId })
        }
        return null
      }, 'The next task could not be started.'),
    [agentId, onStarted, openGate, queryClient, run]
  )

  const clearError = useCallback(() => setError(null), [])

  return {
    setMode,
    resume,
    runNext,
    pending,
    pendingMode,
    pendingMaxRuns,
    error: error && error.agentId === agentId ? { action: error.action, code: error.code, message: error.message } : null,
    clearError
  }
}

/**
 * Answer a dispatcher approval from the Inbox. Returns main's result as data;
 * a rejected call is turned into a `{ ok: false }` with the unwrapped sentence
 * so the card has one shape to branch on.
 */
export function useAnswerDispatchGate(): (gateId: string, action: TaskDispatchGateAction) => Promise<TaskDispatchGateResult> {
  const queryClient = useQueryClient()
  return useCallback(
    async (gateId: string, action: TaskDispatchGateAction): Promise<TaskDispatchGateResult> => {
      let result: TaskDispatchGateResult
      try {
        result = await window.api.inbox.answerDispatchGate(gateId, action)
      } catch (cause) {
        return { ok: false, code: 'unavailable', reason: unwrapIpcError(cause, 'That answer could not be saved.') }
      }
      refreshAfterDispatch(queryClient)
      return result
    },
    [queryClient]
  )
}

// ---------------------------------------------------------------------------
// The words, in one place: the agent page, the Tasks view and the Inbox say
// the same thing about the same queue.
// ---------------------------------------------------------------------------

export const DISPATCH_MODE_LABELS: Record<TaskDispatchMode, string> = {
  manual: 'Manual',
  one: 'One at a time',
  up_to: 'Up to N'
}

/** The mode with its N filled in ("Up to 3"), for a title that names the current mode. */
export function dispatchModeLabel(mode: TaskDispatchMode, maxRuns: number | null): string {
  return mode === 'up_to' && maxRuns != null ? `Up to ${maxRuns}` : DISPATCH_MODE_LABELS[mode]
}

/** The N choices of Up to N, in order. */
export const DISPATCH_MAX_RUNS_CHOICES: readonly number[] = Array.from(
  { length: TASK_DISPATCH_MAX_RUNS.max - TASK_DISPATCH_MAX_RUNS.min + 1 },
  (_, index) => TASK_DISPATCH_MAX_RUNS.min + index
)

/** What happened to the task a queue paused on, after its title. */
const PAUSE_ENDINGS: Record<TaskDispatchPauseReason, string> = {
  unreported: 'ended without reporting',
  error: 'failed',
  stopped: 'was stopped',
  interrupted: 'was interrupted when Cinna quit'
}

/**
 * "Paused — <task> ended without reporting", split so a surface can make the
 * title a link: `lead` + title + `tail`. A pause with no task names "the last
 * task" rather than leaving a hole.
 */
export function dispatchPausedParts(paused: NonNullable<AgentDispatchState['paused']>): {
  lead: string
  title: string
  taskId: string | null
  tail: string
} {
  return {
    lead: 'Paused — ',
    title: paused.taskTitle ?? 'the last task',
    taskId: paused.taskTitle ? paused.taskId : null,
    tail: ` ${PAUSE_ENDINGS[paused.reason]}`
  }
}

export function dispatchPausedText(paused: NonNullable<AgentDispatchState['paused']>): string {
  const parts = dispatchPausedParts(paused)
  return `${parts.lead}${parts.title}${parts.tail}`
}

const WAITING_TEXT: Record<TaskDispatchWaiting, string> = {
  slot: 'Waiting for a runner slot',
  gate: 'Waiting for approval in the Inbox'
}

/**
 * The queue's one status line, true in every state: running, waiting, next,
 * or nothing to do. `task` is the task the line names, for a link, and
 * `tail` what follows it ("— needs approval" for a next task whose content
 * waits on the Inbox; Run next opens that approval).
 */
export function dispatchStatusParts(state: AgentDispatchState): {
  text: string
  task: { id: string; title: string } | null
  tail: string
} {
  const running = state.running
  if (running.length > 0) {
    // Up to N says how full it is, and still names a lone run; a wait for a
    // slot beside the runs is said after them. Run next starts beyond the
    // count, so a queue can run more than its N, or more than one.
    const slot = state.waiting === 'slot' ? ' · waiting for a runner slot' : ''
    if (running.length > 1) {
      const text = state.maxRuns != null && running.length <= state.maxRuns
        ? `Running ${running.length} of ${state.maxRuns}`
        : `Running ${running.length} tasks`
      return { text: `${text}${slot}`, task: null, tail: '' }
    }
    const of = state.maxRuns != null ? ` · 1 of ${state.maxRuns}` : ''
    return { text: 'Running ', task: { id: running[0].taskId, title: running[0].title }, tail: `${of}${slot}` }
  }
  if (state.waiting) return { text: WAITING_TEXT[state.waiting], task: null, tail: '' }
  if (state.next) {
    return {
      text: 'Next: ',
      task: { id: state.next.taskId, title: state.next.title },
      tail: state.next.needsApproval ? ' — needs approval' : ''
    }
  }
  return { text: 'No Ready tasks', task: null, tail: '' }
}

/**
 * What an answered approval settled as, in the card that asked. Approve
 * starts the task beside whatever its agent already runs; one main could not
 * start right away says when it will — on its own in One at a time and Up to
 * N, by Run next in Manual — and what it waits for: the task's own
 * conversation finishing its turn, or a runner slot; or not yet when it is
 * not Ready.
 */
export function dispatchGateSettledText(
  action: TaskDispatchGateAction,
  result: TaskDispatchGateResult & { ok: true }
): string {
  if (action === 'skip') return 'Skipped. The queue passes over this task until its file changes.'
  if (result.started) return 'Approved. The task is running.'
  const when = result.mode === 'manual' ? 'Use Run next when' : 'It starts when'
  switch (result.reason) {
    case 'live_turn':
      return `Approved. ${when} the task’s conversation finishes its turn.`
    case 'slot':
      return `Approved. ${when} a task runner slot is free.`
    default:
      return 'Approved. It is not ready to run yet.'
  }
}
