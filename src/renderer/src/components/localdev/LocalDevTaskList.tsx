import { AlertTriangle, Check, Loader2 } from 'lucide-react'
import type { LocalDevTask } from '../../../../shared/localDevState'

/**
 * Every component of local development at once — uv, Mutagen, cinna-cli, the
 * account workspace, the account token — each with its own status and, where
 * there is something honest to measure, its own bar.
 *
 * The whole list is shown from the start, including the parts not begun. A
 * single "Installing Mutagen…" line answers "is something happening" and
 * nothing else: it cannot say what is already done, what is still to come, or
 * how much of *this* piece is left. On a first run that is several minutes of
 * not knowing whether the app is two steps from finishing or ten.
 *
 * A row with no `percent` shows no bar rather than an empty one. The
 * account-token check is a single round trip; a bar for it would be decoration,
 * and a bar that never moves is exactly the thing this list exists to remove.
 *
 * Shared by the onboarding/consent panel and the status modal, so the two
 * cannot drift into describing the same install differently.
 */
export function LocalDevTaskList({ tasks }: { tasks: LocalDevTask[] }): React.JSX.Element {
  return (
    <ul className="space-y-2">
      {tasks.map((task) => (
        <TaskRow key={task.id} task={task} />
      ))}
    </ul>
  )
}

function TaskRow({ task }: { task: LocalDevTask }): React.JSX.Element {
  const percent =
    task.percent === undefined ? null : Math.round(Math.max(0, Math.min(100, task.percent)))
  // A bar on a pending row would imply work is under way; on a done row it is
  // redundant next to the tick. It earns its place only while something is
  // actually moving.
  const showBar = task.status === 'active' && percent !== null

  return (
    <li>
      <div className="flex items-center gap-2">
        <span className="shrink-0 w-3.5 flex justify-center">
          <StatusIcon status={task.status} />
        </span>
        <span
          className={`flex-1 min-w-0 text-[13px] truncate ${
            task.status === 'pending'
              ? 'text-[var(--color-text-muted)]'
              : 'text-[var(--color-text)]'
          }`}
        >
          {task.label}
        </span>
        {showBar && (
          <span className="shrink-0 text-[11px] text-[var(--color-text-muted)] tabular-nums">
            {percent}%
          </span>
        )}
      </div>

      {(task.detail || showBar) && (
        <div className="pl-[1.375rem] pt-0.5 space-y-1">
          {showBar && (
            <div className="h-1 rounded-full bg-[var(--color-bg-hover)] overflow-hidden">
              <div
                className="h-full bg-[var(--color-accent)] transition-[width] duration-200"
                style={{ width: `${percent}%` }}
              />
            </div>
          )}
          {task.detail && (
            <div
              className={`text-[11px] break-words ${
                task.status === 'failed'
                  ? 'text-[var(--color-danger)]'
                  : 'text-[var(--color-text-muted)]'
              }`}
            >
              {task.detail}
            </div>
          )}
        </div>
      )}
    </li>
  )
}

function StatusIcon({ status }: { status: LocalDevTask['status'] }): React.JSX.Element {
  if (status === 'done') return <Check size={13} className="text-[var(--color-success)]" />
  if (status === 'active') {
    return <Loader2 size={13} className="text-[var(--color-accent)] animate-spin" />
  }
  if (status === 'failed') {
    return <AlertTriangle size={13} className="text-[var(--color-danger)]" />
  }
  // Pending: a hollow dot rather than an icon. It has to read as "not yet",
  // which a glyph with any weight to it does not.
  return (
    <span className="w-1.5 h-1.5 rounded-full border border-[var(--color-text-muted)] opacity-60" />
  )
}
