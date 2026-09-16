import { useCallback } from 'react'
import { useQuery, useQueryClient, type UseQueryResult } from '@tanstack/react-query'
import { useChatStore } from '../stores/chat.store'
import type {
  AskAnswerPayload,
  InboxAnswerResult,
  InboxSnapshot,
  InboxUnreadableSource
} from '../../../shared/inbox'

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
 * `inbox:list` joins local requests to tasks and reads blocked remote tasks'
 * asks through their adapters. Concurrent remote reads are shared in main; a
 * service that could not be read is named in the snapshot's `unreadable`
 * instead of taking the rest of the list with it, and a query that *rejected*
 * still means the whole read failed.
 * It runs every five seconds for as long as the window is not *hidden* —
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

/**
 * How many services this read could not reach, in words — or nothing at all.
 *
 * One sentence, exported once, because the badge's accessible name and the
 * view's warning line are the same fact and two spellings of it would be two
 * claims. It never names a service: a `RemoteTaskAdapter` carries an id and no
 * display name, and an id is not something to put in front of a user.
 */
export function describeUnreadable(unreadable: InboxUnreadableSource[]): string | null {
  if (unreadable.length === 0) return null
  return unreadable.length === 1
    ? 'One service could not be read'
    : `${unreadable.length} services could not be read`
}

export function useInboxList(): UseQueryResult<InboxSnapshot> {
  const queryClient = useQueryClient()
  return useQuery({
    queryKey: INBOX_QUERY_KEY,
    /**
     * **A remote ask the last read found stays on screen while its service is
     * unreadable.**
     *
     * Main deliberately keeps no cache of remote asks — they are a live
     * enumeration of the other side, not a second registry — so the only place
     * that remembers the card is here. Dropping it would pull a row out from
     * under the user (`ux_rules.md` §1) and, worse, lose an ask that is still
     * *answerable*: answering routes through the adapter, which refuses
     * retryably while the service is down and says so beside the control.
     *
     * Only `remote` entries, and only while something is unreadable: a local
     * row leaving the list left it in main, and a complete read is the whole
     * truth by definition.
     *
     * **It does not ask *which* service went quiet, and that is a limit with a
     * date on it.** One ask-capable adapter ships (`cinna`), so "something is
     * unreadable" and "this entry's service is unreadable" are the same
     * sentence today. With a second one, a card belonging to the service that
     * answered fine would be held on screen by the outage of a service it has
     * nothing to do with. The fix is not to decode the adapter out of the
     * `remote-ask:` address here — that address belongs to main — but to carry
     * the adapter id on `InboxEntry`, beside the `source` it already has.
     *
     * One entry it holds too long, knowingly: a task unbound or deleted while
     * some *other* service was failing drops out of main's read as an empty
     * result rather than a failure, so its card is retained here as though the
     * outage were hiding it, and its task page keeps saying it is waiting on an
     * answer. Pressing Answer settles it (`gone()`), and the next complete read
     * clears it. The alternative is asking main to distinguish "this task no
     * longer exists" from "this service did not answer" *per entry*, which is
     * the same adapter-precision this list does not have yet.
     */
    queryFn: async (): Promise<InboxSnapshot> => {
      const snapshot = await window.api.inbox.list()
      if (snapshot.unreadable.length === 0) return snapshot
      const previous = queryClient.getQueryData<InboxSnapshot>(INBOX_QUERY_KEY)
      const present = new Set(snapshot.entries.map((entry) => entry.requestId))
      const retained = (previous?.entries ?? []).filter(
        (entry) => entry.source === 'remote' && !present.has(entry.requestId)
      )
      if (retained.length === 0) return snapshot
      return {
        ...snapshot,
        entries: [...snapshot.entries, ...retained].sort(
          (a, b) => b.createdAt.getTime() - a.createdAt.getTime()
        )
      }
    },
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
