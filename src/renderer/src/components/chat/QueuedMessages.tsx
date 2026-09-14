import { useCallback, useEffect, useRef, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { X } from 'lucide-react'
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
  /** The saved user row with this text is taking over from sent bubble(s) in this render. */
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
 * together, as one message.
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
  const sendsRef = useRef(0)

  // One MessageStream serves every chat: start clean for another one.
  useEffect(() => {
    setTracked([])
    loadedRef.current = false
    heldRef.current = false
    cancelledRef.current = new Set()
  }, [chatId])

  useEffect(() => {
    if (!data) return
    const wasHeld = heldRef.current
    const firstLoad = !loadedRef.current
    heldRef.current = data.held
    loadedRef.current = true
    const now = Date.now()
    const texts = textsRef.current
    const send = ++sendsRef.current
    setTracked((previous) => {
      const present = new Map((data.items ?? []).map((item) => [item.id, item]))
      // A start main refused puts what it drained back, held, under the same
      // ids — pushed right after the queue that lost them, so a render between
      // the two has already called them sent. They were not.
      const standing = previous.filter((entry) => !(entry.phase === 'sent' && data.held && present.has(entry.id)))
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
      const next: Tracked[] = []
      for (const entry of standing) {
        if (leavesUnanswered(entry) && !present.has(entry.id)) {
          if (!takenBack) next.push({ ...entry, sentAs, rowsBefore, send })
          continue
        }
        if (entry.phase !== 'queued') {
          next.push(entry)
          continue
        }
        const item = present.get(entry.id)
        if (item) next.push(item.content === entry.content ? entry : { ...entry, content: item.content })
        else if (!takenBack) next.push({ ...entry, phase: 'sent', sentAs, rowsBefore, send, endsAt: now + SENT_FALLBACK_MS })
      }
      const known = new Set(standing.map((entry) => entry.id))
      for (const item of data.items ?? []) {
        if (known.has(item.id) || cancelledRef.current.has(item.id)) continue
        next.push({ id: item.id, content: item.content, phase: 'queued', animateIn: !firstLoad })
      }
      return next
    })
  }, [data])

  // A sent bubble retires in the same render its saved row appears in, so
  // there is never a frame with neither.
  const retired = new Set(
    tracked
      .filter((entry) => entry.phase === 'sent' && countOf(savedUserTexts, entry.sentAs ?? entry.content) > (entry.rowsBefore ?? 0))
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
    useChatStore.getState().noteQueuedCancelled(id)
    cancelledRef.current.add(id)
    const endsAt = Date.now() + (reducedMotion() ? 0 : LEAVE_MS)
    setTracked((previous) =>
      previous.map((entry) => (entry.id === id && entry.phase === 'queued' ? { ...entry, phase: 'leaving', endsAt, cancelling: true } : entry))
    )
    // The cancel did not happen: main sent the message first, or the call
    // failed. It is no longer a cancel the composer should keep quiet about,
    // and the bubble comes back rather than fading. If it already left the
    // queue it was sent, and stands in for its row like any sent bubble; if
    // not, it is queued, and the queue's next push says where it went.
    const refused = (notice: string): void => {
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
      setSendError(notice)
    }
    void window.api.run.queueRemove(chatId, id)
      .then((removed) => {
        if (!removed) return refused(QUEUED_CANCEL_TOO_LATE)
        setTracked((previous) =>
          previous.map((entry) => (entry.id === id && entry.cancelling ? { ...entry, cancelling: false } : entry))
        )
      })
      .catch((error) => refused(unwrapIpcError(error, 'The queued message could not be cancelled.')))
      .finally(() => void queryClient.invalidateQueries({ queryKey: ['run-queue', chatId] }))
  }, [chatId, queryClient, setSendError])

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
