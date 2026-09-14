import { useCallback, useEffect, useRef, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { X } from 'lucide-react'
import type { RunQueueView } from '../../../../shared/ipcPayloads'
import { useRunQueue } from '../../hooks/useRunQueue'
import { useChatStore } from '../../stores/chat.store'
import { unwrapIpcError } from '../../utils/ipcError'
import { MessageBubble } from './MessageBubble'

/**
 * - `queued` — waiting for the turn to end; wears the badge.
 * - `sent` — left the queue because main sent it. The badge has slid away and
 *   the bubble stands in for the saved message until that row is on screen.
 * - `leaving` — the user cancelled it; fading out.
 */
export type QueuedPhase = 'queued' | 'sent' | 'leaving'

interface Tracked {
  id: string
  content: string
  phase: QueuedPhase
  /** For `sent`: the text main sent, which several bubbles may share when it merged them. */
  sentAs?: string
  /**
   * For `sent`: the saved user rows with that text the transcript will hold
   * before this message's own — those saved when it was sent, and those the
   * ended turn took in and saves with its rows. Its row is the one after these.
   */
  rowsBefore?: number
  /**
   * For `sent`: the running turn's live user messages with that text when it
   * was sent. Main can hand it to that turn, whose live message then shows it
   * well before its saved row: its own live message is the one after these.
   */
  liveBefore?: number
  /** For `sent`: which send it left in. Bubbles merged into one message share it. */
  send?: number
  /** When a `sent` or `leaving` bubble stops being shown regardless. */
  endsAt?: number
  /**
   * For `leaving`: main has not answered the cancel yet, so it is not removed
   * at `endsAt`. Main may answer that it sent the message first. A `sentAs`
   * on such an entry means it has already left the queue, and the entry keeps
   * how it would have been sent.
   */
  cancelling?: boolean
  animateIn: boolean
}

/** Main sent the message before the cancel reached it. */
export const QUEUED_CANCEL_TOO_LATE = "Already sent — it couldn't be cancelled."

/** Drops the too-late cancel notice, and only that one. */
function clearCancelTooLate(): void {
  const store = useChatStore.getState()
  if (store.sendError === QUEUED_CANCEL_TOO_LATE) store.setSendError(null)
}

export interface QueuedBubble {
  id: string
  content: string
  phase: QueuedPhase
  animateIn: boolean
}

export interface QueuedMessagesView {
  chatId: string
  /** Bubbles to render below the live turn. */
  bubbles: QueuedBubble[]
  /** A sent bubble is still standing in for its saved row. */
  holdsSent: boolean
  /**
   * The saved user row — or the live user message of the running turn — with
   * this text is taking over from sent bubble(s) in this render.
   */
  handsOver: (content: string) => boolean
  cancel: (id: string) => void
}

const LEAVE_MS = 200
/** A sent message whose row never appears (a refused start) stops standing in after this. */
const SENT_FALLBACK_MS = 15_000

function reducedMotion(): boolean {
  return !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
}

const countOf = (texts: readonly string[], text: string): number =>
  texts.reduce((count, other) => (other === text ? count + 1 : count), 0)

/**
 * The transcript's view of the chat's queue, and of what just left it.
 *
 * Main only lists what is queued, so what left has to be read from the
 * difference between two lists: an item that leaves a queue that is not held,
 * without the user cancelling it here, was sent — that is the only other way
 * out (take happens only on a held queue). Leaving together means sent
 * together, as one message. Sent can mean handed to the running turn, and
 * that can come back: an id that reappears in a queue that is not held was
 * put back because the turn would not take it, and is queued again — or, when
 * the user cancelled it and main answered too late, cancelled again.
 *
 * `liveUserTexts` are the messages the running (or just ended) turn took in,
 * which reach the saved transcript only with that turn's rows.
 */
export function useQueuedMessages(
  chatId: string,
  savedUserTexts: readonly string[],
  liveUserTexts: readonly string[] = []
): QueuedMessagesView {
  const { data } = useRunQueue(chatId)
  const queryClient = useQueryClient()
  const setSendError = useChatStore((state) => state.setSendError)
  const [tracked, setTracked] = useState<Tracked[]>([])
  const textsRef = useRef({ saved: savedUserTexts, live: liveUserTexts })
  textsRef.current = { saved: savedUserTexts, live: liveUserTexts }
  const loadedRef = useRef(false)
  const heldRef = useRef(false)
  const cancelledRef = useRef(new Set<string>())
  // Messages whose cancel main answered too late, the notice saying so shown.
  const cancelTooLateRef = useRef(new Set<string>())
  const sendsRef = useRef(0)

  // One MessageStream serves every chat: start clean for another one.
  useEffect(() => {
    setTracked([])
    loadedRef.current = false
    heldRef.current = false
    cancelledRef.current = new Set()
    cancelTooLateRef.current = new Set()
  }, [chatId])

  /**
   * Asks main to remove a message the user cancelled, and settles its bubble on
   * the answer. `again` is a cancel main answered too late, asked once more
   * because main put the message back: the turn it was handed to would not
   * take it. Too late a second time, it stays queued.
   */
  const removeQueued = useCallback((id: string, again: boolean): void => {
    useChatStore.getState().noteQueuedCancelled(id)
    cancelledRef.current.add(id)
    // The cancel did not happen: main sent the message first, or the call
    // failed. It is no longer a cancel the composer should keep quiet about,
    // and the bubble comes back rather than fading. If it already left the
    // queue it was sent, and stands in for its row like any sent bubble; if
    // not, it is queued, and the queue's next push says where it went.
    const refused = (notice: string | null): void => {
      cancelledRef.current.delete(id)
      useChatStore.getState().forgetQueuedCancelled(id)
      const now = Date.now()
      setTracked((previous) =>
        previous.map((entry) => {
          if (entry.id !== id || entry.phase !== 'leaving') return entry
          return entry.sentAs !== undefined
            ? { ...entry, phase: 'sent', cancelling: false, endsAt: now + SENT_FALLBACK_MS }
            : { ...entry, phase: 'queued', cancelling: false, endsAt: undefined }
        })
      )
      if (notice) setSendError(notice)
    }
    const ask = (retry: boolean): void => {
      void window.api.run.queueRemove(chatId, id)
        .then((removed) => {
          if (!removed) {
            if (retry) return refused(null)
            // Main had it out of the queue. Handed to the running turn, it may be
            // back already, put back because the turn would not take it: main's
            // queue changes reach the view before this answer. Then it was
            // never sent, the cancel still stands, and it is asked for again.
            const view = queryClient.getQueryData<RunQueueView>(['run-queue', chatId])
            if (view && !view.held && (view.items ?? []).some((item) => item.id === id)) return ask(true)
            cancelTooLateRef.current.add(id)
            return refused(QUEUED_CANCEL_TOO_LATE)
          }
          setTracked((previous) =>
            previous.map((entry) => (entry.id === id && entry.cancelling ? { ...entry, cancelling: false } : entry))
          )
        })
        .catch((error) => refused(unwrapIpcError(error, 'The queued message could not be cancelled.')))
        .finally(() => void queryClient.invalidateQueries({ queryKey: ['run-queue', chatId] }))
    }
    ask(again)
  }, [chatId, queryClient, setSendError])

  useEffect(() => {
    if (!data) return
    // Too late to cancel because main had handed it to the running turn, which
    // would not take it: back in a queue that is not held, it was never sent,
    // and the user's cancel still stands. It leaves again, cancelled once more,
    // and "Already sent" would contradict it.
    const cancelAgain = new Set<string>()
    if (!data.held) {
      for (const item of data.items ?? []) {
        if (!cancelTooLateRef.current.delete(item.id)) continue
        clearCancelTooLate()
        cancelAgain.add(item.id)
      }
    }
    const wasHeld = heldRef.current
    const firstLoad = !loadedRef.current
    heldRef.current = data.held
    loadedRef.current = true
    const now = Date.now()
    const leavesAt = now + (reducedMotion() ? 0 : LEAVE_MS)
    const texts = textsRef.current
    const send = ++sendsRef.current
    setTracked((previous) => {
      const present = new Map((data.items ?? []).map((item) => [item.id, item]))
      // A start main refused puts what it drained back, held, under the same
      // ids — pushed right after the queue that lost them, so a render between
      // the two has already called them sent. They were not.
      // Handed to the running turn, which would not take it after all: main
      // put it back, and it is queued where it stood, without coming in again.
      // A cancel still unanswered is no longer one that raced a send.
      const standing = previous
        .filter((entry) => !(entry.phase === 'sent' && data.held && present.has(entry.id)))
        .map((entry): Tracked => {
          if (data.held || !present.has(entry.id)) return entry
          if (cancelAgain.has(entry.id)) {
            return { id: entry.id, content: entry.content, phase: 'leaving', endsAt: leavesAt, cancelling: true, animateIn: false }
          }
          if (entry.phase === 'sent') return { id: entry.id, content: entry.content, phase: 'queued', animateIn: false }
          if (entry.phase === 'leaving' && entry.cancelling && entry.sentAs !== undefined) {
            return { ...entry, sentAs: undefined, rowsBefore: undefined, liveBefore: undefined, send: undefined }
          }
          return entry
        })
      // A cancel main has not answered leaves with the rest: if main sent it
      // first, it went out merged with them.
      const leavesUnanswered = (entry: Tracked): boolean =>
        entry.phase === 'leaving' && !!entry.cancelling && entry.sentAs === undefined
      const left = standing.filter((entry) => (entry.phase === 'queued' || leavesUnanswered(entry)) && !present.has(entry.id))
      // Items leave a held queue only by being taken back into the composer.
      const takenBack = wasHeld || data.held
      const sentAs = left.map((entry) => entry.content).join('\n\n')
      // Counted when it is sent, not when it was queued: a message with the
      // same words saved in between — or taken into the turn and saved with its
      // rows after this — is not this message's row. Nor is the row of an
      // earlier send with the same words whose bubble still stands.
      const earlierSends = new Set(
        standing
          .filter((entry) => entry.phase === 'sent' && entry.sentAs === sentAs && countOf(texts.saved, sentAs) <= (entry.rowsBefore ?? 0))
          .map((entry) => entry.send)
      ).size
      const rowsBefore = countOf(texts.saved, sentAs) + countOf(texts.live, sentAs) + earlierSends
      // The same for the running turn's live messages: an earlier send with
      // the same words, still waiting for its live message, is owed the next.
      const earlierLiveSends = new Set(
        standing
          .filter((entry) =>
            entry.phase === 'sent' && entry.sentAs === sentAs && entry.liveBefore !== undefined &&
            countOf(texts.live, sentAs) <= entry.liveBefore)
          .map((entry) => entry.send)
      ).size
      const liveBefore = countOf(texts.live, sentAs) + earlierLiveSends
      const next: Tracked[] = []
      for (const entry of standing) {
        if (leavesUnanswered(entry) && !present.has(entry.id)) {
          if (!takenBack) next.push({ ...entry, sentAs, rowsBefore, liveBefore, send })
          continue
        }
        if (entry.phase !== 'queued') {
          next.push(entry)
          continue
        }
        const item = present.get(entry.id)
        if (item) next.push(item.content === entry.content ? entry : { ...entry, content: item.content })
        else if (!takenBack) next.push({ ...entry, phase: 'sent', sentAs, rowsBefore, liveBefore, send, endsAt: now + SENT_FALLBACK_MS })
      }
      const known = new Set(standing.map((entry) => entry.id))
      for (const item of data.items ?? []) {
        if (known.has(item.id) || cancelledRef.current.has(item.id)) continue
        next.push({ id: item.id, content: item.content, phase: 'queued', animateIn: !firstLoad })
      }
      return next
    })
    for (const id of cancelAgain) removeQueued(id, true)
  }, [data, removeQueued])

  // A sent bubble retires in the same render its saved row appears in — or its
  // live message, when main handed it to the running turn — so there is never
  // a frame with both, nor one with neither.
  const retired = new Set(
    tracked
      .filter((entry) => {
        if (entry.phase !== 'sent') return false
        const text = entry.sentAs ?? entry.content
        return countOf(savedUserTexts, text) > (entry.rowsBefore ?? 0) ||
          (entry.liveBefore !== undefined && countOf(liveUserTexts, text) > entry.liveBefore)
      })
      .map((entry) => entry.id)
  )
  const retiredKey = [...retired].join(',')
  useEffect(() => {
    if (!retiredKey) return
    const ids = new Set(retiredKey.split(','))
    setTracked((previous) => previous.filter((entry) => !ids.has(entry.id)))
  }, [retiredKey])

  useEffect(() => {
    const endings = tracked.filter((entry) => entry.endsAt !== undefined && !entry.cancelling)
    if (!endings.length) return
    const timers = endings.map((entry) =>
      setTimeout(
        () => setTracked((previous) => previous.filter((other) => other.id !== entry.id)),
        Math.max(0, (entry.endsAt ?? 0) - Date.now())
      )
    )
    return () => timers.forEach(clearTimeout)
  }, [tracked])

  const cancel = useCallback((id: string) => {
    const endsAt = Date.now() + (reducedMotion() ? 0 : LEAVE_MS)
    setTracked((previous) =>
      previous.map((entry) => (entry.id === id && entry.phase === 'queued' ? { ...entry, phase: 'leaving', endsAt, cancelling: true } : entry))
    )
    removeQueued(id, false)
  }, [removeQueued])

  const bubbles = tracked
    .filter((entry) => !retired.has(entry.id) && !(entry.phase === 'queued' && data?.held))
    .map(({ id, content, phase, animateIn }) => ({ id, content, phase, animateIn }))
  const handsOverTexts = new Set(
    tracked.filter((entry) => retired.has(entry.id)).map((entry) => entry.sentAs ?? entry.content)
  )
  return {
    chatId,
    bubbles,
    holdsSent: bubbles.some((bubble) => bubble.phase === 'sent'),
    handsOver: (content) => handsOverTexts.has(content),
    cancel
  }
}

/**
 * Messages sent while the turn runs, waiting for it to end, below the live
 * turn and inside the transcript's content box, so a view following the bottom
 * keeps them in sight.
 */
export function QueuedMessages({ view }: { view: QueuedMessagesView }): React.JSX.Element | null {
  const editing = useChatStore((state) => state.editingQueued)
  if (!view.bubbles.length) return null
  return (
    <>
      {view.bubbles.map((bubble) => (
        <QueuedBubbleRow
          key={bubble.id}
          bubble={bubble}
          editing={editing?.chatId === view.chatId && editing.id === bubble.id}
          onCancel={() => view.cancel(bubble.id)}
        />
      ))}
    </>
  )
}

const BADGE_LABELS = ['Queued', 'Cancel?', 'Editing'] as const

function QueuedBubbleRow({
  bubble,
  editing,
  onCancel
}: {
  bubble: QueuedBubble
  editing: boolean
  onCancel: () => void
}): React.JSX.Element {
  const [armed, setArmed] = useState(false)
  const queued = bubble.phase === 'queued'
  const leaving = bubble.phase === 'leaving'
  // The [x] under the pointer or focus confirms what a click does, even on the
  // message being edited.
  const label = armed && queued ? 'Cancel?' : editing ? 'Editing' : 'Queued'
  return (
    // The 12px gap above the row is the transcript's `space-y-3` margin, which
    // belongs to the element before it. The row takes it back (`-mt-3`) and
    // gives it out again as padding inside the collapsing box (`pt-3`), so a
    // cancelled row closes its gap as it collapses instead of snapping it shut
    // when it unmounts (ux_rules §1).
    <div
      data-queued-message
      data-phase={bubble.phase}
      className="-mt-3 grid transition-[grid-template-rows,opacity] duration-200 ease-out motion-reduce:transition-none"
      style={{ gridTemplateRows: leaving ? '0fr' : '1fr', opacity: leaving ? 0 : 1 }}
    >
      <div className={leaving ? 'min-h-0 overflow-hidden' : 'min-h-0'}>
        <div className="pt-3">
          {/* Above the badge in paint order, so the badge's top edge tucks under it. */}
          <div className="relative z-10">
            <MessageBubble role="user" content={bubble.content} animate={bubble.animateIn} />
          </div>
          {/* The badge's row closes as it slides up under the bubble. */}
          <div
            className="grid justify-items-end transition-[grid-template-rows,margin-top] duration-200 ease-out motion-reduce:transition-none"
            style={{ gridTemplateRows: queued ? '1fr' : '0fr', marginTop: queued ? -8 : 0 }}
          >
            <div className="min-h-0 overflow-hidden">
              <div
                className={`mr-3 flex items-center gap-0.5 rounded-b-lg bg-[var(--color-bg-tertiary)] pt-2 pb-0.5 pl-2 pr-0.5
                  text-[10px] font-medium transition-transform duration-200 ease-out motion-reduce:transition-none
                  ${queued ? '' : '-translate-y-full'}
                  ${label === 'Cancel?' ? 'text-[var(--color-danger)]' : 'text-[var(--color-text-secondary)]'}`}
              >
                {/* Every label in one cell, sized by the longest: the swap never resizes the badge. */}
                <span className="grid">
                  {BADGE_LABELS.map((text) => (
                    <span
                      key={text}
                      aria-hidden={text !== label}
                      className={`col-start-1 row-start-1 text-right ${text === label ? '' : 'invisible'}`}
                    >
                      {text}
                    </span>
                  ))}
                </span>
                {/* A chip of its own at rest, so it reads as a control beside its label before any hover (ux_rules §11). */}
                <button
                  type="button"
                  onClick={onCancel}
                  disabled={!queued}
                  onMouseEnter={() => setArmed(true)}
                  onMouseLeave={() => setArmed(false)}
                  onFocus={() => setArmed(true)}
                  onBlur={() => setArmed(false)}
                  aria-label="Cancel queued message"
                  className="inline-flex h-5 w-5 items-center justify-center rounded bg-[var(--color-bg-secondary)]
                    hover:bg-[var(--color-bg-hover)] hover:text-[var(--color-danger)] transition-colors"
                >
                  <X size={10} />
                </button>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
