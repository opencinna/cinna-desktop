import { useCallback } from 'react'
import { useQuery, useQueryClient, type UseQueryResult } from '@tanstack/react-query'
import { useChatStore } from '../stores/chat.store'
import type { AskAnswerPayload, InboxAnswerResult, InboxEntry } from '../../../shared/inbox'

/**
 * The inbox — every ask waiting on a human, answerable with its chat closed.
 *
 * ## Why it polls
 *
 * An ask reaches the renderer as a `needs_input` event on the **turn's own
 * MessagePort**, and a port is per turn and per renderer session. A job run
 * does stream through one — `useJobs`' `startRun` opens it, which is how
 * `observeAsks` sees the ask at all — but that port answers for exactly one
 * turn in one window: a reloaded renderer holds none, an ask raised before this
 * surface subscribed never arrives as an event, and step 9's remote entries
 * have no port anywhere. A list that waited for events would be missing rows in
 * all three cases, and the inbox exists precisely for the asks nobody is
 * watching.
 *
 * `inbox:list` is one indexed read over `task_input_requests` joined to its
 * task. It runs every five seconds for as long as the window is not *hidden* —
 * TanStack gates `refetchInterval` on `document.visibilityState`, not on OS
 * focus, so an Electron window sitting behind another app still polls; only
 * minimising or occluding it stops.
 *
 * The list is the count, too: the sidebar entry and the view read the same
 * cache entry, so the badge can never disagree with what is waiting. It can
 * disagree with what is on *screen*, and deliberately: the view keeps a row the
 * user has answered until they leave, so it renders more rows than this list
 * holds. Both surfaces count this list, never the rows.
 */
export const INBOX_QUERY_KEY = ['inbox'] as const

const POLL_MS = 5_000

export function useInboxList(): UseQueryResult<InboxEntry[]> {
  return useQuery({
    queryKey: INBOX_QUERY_KEY,
    queryFn: () => window.api.inbox.list(),
    refetchInterval: POLL_MS,
    // One retry, not three. The query re-runs every five seconds anyway, so the
    // default would turn one broken read into a dozen log lines a minute with
    // nothing on screen to show for them — and the surface that reports the
    // failure (`InboxView`) is reached from `isError`, which three silent
    // retries only delay.
    retry: 1
  })
}

/**
 * Deliver an answer from the inbox.
 *
 * **Returns the refusal rather than throwing it.** Main answers in `code`s, and
 * the two kinds of refusal want opposite things on screen: one the row can
 * retry (the answer was the wrong shape) and one that ends the ask (the turn
 * died, somebody else answered). Collapsing both into a thrown `Error` would
 * throw the `code` away at exactly the point it decides what to render, which
 * is the mistake `InboxAnswerResult` carries a `code` to prevent. The row
 * branches; see `InboxView`'s `deliver`.
 *
 * A refusal still refreshes the list: `no_longer_waiting` means main settled
 * the row on the way out, so the count must stop counting it.
 */
export function useAnswerAsk(): (payload: AskAnswerPayload) => Promise<InboxAnswerResult> {
  const queryClient = useQueryClient()
  return useCallback(
    async (payload: AskAnswerPayload) => {
      const result = await window.api.inbox.answer(payload)
      void queryClient.invalidateQueries({ queryKey: INBOX_QUERY_KEY })
      // The chat may be open behind this view, with a live block over the same
      // ask. Its `input_resolved` rides the turn's port and will settle it
      // anyway; saying so here means it is already settled when the user
      // switches to the transcript rather than a tick later.
      if (result.ok) useChatStore.getState().resolveInputRequest(payload.requestId)
      return result
    },
    [queryClient]
  )
}
