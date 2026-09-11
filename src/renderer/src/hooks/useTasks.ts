import { useCallback, useState } from 'react'
import { useQuery, useQueryClient, type UseQueryResult } from '@tanstack/react-query'
import { useChatStore } from '../stores/chat.store'
import { useUIStore } from '../stores/ui.store'
import { useChatStream } from './useChatStream'
import { INBOX_QUERY_KEY } from './useInbox'
import { unwrapIpcError } from '../utils/ipcError'
import type { TaskDto } from '../../../shared/tasks'
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
      return isSettled(data.status) ? false : POLL_MS
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
 */
export function useTakeOverTask(): {
  takeOver: (taskId: string) => Promise<void>
  isPending: boolean
} {
  const queryClient = useQueryClient()
  const [isPending, setPending] = useState(false)

  const takeOver = useCallback(
    async (taskId: string): Promise<void> => {
      setPending(true)
      try {
        const task = await window.api.tasks.takeOver(taskId).catch((err) => {
          throw new Error(unwrapIpcError(err, 'This task could not be taken over.'))
        })
        // Seed *and* invalidate. The seed replaces the banner the user just
        // pressed straight away rather than a poll later; the re-read is what
        // makes the page agree with main, which is the only copy that matters.
        queryClient.setQueryData(TASK_QUERY_KEY(taskId), task)
        void queryClient.invalidateQueries({ queryKey: TASK_QUERY_KEY(taskId) })
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
