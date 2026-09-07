import { useCallback, useEffect, useState } from 'react'

/**
 * The permission and question asks a **local** agent is currently parked on.
 *
 * ## Why this is not the `AskUserQuestion` flow
 *
 * A cloud agent's question *ends its turn*: the answer goes back as the next
 * user message, threaded onto the same A2A context, which is why
 * `AskUserQuestionBlock` routes through `useChatComposer`. A local agent's
 * question does not end anything — `POST /prompt` is admitted, the agent loop
 * is running, and it is parked mid-turn on
 * `POST /api/session/{id}/question/{requestID}/reply`. There is no user turn to
 * send, and for a permission there is no sensible one to invent: "Deny" is not
 * a message.
 *
 * So a live request is answered by id, out of band, while the turn streams on.
 *
 * ## Why it polls rather than subscribing
 *
 * The turn's own MessagePort would be the obvious channel and is the wrong one:
 * it exists only for a direct chat, and the identical request can be raised by
 * a folder agent running as an orchestrated tool, where there is no port at
 * all. A short poll while a turn is streaming costs one synchronous main-process
 * map lookup and keeps one code path for both modes. It stops the moment
 * nothing is streaming.
 */
/**
 * What a delivered answer says about itself.
 *
 * Only *Always allow* has anything to report: the grant is written on the main
 * side while the user waits, and `remembered` is false when the store refused
 * the write — the action still goes ahead, and the block must say "allowed
 * once" rather than claim a rule that is not on disk.
 */
export interface AnswerOutcome {
  remembered?: boolean
}

export interface PendingAgentRequest {
  requestId: string
  kind: 'permission' | 'question'
}

const POLL_MS = 700

export function useAgentRequests(
  chatId: string,
  isStreaming: boolean
): {
  pending: PendingAgentRequest[]
  isPending: (requestId: string) => boolean
  answerPermission: (
    requestId: string,
    reply: 'once' | 'always' | 'reject'
  ) => Promise<AnswerOutcome>
  answerQuestion: (requestId: string, answers: string[][]) => Promise<AnswerOutcome>
} {
  const [pending, setPending] = useState<PendingAgentRequest[]>([])

  const refresh = useCallback(async (): Promise<void> => {
    try {
      setPending(await window.api.agents.pendingRequests(chatId))
    } catch {
      // A failed lookup must not blank a prompt the user is mid-way through
      // answering — keep the last known list rather than clearing it.
    }
  }, [chatId])

  useEffect(() => {
    let cancelled = false
    void refresh()
    if (!isStreaming) {
      // One final read after the stream ends, so a request raised in the last
      // moments of a turn is not left invisible until the next one.
      return () => {
        cancelled = true
      }
    }
    const timer = setInterval(() => {
      if (!cancelled) void refresh()
    }, POLL_MS)
    return () => {
      cancelled = true
      clearInterval(timer)
    }
  }, [refresh, isStreaming])

  const answer = useCallback(
    async (data: {
      requestId: string
      reply?: 'once' | 'always' | 'reject'
      answers?: string[][]
    }): Promise<AnswerOutcome> => {
      // The outcome arrives as **data**, not as a rejection: a thrown error
      // loses its code across `ipcMain.handle` and again across
      // `contextBridge`, so branching on one here would silently never fire.
      const result = await window.api.agents.answerRequest(data)
      // **Only a delivered answer clears the request.** This removal used to
      // happen first, and a refused answer then took the buttons with it: the
      // block greyed out, the error line said the request had expired, and
      // there was no way to answer it any other way. A refusal has to leave the
      // controls where they were (`ux_rules.md` §6).
      if (!result.ok) throw new Error(result.reason ?? 'That answer could not be delivered.')
      // Optimistic removal, so the block stops offering buttons immediately
      // rather than at the next poll tick.
      setPending((prev) => prev.filter((p) => p.requestId !== data.requestId))
      return { remembered: result.remembered }
    },
    []
  )

  return {
    pending,
    isPending: useCallback(
      (requestId: string) => pending.some((p) => p.requestId === requestId),
      [pending]
    ),
    answerPermission: useCallback(
      (requestId, reply) => answer({ requestId, reply }),
      [answer]
    ),
    answerQuestion: useCallback(
      (requestId, answers) => answer({ requestId, answers }),
      [answer]
    )
  }
}
