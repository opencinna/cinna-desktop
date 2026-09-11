import { useCallback, useState } from 'react'
import { useQuery, useQueryClient, type UseQueryResult } from '@tanstack/react-query'
import { useChatStore } from '../stores/chat.store'
import { useUIStore } from '../stores/ui.store'
import { useChatStream } from './useChatStream'
import { INBOX_QUERY_KEY } from './useInbox'
import { unwrapIpcError } from '../utils/ipcError'
import type { DesktopTaskTarget, TaskDto } from '../../../shared/tasks'
import type { TaskStatus } from '../../../shared/taskStatus'

/**
 * One task, and the two things a user can do to one from the task view.
 *
 * A task outlives the chat it ran in and the run that produced it, so its page
 * is the one surface that can still say what the work was after everything
 * around it has been closed. Everything here reads `window.api.tasks.*`; the
 * asks waiting on it come from the inbox's own list (`useInbox`), so the page
 * and the sidebar badge can never disagree about what is waiting.
 */
export const TASK_QUERY_KEY = (taskId: string): readonly unknown[] => ['task', taskId]

const POLL_MS = 5_000

/**
 * A task that is still moving is re-read; a settled one is not.
 *
 * `blocked` polls too, and that is the case that matters: the ask it is waiting
 * on is answered somewhere else entirely — in the inbox, or in the transcript —
 * and this page has no way to hear about it except by asking again.
 */
function isSettled(status: TaskStatus): boolean {
  return (
    status === 'completed' ||
    status === 'error' ||
    status === 'cancelled' ||
    status === 'archived'
  )
}

export function useTask(taskId: string | null): UseQueryResult<TaskDto> {
  return useQuery({
    queryKey: TASK_QUERY_KEY(taskId ?? ''),
    queryFn: () => window.api.tasks.get(taskId as string),
    enabled: !!taskId,
    refetchInterval: (query) => {
      const data = query.state.data
      if (!data) return POLL_MS
      return data.remote || !isSettled(data.status) ? POLL_MS : false
    },
    // One retry, not three: the page polls anyway, and three silent retries
    // only delay the sentence that tells the user the read failed.
    retry: 1
  })
}

/** Open a task's page. The sidebar tab is deliberately left where it was. */
export function useOpenTask(): (taskId: string) => void {
  const setActiveTaskId = useUIStore((s) => s.setActiveTaskId)
  const setActiveView = useUIStore((s) => s.setActiveView)
  return useCallback(
    (taskId: string) => {
      setActiveTaskId(taskId)
      setActiveView('task')
    },
    [setActiveTaskId, setActiveView]
  )
}

/** Main persists and dispatches once; this hook only displays the accepted run. */
export function useStartTask() {
  const queryClient = useQueryClient()
  const [isPending, setPending] = useState(false)
  const setActiveChatId = useChatStore((state) => state.setActiveChatId)
  const setActiveView = useUIStore((state) => state.setActiveView)
  const start = useCallback(async (taskId: string, target: DesktopTaskTarget): Promise<void> => {
    setPending(true)
    try {
      const result = await window.api.tasks.start(taskId, target).catch((error) => {
        throw new Error(unwrapIpcError(error, 'This task could not be started.'))
      })
      queryClient.setQueryData(TASK_QUERY_KEY(taskId), result.task)
      void queryClient.invalidateQueries({ queryKey: ['chats'] })
      void queryClient.invalidateQueries({ queryKey: ['chat', result.chatId] })
      void queryClient.invalidateQueries({ queryKey: INBOX_QUERY_KEY })
      setActiveChatId(result.chatId)
      setActiveView('chat')
    } finally { setPending(false) }
  }, [queryClient, setActiveChatId, setActiveView])
  return { start, isPending }
}

export const REMOTE_LIVE_QUERY_KEY = (taskId: string | null): readonly unknown[] => [
  'task-remote-live',
  taskId
]

/**
 * How long the probe is allowed to take before "cannot tell" is the answer.
 *
 * **A request that never comes back is not the same as a slow one, and the
 * banner cannot tell them apart** — while the query is in flight it shows the
 * same shape as a service that answered "an agent is working on it": a sentence
 * and no control. Measured by the UX review at six seconds against a stubbed
 * hang, pixel-identical to the genuinely-live frame. So the user reads a
 * definite statement about somebody else's agent from a request that silently
 * never returned, and has no way to take the task back.
 *
 * It is reachable without a stub: the adapter's HTTP path has no `AbortSignal`
 * and no timeout of its own, so a black-holed connection holds it for the OS
 * connect timeout or longer. That is worth fixing in the adapter and it is not
 * this step's; this is the deadline the *question* has, which is a different
 * thing — five seconds is far longer than an answer takes and far shorter than
 * a person will wait before deciding the app is stuck.
 */
const LIVE_PROBE_MS = 5_000

/** The probe's answer, or `null` — "cannot tell" — if it takes too long. */
function withDeadline(probe: Promise<boolean | null>): Promise<boolean | null> {
  return Promise.race([
    probe,
    new Promise<null>((resolve) => setTimeout(() => resolve(null), LIVE_PROBE_MS))
  ])
}

/**
 * Is an agent working on this task in the service that holds it, right now?
 *
 * Asked **once**, when a remote task's page opens, and deliberately not on the
 * page's five-second poll: it is a network round trip to somebody else's server
 * and the answer only decides whether one control is on screen. `null` is a
 * real answer — nobody can tell — and §5.10 turns it into a confirmation rather
 * than a refusal.
 *
 * `undefined` while it is in flight, which is a fourth state and the reason the
 * banner reserves its control's box rather than growing into it: the shape of
 * that box must not change under a pointer already on its way (`ux_rules.md`
 * §1).
 *
 * It is not the authority. `tasks.takeOver` asks again on the far side of the
 * gesture, because an agent can start in the seconds between this answer and
 * the press.
 */
export function useRemoteLiveSession(task: TaskDto | null): UseQueryResult<boolean | null> {
  // **Any task a service is executing, bound or not.** A replica can lose its
  // binding and keep `executor: 'remote'` — `unbindRemote` fires when a service
  // answers "not yours", and it does not move the executor — and gating on
  // `task.remote` here left that task's page showing "running in the service
  // that holds it" with no control for ever, because the query never ran and
  // the banner reads a query that never resolves as still in flight. Main
  // answers `false` for it without touching a network, which is the truthful
  // answer: there is no service that could be running it. One rule, in the
  // place that can enforce it.
  const enabled = !!task && task.executor === 'remote'
  return useQuery({
    queryKey: REMOTE_LIVE_QUERY_KEY(task?.id ?? null),
    queryFn: () => withDeadline(window.api.tasks.remoteLive(task!.id)),
    enabled,
    // A service that answered a minute ago has not become a different service.
    // Re-asking is what the take-over itself does, where it matters.
    staleTime: 60_000,
    // **No retry, and that is not a saving — it is the answer arriving sooner.**
    // A rejection here is not a transport failure: `task:remote-live` already
    // swallows every adapter error and answers `null`, and the deadline above
    // turns a hang into `null` too. What is left that can reject is the
    // activation guard or the scope lookup, which a second attempt does not fix.
    // Retrying only holds the banner in its in-flight shape through TanStack's
    // backoff — which is the shape that says "an agent is working on it" — when
    // the honest answer, "cannot tell", is already known.
    retry: false
  })
}

/**
 * Claim a task this device does not currently hold — from another of the user's
 * devices, or from a bound service.
 *
 * It is one write and deliberately nothing else. `executorDevice` moves to this
 * device and the page re-renders with the controls it was refusing to show; it
 * does **not** then start the work. Those are two gestures because they answer
 * two different questions — "this is mine now" and "go" — and running a task
 * the moment somebody claimed it would take the second decision on their
 * behalf, on a task that may be mid-turn somewhere else.
 *
 * §5.4's claim, not a lock: two devices cannot both believe they own a run
 * without one of them having written that it did, and this is that write.
 *
 * `force` carries a confirmation the user gave: §5.10 confirms rather than
 * refuses when the service could not say whether anything was working on the
 * task. A service that says it **is** refuses the claim whatever `force` says.
 */
export function useTakeOverTask(): {
  takeOver: (taskId: string, force?: boolean) => Promise<void>
  isPending: boolean
} {
  const queryClient = useQueryClient()
  const [isPending, setPending] = useState(false)

  const takeOver = useCallback(
    async (taskId: string, force?: boolean): Promise<void> => {
      setPending(true)
      try {
        const task = await window.api.tasks.takeOver(taskId, force).catch((err) => {
          throw new Error(unwrapIpcError(err, 'This task could not be taken over.'))
        })
        // Seed *and* invalidate. The seed replaces the banner the user just
        // pressed straight away rather than a poll later; the re-read is what
        // makes the page agree with main, which is the only copy that matters.
        queryClient.setQueryData(TASK_QUERY_KEY(taskId), task)
        void queryClient.invalidateQueries({ queryKey: TASK_QUERY_KEY(taskId) })
        // The task is this device's now, so nothing is running on it over
        // there. Leaving the probe's answer cached would keep a stale "busy"
        // on screen behind a control that has already moved on.
        void queryClient.invalidateQueries({ queryKey: REMOTE_LIVE_QUERY_KEY(taskId) })
      } finally {
        setPending(false)
      }
    },
    [queryClient]
  )

  return { takeOver, isPending }
}

/**
 * Re-run a task from the last message in its chat.
 *
 * **Why a task needs this at all.** A task can sit `blocked` with nothing in
 * the inbox: an ask whose driver process died — the app was restarted, the ACP
 * child was reaped — is expired by the boot sweep, which settles the row but
 * does not touch the task. Nobody is waiting for an answer and nothing is
 * running, so the task is stuck in a status only a new turn can move it out of.
 * That turn is this: the last thing the user (or the job) said, sent again.
 *
 * It is deliberately **not** "run the job again". A job run creates a new run
 * row and a new task, which is a different gesture with a different record; this
 * one continues the task that is already there, in the chat it already has, so
 * the still-`running` job run finalizes against it when the turn ends.
 *
 * Three things have to be true and each refusal is a sentence rather than a
 * disabled button, because which one it is tells the user something different.
 * Throws that sentence; `TaskView` shows it beside the control (`ux_rules.md`
 * §6).
 */
export function useRerunTask(): {
  rerun: (task: TaskDto) => Promise<void>
  isPending: boolean
} {
  const queryClient = useQueryClient()
  const { startRun } = useChatStream()
  const setActiveChatId = useChatStore((s) => s.setActiveChatId)
  const setActiveView = useUIStore((s) => s.setActiveView)
  const [isPending, setPending] = useState(false)

  const rerun = useCallback(
    async (task: TaskDto): Promise<void> => {
      const chatId = task.chatId
      if (!chatId) throw new Error('This task has no conversation to re-run.')
      setPending(true)
      try {
        // Through the query cache, not straight to the API. `startRun` reads
        // `['chat', chatId]` to snapshot how many user messages are already
        // persisted, and retires its optimistic bubble the moment that count
        // grows past the snapshot — so a cold cache snapshots 0, the chat
        // already has a user turn, and the re-sent message never appears until
        // the refetch 300 ms later. Priming the key the chat view itself uses
        // fixes the bubble and warms the screen we are about to navigate to.
        const chat = await queryClient
          .fetchQuery({
            queryKey: ['chat', chatId],
            queryFn: () => window.api.chat.get(chatId)
          })
          .catch((err) => {
            throw new Error(unwrapIpcError(err, 'That conversation could not be read.'))
          })
        if (!chat) throw new Error('The conversation this task ran in is no longer there.')
        const last = [...chat.messages].reverse().find((m) => m.role === 'user')
        if (!last || !last.content.trim()) {
          throw new Error('There is no message in this conversation to send again.')
        }

        // Before the send, not after: a task that is running has to say so, and
        // a refusal here — the task is running on another device, or has been
        // archived out from under this page — must stop the run rather than
        // leave a turn streaming into a task that disowns it.
        await window.api.tasks.setStatus(task.id, 'in_progress').catch((err) => {
          throw new Error(unwrapIpcError(err, 'This task could not be re-opened.'))
        })
        void queryClient.invalidateQueries({ queryKey: TASK_QUERY_KEY(task.id) })
        void queryClient.invalidateQueries({ queryKey: INBOX_QUERY_KEY })

        // The agent the message went to the first time, which is the one the
        // re-run is addressed to. `assignee.agentId` is the fallback for a chat
        // whose router did not record an address (an LLM-rooted one, where it
        // is null on both).
        const agentId = last.addressedAgentId ?? task.assignee.agentId ?? null

        // Navigate **before** streaming, the way a job run does. The optimistic
        // user bubble `startRun` sets is global rather than per chat, so firing
        // it while a different conversation is on screen would draw the message
        // into that one.
        setActiveChatId(chatId)
        setActiveView('chat')
        startRun(chatId, last.content, {
          attachments: last.attachments ?? undefined,
          target: agentId ? { kind: 'agent', agentId } : { kind: 'model' }
        })
      } finally {
        setPending(false)
      }
    },
    [queryClient, setActiveChatId, setActiveView, startRun]
  )

  return { rerun, isPending }
}
