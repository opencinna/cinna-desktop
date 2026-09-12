import { useRef, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { TASK_QUERY_KEY } from '../../hooks/useTasks'
import { useUIStore } from '../../stores/ui.store'
import { unwrapIpcError } from '../../utils/ipcError'
import type { TaskDto } from '../../../../shared/tasks'

export function TaskRuntimeControl({ task }: { task: TaskDto }): React.JSX.Element | null {
  const runtime = task.runtime
  const queryClient = useQueryClient()
  const setActiveView = useUIStore((state) => state.setActiveView)
  const pendingRef = useRef(false)
  const [pending, setPending] = useState<'resume' | 'stop' | null>(null)
  const [error, setError] = useState<string | null>(null)
  if (!runtime) return null
  const terminal = ['completed', 'error', 'cancelled', 'archived'].includes(task.status)
  const waiting = !terminal && runtime.state !== 'interrupted' && (runtime.state === 'waiting' || task.status === 'blocked')
  const action = async (kind: 'resume' | 'stop'): Promise<void> => {
    if (pendingRef.current) return
    pendingRef.current = true
    setPending(kind)
    setError(null)
    try {
      if (kind === 'resume') await window.api.tasks.resumeRuntime(task.id)
      else await window.api.tasks.stopRuntime(task.id)
      await queryClient.invalidateQueries({ queryKey: TASK_QUERY_KEY(task.id) })
      void queryClient.invalidateQueries({ queryKey: ['tasks'] })
      void queryClient.invalidateQueries({ queryKey: ['inbox'] })
      if (task.chatId) void queryClient.invalidateQueries({ queryKey: ['chat', task.chatId] })
    } catch (cause) { setError(unwrapIpcError(cause, 'The task could not be updated.')) }
    finally { pendingRef.current = false; setPending(null) }
  }
  const buttonClass = 'rounded-md border border-[var(--color-border)] px-3 py-1.5 text-xs font-medium text-[var(--color-text-secondary)] disabled:opacity-50'
  return <section aria-label="Autonomous task" className="space-y-2">
    <div className="flex items-center justify-between gap-3 min-h-8">
      <span className="text-xs text-[var(--color-text-secondary)]">
        {waiting ? 'Waiting for your answer' : runtime.state === 'queued' ? 'Queued' : runtime.state === 'running' ? 'Working on its own' : runtime.state === 'interrupted' && !terminal ? 'Execution interrupted' : 'Execution ended'}
      </span>
      <div className="grid grid-cols-[6.75rem_6rem_7.5rem] gap-2 shrink-0">
        <div>{!terminal && runtime.state === 'interrupted' && <button type="button" className={`${buttonClass} w-full`} disabled={!!pending}
          onClick={() => void action('resume')}>{pending === 'resume' ? 'Resuming…' : 'Resume task'}</button>}</div>
        <div>{!terminal && <button type="button" className={`${buttonClass} w-full`} disabled={!!pending}
          onClick={() => void action('stop')}>{pending === 'stop' ? 'Stopping…' : 'Stop task'}</button>}</div>
        <div>{waiting && <button type="button" className={`${buttonClass} w-full`}
          onClick={() => setActiveView('inbox')}>Open the Inbox</button>}</div>
      </div>
    </div>
    <div role="alert" className="h-9 overflow-y-auto text-xs text-[var(--color-danger)]">{error}</div>
    {runtime.reason && <p className="text-xs text-[var(--color-text-secondary)]">{runtime.reason}</p>}
    <details className="text-[11px] text-[var(--color-text-muted)]">
      <summary className="cursor-pointer font-medium text-[var(--color-accent)]">Execution limits</summary>
      <p className="pt-2">{runtime.ownerTurns} of {runtime.budget.maxRounds} turns used. Time limit: {runtime.budget.maxMinutes} minutes. Time pauses at saved task questions; approvals within a running agent turn still count.</p>
    </details>
  </section>
}
