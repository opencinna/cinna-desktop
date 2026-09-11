import { useMemo, useRef, useState } from 'react'
import { AlertTriangle, Inbox as InboxIcon, Loader2 } from 'lucide-react'
import { useAgents } from '../../hooks/useAgents'
import { useAnswerAsk, useInboxList } from '../../hooks/useInbox'
import { useRelativeNow } from '../../hooks/useRelativeNow'
import { useOpenTask } from '../../hooks/useTasks'
import { formatRelativeFromDate } from '../../utils/cinnaTime'
import { unwrapIpcError } from '../../utils/ipcError'
import { PermissionRequestBlock } from '../chat/PermissionRequestBlock'
import { AskUserQuestionBlock } from '../chat/AskUserQuestionBlock'
import { ASK_NO_LONGER_WAITING } from '../../../../shared/inbox'
import { describeQuestionAnswers } from '../../../../shared/localAgentRequests'
import type { InboxAnswerCode, InboxEntry } from '../../../../shared/inbox'

/**
 * The inbox — one flat list of every ask waiting on a human, newest first.
 *
 * ## It renders the transcript's own blocks, not copies of them
 *
 * A permission ask and a question look the same here as they do in the chat
 * they came from, because they *are* the same components: an ask has one
 * rendering, and a second one would be a second place for "Always allow" to
 * mean something slightly different. The row around them supplies what the
 * transcript gets from context — which task this is, which agent is asking,
 * and the way back to the work (the task page, never the chat — see the row).
 *
 * ## A row the user has acted on never leaves while they are looking at it
 *
 * The list re-reads itself every few seconds, and answering an ask removes it
 * from the next read. Letting that removal happen would pull the row out from
 * under the outcome the user is still reading and jump everything below it
 * (`ux_rules.md` §1). So an entry that has been answered *here* is retained for
 * as long as this view is mounted, showing what it settled as; leaving the
 * inbox and coming back is what clears it.
 *
 * Rows that leave for any other reason — answered in the transcript, expired
 * with the turn that raised them — do disappear on the next read. Nothing the
 * user is pointing at moves, because nothing they did caused it.
 *
 * ## The order is fixed when a row first appears, not on every read
 *
 * Newest first is how the list is *built*; it is not a sort re-applied every
 * five seconds. Two job runs can be in flight at once, and an ask arriving
 * while the user's pointer is already on **Deny** would otherwise be inserted
 * above that row and push it — and its two neighbouring buttons — down a whole
 * card. The click would then land on a permission nobody read (`ux_rules.md`
 * §1, which is explicit that nothing may be inserted above a control the user
 * is about to press). So an arrival joins at the **end**, where it can move
 * nothing, and the order a row was first seen in holds for the life of the
 * mount.
 *
 * No grouping, no filters, no board. One list, and the oldest thing in it is
 * the one that has been waiting longest.
 */
/**
 * The refusals that end an ask rather than bounce an answer off it.
 *
 * All five codes are failures; only one of them leaves anything to press again.
 * A `malformed` answer is the row's own fault and retrying is the right
 * response, so it keeps its controls and shows the reason beside them
 * (`ux_rules.md` §6). The other four say the ask is gone — the turn died, the
 * park timed out, somebody answered it in the transcript — and a card that
 * stays amber with three live buttons under "This request is no longer waiting
 * for an answer." is offering a decision that cannot be made.
 */
const SETTLED_REFUSALS: readonly InboxAnswerCode[] = [
  'no_longer_waiting',
  'already_answered',
  'not_here',
  'not_owned'
]

export function InboxView(): React.JSX.Element {
  const { data, isLoading, isError, isSuccess, refetch } = useInboxList()
  const { data: agents, isPending: agentsPending } = useAgents()
  const now = useRelativeNow()
  const [retained, setRetained] = useState<InboxEntry[]>([])
  /**
   * The render order, by request id, in the order each row was first seen.
   *
   * Written from inside the memo rather than from an effect, so a row renders
   * on the pass it arrives in instead of one frame later — appending an id that
   * is already there is a no-op, which is what makes that safe to repeat under
   * a double-invoked render.
   */
  const order = useRef<string[]>([])

  const entries = useMemo(() => {
    const byId = new Map<string, InboxEntry>()
    for (const entry of retained) byId.set(entry.requestId, entry)
    for (const entry of data ?? []) byId.set(entry.requestId, entry)
    const known = new Set(order.current)
    const fresh = [...byId.values()]
      .filter((entry) => !known.has(entry.requestId))
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
    if (fresh.length > 0) order.current = [...order.current, ...fresh.map((e) => e.requestId)]
    return order.current
      .map((id) => byId.get(id))
      .filter((entry): entry is InboxEntry => entry !== undefined)
  }, [data, retained])

  /**
   * Who is asking, or nothing at all.
   *
   * **"An agent" means the agent is gone, so it must not also mean "the list
   * has not loaded yet".** The agents query is in flight on every cold open of
   * this view, and falling back to that phrase in the meantime put it on every
   * row for the first moment of every load — teaching the reader that the one
   * sentence reserved for a deleted agent is what loading looks like. While the
   * list is pending the segment is simply absent and the row reads as its time.
   */
  const agentLabel = (agentId: string | null): string | null => {
    if (!agentId || agentsPending) return null
    return (agents ?? []).find((a) => a.id === agentId)?.name ?? 'An agent'
  }

  /** What is still waiting — the number the sidebar badge shows. */
  const waiting = data?.length ?? 0

  const retain = (entry: InboxEntry): void => {
    setRetained((prev) =>
      prev.some((e) => e.requestId === entry.requestId) ? prev : [...prev, entry]
    )
  }

  return (
    <div className="flex-1 overflow-y-auto pt-[var(--topbar-h)]">
      <div className="max-w-2xl mx-auto px-6 py-6 space-y-4">
        <header className="flex items-center gap-2">
          <h1 className="text-base font-semibold text-[var(--color-text)]">Inbox</h1>
          {/*
            Beside the title rather than under it: a count is not a description
            of the word above it (`ux_rules.md` §7).

            **`data`, not `entries`.** A retained row is still rendered and no
            longer waiting, so counting what is on screen would read "2 waiting"
            beside a sidebar badge reading 1 — with the wrong number attached to
            the word that claims to explain it.
          */}
          {isSuccess && waiting > 0 && (
            <span className="text-[11px] text-[var(--color-text-muted)]">{waiting} waiting</span>
          )}
        </header>

        {isLoading && !data ? (
          <div className="flex items-center justify-center py-12 text-xs text-[var(--color-text-muted)]">
            <Loader2 size={14} className="animate-spin mr-2" />
            Loading…
          </div>
        ) : isError && entries.length === 0 ? (
          /*
            **Not the empty state.** A read that failed and a profile with
            nothing waiting are the same shape here — no rows — and telling
            someone whose agent is parked that nothing is waiting on them is the
            silent failure `ux_rules.md` §6 calls the worst outcome.
          */
          <div className="flex flex-col items-center justify-center gap-2 py-16 text-center">
            <AlertTriangle size={24} className="text-[var(--color-warning)] opacity-70" />
            <div className="text-sm text-[var(--color-text-secondary)]">
              The inbox could not be read.
            </div>
            <div className="text-xs text-[var(--color-text-muted)]">
              Anything waiting is still waiting — this is the list, not the requests.
            </div>
            <RetryButton onRetry={() => void refetch()} />
          </div>
        ) : entries.length === 0 ? (
          <div className="flex flex-col items-center justify-center gap-2 py-16 text-center">
            <InboxIcon size={24} className="text-[var(--color-text-muted)] opacity-50" />
            <div className="text-sm text-[var(--color-text-muted)]">
              Nothing is waiting on you.
            </div>
            <div className="text-xs text-[var(--color-text-muted)] opacity-80">
              An agent that stops to ask something will show up here, whether or not its
              chat is open.
            </div>
          </div>
        ) : (
          <div className="space-y-3">
            {entries.map((entry) => (
              <InboxRow
                key={entry.requestId}
                entry={entry}
                agentLabel={agentLabel(entry.agentId)}
                now={now}
                onActed={retain}
              />
            ))}
            {/*
              Under the list, never over it: a refresh can fail at any moment,
              including while the pointer is on a row's buttons, and a line that
              appeared above them would move them (`ux_rules.md` §1). The rows
              above are the last good read and are still answerable — the ask
              lives in the main process, not in this list.
            */}
            {isError && (
              <div className="flex items-center gap-2 pt-1 text-[11px] text-[var(--color-text-muted)]">
                <AlertTriangle size={12} className="text-[var(--color-warning)] shrink-0" />
                <span>Showing the last read — the inbox could not be refreshed.</span>
                <RetryButton onRetry={() => void refetch()} />
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  )
}

/**
 * The one control a failed read offers. Accent, because a muted text button
 * beside muted prose is not a control anybody finds (`ux_rules.md` §11).
 */
function RetryButton({ onRetry }: { onRetry: () => void }): React.JSX.Element {
  return (
    <button
      type="button"
      onClick={onRetry}
      className="text-[11px] font-medium text-[var(--color-accent)] hover:text-[var(--color-accent-hover)] transition-colors"
    >
      Try again
    </button>
  )
}

/** One waiting ask: who is asking about what, and the ask itself. */
function InboxRow({
  entry,
  agentLabel,
  now,
  onActed
}: {
  entry: InboxEntry
  /** Who is asking, already resolved — null while unknown, never a placeholder. */
  agentLabel: string | null
  now: Date
  onActed: (entry: InboxEntry) => void
}): React.JSX.Element {
  const answer = useAnswerAsk()
  const openTask = useOpenTask()
  const card = useRef<HTMLElement>(null)
  /**
   * The card's height at the moment it was answered, held as a floor.
   *
   * A settling ask is genuinely shorter than a waiting one — three buttons
   * become one line — so without this, answering the first of two rows pulls
   * the second one up by about the height of a button, and the pointer that
   * just clicked *Allow once* is left over the next row's controls
   * (`ux_rules.md` §1). The space was already the user's; keeping it costs
   * nothing and is what the rule means by reserving it.
   *
   * It does not stop a *refusal* from making the card taller — the reason has
   * to render somewhere, and rule 6 puts it beside the control that produced
   * it. Growth pushes the rows below down rather than sliding them under the
   * pointer, which is the direction that does not mis-click.
   */
  const [floor, setFloor] = useState<number | null>(null)
  // Only the question block needs telling: `PermissionRequestBlock` keeps its
  // own record of what it answered, and a question's block is handed one. Both
  // halves matter — without this the row would keep offering Answer, whose only
  // remaining outcome is "already answered", and would show nothing about what
  // the user chose a moment ago.
  const [settledAs, setSettledAs] = useState<string | null>(null)
  /**
   * Deliver, and keep the row whatever happens.
   *
   * Retained **before** the await rather than after it: a refusal rejects, and
   * a `return` after the throw would never run — leaving the one row whose
   * outcome the user most needs to read as the one row free to vanish under
   * them at the next poll.
   */
  const deliver = async (payload: {
    requestId: string
    reply?: 'once' | 'always' | 'reject'
    answers?: string[][]
  }): Promise<{ remembered?: boolean }> => {
    // Before the await, so the footprint frozen is the one the user clicked in.
    // `getBoundingClientRect` rather than `offsetHeight`: the latter rounds to
    // an integer, which left the rows below free to move by the fraction it
    // dropped. Zero means no layout to freeze (jsdom, an unmounted ref).
    const height = card.current?.getBoundingClientRect().height
    if (height) setFloor(height)
    onActed(entry)
    let result: Awaited<ReturnType<typeof answer>>
    try {
      result = await answer(payload)
    } catch (err) {
      // A failure *below* `inbox:answer` — not a refusal it returns as data —
      // arrives wrapped in Electron's own prose, and is the one case where the
      // ask may well still be live. Re-thrown so the block that raised it shows
      // the reason beside the control and keeps that control (§6).
      throw new Error(unwrapIpcError(err, 'That answer could not be delivered.'))
    }
    if (result.ok) {
      // The runner's own sentence, from the shared helper that writes the
      // transcript's copy of it — so the two cannot drift into two spellings
      // of one decision. A permission needs none: its block keeps its own
      // record, and handing it one would overwrite "Allowed once."
      if (payload.answers) setSettledAs(describeQuestionAnswers(payload.answers))
      return { remembered: result.remembered }
    }
    if (result.code && SETTLED_REFUSALS.includes(result.code)) {
      // **Resolved, not thrown, and that is the whole point.** The sentence
      // becomes the block's `decision`, which is the slot the runner already
      // writes "No answer — the request expired." into — so the card settles
      // into the same read-only shape a dead ask has in the transcript, rather
      // than staying amber with three buttons that cannot work.
      setSettledAs(result.reason ?? ASK_NO_LONGER_WAITING)
      return {}
    }
    throw new Error(result.reason ?? 'That answer could not be delivered.')
  }

  return (
    <article
      ref={card}
      style={floor === null ? undefined : { minHeight: floor }}
      className="rounded-lg border border-[var(--color-border)] bg-[var(--color-bg-secondary)]/40 px-3 py-2.5"
    >
      {/*
        **The way back is the task, never the conversation.** There is nothing
        in the transcript to open: the assistant message carrying the ask is
        persisted only once the turn's `run()` resolves
        (`a2aStreamingService.streamToAgent`), and a parked ask is by definition
        a turn that has not — so the chat holds the job's prompt and nothing
        else, over a sidebar that does not list a job-spawned chat at all. A
        control that lands on a screen missing the very thing it was pressed
        from is the silent failure of `ux_rules.md` §6.

        The task page is the screen that *does* have it: what the work is, where
        it stands, and the conversation as its own labelled action once there is
        something in it. It is a text action in the accent colour rather than a
        clickable title, because a control the colour of the prose beside it is
        not a control anybody finds (§11).
      */}
      <div className="min-w-0 mb-2 flex items-start justify-between gap-3">
        <div className="min-w-0">
          {/*
            13px, the size of the ask's own headline below it. At `text-xs` the
            card's subject was set smaller than its body — one scale per surface
            (`ux_rules.md` §12), and here the block inside is what sets it.
          */}
          <div
            className="text-[13px] font-medium text-[var(--color-text)] truncate"
            title={entry.taskTitle}
          >
            {entry.taskTitle}
          </div>
          <div className="text-[11px] text-[var(--color-text-muted)] truncate">
            {[agentLabel, formatRelativeFromDate(entry.createdAt, now)]
              .filter(Boolean)
              .join(' · ')}
          </div>
        </div>
        <button
          type="button"
          onClick={() => openTask(entry.taskId)}
          className="shrink-0 text-[11px] font-medium text-[var(--color-accent)] hover:text-[var(--color-accent-hover)] transition-colors"
        >
          Open the task
        </button>
      </div>
      <AskBody entry={entry} settledAs={settledAs} onDeliver={deliver} />
    </article>
  )
}

/** The ask itself, in whichever block the transcript would have used. */
function AskBody({
  entry,
  settledAs,
  onDeliver
}: {
  entry: InboxEntry
  /**
   * What this row settled as, once it has been answered from here — the record
   * to show, and the fact that there is no address left to answer again.
   */
  settledAs: string | null
  onDeliver: (payload: {
    requestId: string
    reply?: 'once' | 'always' | 'reject'
    answers?: string[][]
  }) => Promise<{ remembered?: boolean }>
}): React.JSX.Element {
  const request = entry.request
  if (request.kind === 'permission') {
    return (
      <PermissionRequestBlock
        request={{
          action: request.action,
          resources: request.resources,
          // OpenCode's `save[]`, which the block documents as deliberately
          // unread: the grant it offers is derived from the resources above and
          // written into the agent's own folder. It is not carried on an
          // `InputRequest` and nothing here needs to invent one.
          savable: [],
          callId: request.callId
        }}
        requestId={entry.requestId}
        // False only once this row has settled — a live ask is always
        // answerable, and a permission the user answered is settled by the
        // block's own state rather than by anything here.
        interactive={settledAs === null}
        decision={settledAs ?? undefined}
        onAnswer={(requestId, reply) => onDeliver({ requestId, reply })}
      />
    )
  }
  if (request.kind === 'question') {
    return (
      <AskUserQuestionBlock
        questions={request.questions}
        // A parked question is answerable by id, which is what `liveRequestId`
        // means. `interactive` is the *other* path — a cloud agent's question,
        // answered by writing the next message in its chat — and that ask never
        // reaches the inbox, because it writes no row (see `inboxService`).
        interactive={false}
        chatId={entry.chatId}
        liveRequestId={settledAs === null ? entry.requestId : undefined}
        decision={settledAs ?? undefined}
        onAnswerLocal={(requestId, answers) => onDeliver({ requestId, answers })}
      />
    )
  }
  // `auth` and `elicitation` never park: A2A's auth ask ends its turn and is
  // answered by the next message, and ACP's elicitations arrive already
  // translated into questions. Neither writes a row, so neither can appear
  // here — but an entry with nothing to render would be a blank card, so it
  // says what it is and points at the thread that owns it.
  return (
    <div className="text-[11px] text-[var(--color-text-muted)]">
      {request.kind === 'auth'
        ? request.message
        : 'This request is answered in the conversation it came from.'}
    </div>
  )
}
