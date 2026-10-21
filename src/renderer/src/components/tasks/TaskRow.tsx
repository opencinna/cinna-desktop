import type { TaskDto } from '../../../../shared/tasks'
import { useOpenTask } from '../../hooks/useTasks'
import { useRelativeNow } from '../../hooks/useRelativeNow'
import { formatRelativeFromDate } from '../../utils/cinnaTime'
import { TaskStatusIcon } from './TaskStatusIcon'
import { TaskAssigneeChip } from './TaskAssigneeChip'
import { taskChatName, taskStatusText } from './tasksViewModel'

/**
 * One task as a list row: where it stands, what it is, and when it last moved.
 * Clicking it opens the task page. The caller owns the list around it.
 *
 * ## The status leads, and the elastic part is last
 *
 * The status is an icon at the head rather than a spelled-out badge at the
 * tail, because a list is scanned and a page is read: ten rows of small
 * capitals is a word the eye has to get past to reach the title, and at a fixed
 * 14 px every title starts at the same left edge instead of ending at a right
 * edge set by the length of "in progress". See `TaskStatusIcon`.
 *
 * The time stays last for the reason the pill used to: it is the only part
 * whose width changes on its own — "3 minutes ago" becomes "1 hour ago" while
 * the user is reading — so nothing may sit after it that a five-second poll
 * could then shove sideways (`ux_rules.md` §1).
 */
export function TaskRow({
  task,
  size = 'regular',
  showAssignee = false,
  hideChat = false,
  onOpened
}: {
  task: Pick<TaskDto, 'id' | 'title' | 'status' | 'updatedAt'> & Partial<Pick<TaskDto, 'assignee' | 'statusLabel' | 'chat'>>
  /**
   * The type scale of the surface the row renders into (`ux_rules.md` §12):
   * `regular` is the Inbox's 13/11, `compact` the composer chrome's 12/11
   * (the Tasks popover under the input). A size, not a behaviour.
   */
  size?: 'regular' | 'compact'
  /**
   * Whose task it is, before the time — for a list that mixes agents (the
   * Tasks view with "All agents"). A fixed fact about the task, so the time
   * stays the one part that changes width on its own.
   */
  showAssignee?: boolean
  /**
   * The row sits under its own chat (the Tasks popover under the composer),
   * which already shows whether a turn is live: no live dot, and no ", running"
   * in the name. A compact row elsewhere — a task page's Subtasks, each in a
   * chat of its own — keeps the dot.
   */
  hideChat?: boolean
  /** After the task was opened — a popover around the row closes itself. */
  onOpened?: () => void
}): React.JSX.Element {
  const compact = size === 'compact'
  const openTask = useOpenTask()
  const now = useRelativeNow()
  const showDot = !hideChat && !!task.chat
  const live = showDot && !!task.chat?.running
  // Shown only on a regular row (a compact one has no room for it), and only
  // when the chat has a real name.
  const chatName = !compact && !hideChat && task.chat ? taskChatName(task.chat.title) : null
  return (
    <button
      type="button"
      /*
        **The status is in the name because it is on the row**
        (`ux_rules.md` §10). An `aria-label` replaces the contents it
        sits on, so the title alone announced a list whose whole
        point — where each piece of work stands — was visible to
        everyone except the reader who most depends on it being said.
        The pill's own wording, so the two cannot diverge — a folder
        task's own word (`statusLabel`) included.

        The relative time is deliberately left out: it is the one
        part of the row that rewrites itself while the list sits
        there, and a name that changes under a screen reader every
        minute is worse than one that omits a detail the user can
        reach by reading the row.

        Whether its chat has a turn live is said here too, because the
        dot that shows it is decorative: ", running" while it is, and only
        where the dot is drawn. So is the chat's name when the row shows it.
      */
      aria-label={`${task.title} — ${taskStatusText(task)}${chatName ? `, in ${chatName}` : ''}${live ? ', running' : ''}`}
      onClick={() => {
        openTask(task.id)
        onOpened?.()
      }}
      /*
        One line per task, and the height says so: `leading-5` is the
        13 px scale's own leading, so the row is that plus `py-1` and
        nothing else — a height derived from the type rather than a
        pixel count picked to look right, which is what keeps it in
        step if the scale ever moves (`ux_rules.md` §12).
      */
      className={`w-full flex items-center rounded text-left hover:bg-[var(--color-bg-hover)] ${
        compact ? 'gap-2 px-1.5 py-1 leading-4' : 'gap-2.5 px-2 py-1 leading-5'
      }`}
    >
      {/*
        The status leads the row rather than trailing it. In a list,
        where it stands is what the eye sorts by — and an icon at a
        fixed 14 px gives every row the same left edge for its title,
        where a trailing word set the title's *right* edge differently
        on every row depending on how long "in progress" is.
      */}
      <TaskStatusIcon status={task.status} />
      {/*
        Where the work happens, after what it is: the bound chat's name, muted,
        at the regular size only — a compact row has no room for it — and only
        when the chat has a name (not blank, not the default "New Chat").
        The title wins the width: the name's huge shrink factor makes it give
        way, down to nothing, before the title loses a character.
      */}
      {chatName ? (
        <span className="flex min-w-0 flex-1 items-baseline gap-1.5">
          <span className="min-w-0 truncate text-[13px] text-[var(--color-text)]" title={task.title}>
            {task.title}
          </span>
          <span data-task-row-chat className="min-w-0 max-w-[12rem] shrink-[9999] truncate text-[11px] text-[var(--color-text-muted)]" title={chatName}>
            in {chatName}
          </span>
        </span>
      ) : (
        <span
          className={`min-w-0 flex-1 truncate ${compact ? 'text-[12px]' : 'text-[13px]'} text-[var(--color-text)]`}
          title={task.title}
        >
          {task.title}
        </span>
      )}
      {showAssignee && task.assignee && <TaskAssigneeChip task={{ assignee: task.assignee }} className="max-w-[10rem] shrink-0" />}
      {/* Not with `hideChat`: the row sits under that very chat, whose composer already shows it live. */}
      {showDot && task.chat && <TaskLiveDot running={task.chat.running} chatTitle={task.chat.title} />}
      <span className="shrink-0 text-[11px] tabular-nums text-[var(--color-text-muted)]">
        {formatRelativeFromDate(task.updatedAt, now)}
      </span>
    </button>
  )
}

/**
 * A turn is live in the task's chat now. Rendered for every task that has a
 * chat — a fixed fact about it, like the assignee chip — and only made
 * `invisible` while the chat is idle, so a poll that flips it moves nothing
 * beside it (`ux_rules.md` §1). It pulses like the app's other live dot
 * (`SessionActivityBadges`), and names the chat on hover. Decorative: the
 * row's name says ", running". `className` places it (the board pins it to
 * the corner of the status icon).
 */
export function TaskLiveDot({ running, chatTitle, className = 'shrink-0' }: {
  running: boolean
  chatTitle: string
  className?: string
}): React.JSX.Element {
  return (
    <span
      aria-hidden="true"
      data-task-live-dot={running ? 'running' : 'idle'}
      title={running ? `Running in ${taskChatName(chatTitle) ?? 'New Chat'}` : undefined}
      // The ring, in the page background, parts the dot from whatever it sits
      // on — the board pins it to the In progress spinner, blue on blue in the
      // light theme.
      className={`h-1.5 w-1.5 rounded-full bg-[var(--color-accent)] ring-1 ring-[var(--color-bg)] ${className} ${running ? 'visible motion-safe:animate-pulse' : 'invisible'}`}
    />
  )
}
