import {
  AlertCircle,
  Archive,
  CheckCircle2,
  Circle,
  CircleSlash,
  Loader2,
  XCircle
} from 'lucide-react'

/**
 * Where a task stands, as one icon at the head of its row.
 *
 * ## Why this exists beside `TaskStatusPill` rather than replacing it
 *
 * The pill spells the status out, which is what a task's own page wants: there
 * is one of them, beside a title, with room to be read. A *list* wants the
 * opposite — ten rows scanned at a glance, where a word repeated ten times in
 * ten small capitals is noise the eye has to parse before it reaches the thing
 * it came for, which is the title. An icon is read as colour and shape in
 * peripheral vision, and it takes a fixed 14 px instead of a width that depends
 * on how long the word "in progress" happens to be.
 *
 * Both render the same vocabulary, and neither guesses: an unknown value — a
 * replica of a remote task carrying a status this build predates, which is the
 * case `TaskStatusPill` documents — gets the neutral outline rather than being
 * dropped or forced into the nearest tone that happens to look decided.
 *
 * ## It says nothing to a screen reader, deliberately
 *
 * `aria-hidden`, because the row's own accessible name already ends in the
 * status word (`RecentTasks`). Letting the icon announce itself too would read
 * the status twice, and letting it announce *instead* would trade a word for a
 * shape — which is the trade this component makes for the eye and must not make
 * for the ear.
 */
export function TaskStatusIcon({ status }: { status: string }): React.JSX.Element {
  const lc = status.toLowerCase()
  const { Icon, tone, spin } = describe(lc)
  return (
    <Icon
      size={14}
      aria-hidden="true"
      className={`shrink-0 ${tone} ${spin ? 'animate-spin' : ''}`}
    />
  )
}

/**
 * The one place a status becomes a shape and a colour.
 *
 * The tones are the pill's own severity variables, so a status that is green in
 * one place cannot be amber in the other — the reason there is a single mapping
 * at all.
 */
function describe(lc: string): {
  Icon: typeof Circle
  tone: string
  spin?: boolean
} {
  if (lc === 'completed' || lc === 'succeeded') {
    return { Icon: CheckCircle2, tone: 'text-[var(--color-severity-ok-text)]' }
  }
  if (lc === 'error' || lc === 'failed') {
    return { Icon: XCircle, tone: 'text-[var(--color-severity-error-text)]' }
  }
  if (lc === 'blocked') {
    return { Icon: AlertCircle, tone: 'text-[var(--color-severity-warning-text)]' }
  }
  // Moving, and the only row on the screen that should draw the eye on its own.
  if (lc === 'in_progress') {
    return { Icon: Loader2, tone: 'text-[var(--color-severity-info-text)]', spin: true }
  }
  if (lc === 'cancelled') return { Icon: CircleSlash, tone: 'text-[var(--color-text-muted)]' }
  if (lc === 'archived') return { Icon: Archive, tone: 'text-[var(--color-text-muted)]' }
  // `new`, `refining`, `open`, and anything a newer build sends: not started, or
  // not a word this build knows. Both are honestly "nothing has happened yet".
  return { Icon: Circle, tone: 'text-[var(--color-severity-info-text)]' }
}
