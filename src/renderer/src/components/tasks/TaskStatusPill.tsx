/**
 * Where a task stands, in one pill.
 *
 * **One component, because a status has one spelling.** The task page and the
 * legacy cinna run screen both show a task's status; two pills would be two
 * places for `error` to be amber on one screen and red on the next.
 *
 * It takes a `string` rather than a `TaskStatus` on purpose. The vocabulary is
 * cinna-core's (`shared/taskStatus.ts`) and the desktop's own values are a
 * subset of what can arrive on one — a replica of a remote task can carry a
 * status this build predates, and the run screen still renders the raw strings
 * an older server sends (`succeeded`, `failed`). An unknown value gets the
 * neutral "something is happening" tone and prints itself, which is the honest
 * answer; it is never dropped and never guessed at.
 */
export function TaskStatusPill({ status }: { status: string }): React.JSX.Element {
  const lc = status.toLowerCase()
  const tone =
    lc === 'completed' || lc === 'succeeded'
      ? 'bg-[var(--color-severity-ok)]/15 text-[var(--color-severity-ok-text)]'
      : lc === 'error' || lc === 'failed'
        ? 'bg-[var(--color-severity-error)]/15 text-[var(--color-severity-error-text)]'
        : lc === 'blocked'
          ? 'bg-[var(--color-severity-warning)]/15 text-[var(--color-severity-warning-text)]'
          : lc === 'cancelled' || lc === 'archived'
            ? 'bg-[var(--color-bg-hover)] text-[var(--color-text-muted)]'
            : 'bg-[var(--color-severity-info)]/15 text-[var(--color-severity-info-text)]'
  return (
    <span
      className={`shrink-0 px-1.5 py-0.5 rounded text-[10px] font-medium uppercase tracking-wide ${tone}`}
    >
      {label(lc)}
    </span>
  )
}

/**
 * `in_progress` is a column name, not a word. The pill is the one place a user
 * reads a status, so it reads as English; everything else — the transition
 * table, the wire — keeps the identifier.
 */
function label(lc: string): string {
  return lc.replace(/_/g, ' ')
}
