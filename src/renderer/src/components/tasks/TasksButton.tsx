import { ListTodo } from 'lucide-react'
import { useUIStore } from '../../stores/ui.store'

/**
 * The top bar's way into the Tasks view, beside Agent Status and the Inbox —
 * the same fixed-size control, pressed while the view is open. Rendered only
 * while Settings → Features → Interface → Tasks button is on.
 */
export function TasksButton({ className = '' }: { className?: string }): React.JSX.Element | null {
  const show = useUIStore((s) => s.showTasksButton)
  const active = useUIStore((s) => s.activeView === 'tasks')
  const setActiveView = useUIStore((s) => s.setActiveView)
  if (!show) return null
  return (
    <button
      type="button"
      onClick={() => setActiveView('tasks')}
      title="Tasks"
      aria-label="Tasks"
      aria-pressed={active}
      className={`relative flex h-[29px] w-[29px] shrink-0 items-center justify-center aria-pressed:bg-[var(--color-accent)]/15 aria-pressed:text-[var(--color-accent)] ${className}`}
    >
      <ListTodo size={15} aria-hidden="true" />
    </button>
  )
}
