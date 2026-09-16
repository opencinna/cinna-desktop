import { useEffect, useMemo, useRef } from 'react'
import { createPortal } from 'react-dom'
import { ListChecks } from 'lucide-react'
import { useTaskList } from '../../hooks/useTaskList'
import { useUIStore } from '../../stores/ui.store'
import { TaskRow } from '../tasks/TaskRow'
import { useHoverPopover } from '../ui/useHoverPopover'
import { metaBadgeClass, metaCountClass, metaPopoverClass } from './SessionActivityBadges'

/** Rows in the popover; the rest are one click away in the Inbox. */
const MAX_ROWS = 10

export function tasksLabel(count: number): string {
  return `${count} ${count === 1 ? 'task' : 'tasks'} in this chat`
}

/**
 * The chat's root tasks, under the composer. Shown once the chat has one.
 *
 * The rows are `TaskRow` at the composer's chrome scale; a row opens its task.
 * More than ten, and the popover ends in **Open Inbox**, where `RecentTasks`
 * pages through all of them.
 */
export function ChatTasksBadge({ chatId }: { chatId: string }): React.JSX.Element | null {
  const tasks = useTaskList({ chatId, rootOnly: true })
  const popover = useHoverPopover<HTMLButtonElement, HTMLDivElement>('above-right')
  const setActiveView = useUIStore((s) => s.setActiveView)
  const rows = useMemo(() => tasks.data?.tasks ?? [], [tasks.data])

  /**
   * The order is taken when the popover opens and held while it is open. The
   * list is re-read every five seconds newest-first, so a task that moves while
   * the pointer is on the list would otherwise slide a different row under it
   * (`ux_rules.md` §1) — `RecentTasks` holds its order for the same reason.
   */
  const order = useRef<string[] | null>(null)
  if (!popover.open) order.current = null
  const ordered = useMemo(() => {
    if (!popover.open) return rows
    const byId = new Map(rows.map((task) => [task.id, task]))
    const held = order.current ?? []
    const known = new Set(held)
    const next = [...held, ...rows.filter((task) => !known.has(task.id)).map((task) => task.id)]
    order.current = next
    return next.map((id) => byId.get(id)).filter((task) => task !== undefined)
  }, [rows, popover.open])

  const { open, setOpen } = popover
  useEffect(() => {
    if (rows.length === 0 && open) setOpen(false)
  }, [rows.length, open, setOpen])

  if (rows.length === 0) return null
  const label = tasksLabel(rows.length)

  return (
    <>
      <button
        ref={popover.triggerRef}
        type="button"
        aria-label={label}
        className={metaBadgeClass}
        {...popover.triggerProps}
      >
        <ListChecks size={12} className="shrink-0" />
        <span className={metaCountClass}>{rows.length}</span>
      </button>
      {popover.open &&
        createPortal(
          <div
            ref={popover.popoverRef}
            aria-label="Tasks in this chat"
            style={popover.style ?? { position: 'fixed', visibility: 'hidden' }}
            className={metaPopoverClass}
            {...popover.popoverProps}
          >
            <p className="px-3 pb-1.5 flex items-baseline gap-1.5">
              <span className="font-semibold text-[var(--color-text)]">Tasks in this chat</span>
              {rows.length > MAX_ROWS && (
                <span className="text-[var(--color-text-muted)]">Showing {MAX_ROWS} of {rows.length}</span>
              )}
            </p>
            <ul className="list-none m-0 px-1.5">
              {ordered.slice(0, MAX_ROWS).map((task) => (
                <li key={task.id}>
                  {/* A row opens its task and leaves the chat; the popover goes with it. */}
                  <TaskRow task={task} size="compact" onOpened={popover.close} />
                </li>
              ))}
            </ul>
            {rows.length > MAX_ROWS && (
              <button
                type="button"
                onClick={() => {
                  popover.close()
                  setActiveView('inbox')
                }}
                className="mx-3 mt-1.5 text-[11px] font-medium text-[var(--color-accent)] hover:text-[var(--color-accent-hover)] transition-colors"
              >
                Open Inbox
              </button>
            )}
          </div>,
          document.body
        )}
    </>
  )
}
