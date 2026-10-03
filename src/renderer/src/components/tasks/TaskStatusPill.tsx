import { taskStatusText } from './tasksViewModel'

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
 *
 * The words are `taskStatusLabel`'s — the Tasks view's categories (Backlog,
 * Ready, Done…) — so the page and the board name a status one way. A task
 * whose home has its own word for the status (a folder's `doing`) shows that
 * word as written — no small capitals, which would rewrite it — in the tone
 * of the category it maps to.
 */
export function TaskStatusPill({ status, label }: {
  status: string
  /** The home's own word (`TaskDto.statusLabel`); null or absent for the category word. */
  label?: string | null
}): React.JSX.Element {
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
  const asWritten = !!label?.trim()
  return (
    <span
      className={`shrink-0 px-1.5 py-0.5 rounded text-[10px] font-medium ${asWritten ? '' : 'uppercase tracking-wide'} ${tone}`}
    >
      {taskStatusText({ status: lc, statusLabel: label })}
    </span>
  )
}
