import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useQueryClient } from '@tanstack/react-query'
import { unwrapIpcError } from '../../utils/ipcError'

const fieldClass = 'w-full rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] px-2.5 py-1.5 text-xs text-[var(--color-text)]'

export function AutonomousTaskDialog({ chatId, initialGoal, onClose, onStarted }: {
  chatId: string; initialGoal: string; onClose(): void; onStarted(): void
}): React.JSX.Element {
  const dialog = useRef<HTMLDialogElement>(null)
  const pendingRef = useRef(false)
  const queryClient = useQueryClient()
  const [goal, setGoal] = useState(initialGoal)
  const [rounds, setRounds] = useState('20')
  const [minutes, setMinutes] = useState('60')
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => { dialog.current?.showModal() }, [])
  const submit = async (): Promise<void> => {
    if (pendingRef.current) return
    pendingRef.current = true
    setPending(true)
    setError(null)
    try {
      await window.api.tasks.runAutonomously({ chatId, goal, budget: { maxRounds: Number(rounds), maxMinutes: Number(minutes) } })
      void queryClient.invalidateQueries({ queryKey: ['tasks'] })
      void queryClient.invalidateQueries({ queryKey: ['chats'] })
      void queryClient.invalidateQueries({ queryKey: ['chat', chatId] })
      onStarted()
      onClose()
    } catch (cause) { setError(unwrapIpcError(cause, 'This task could not be started.')) }
    finally { pendingRef.current = false; setPending(false) }
  }
  return createPortal(<dialog ref={dialog} aria-label="Run on its own"
    onCancel={(event) => { event.preventDefault(); if (!pendingRef.current) onClose() }}
    className="m-auto w-[28rem] max-w-[calc(100vw-2rem)] rounded-xl border border-[var(--color-border)] bg-[var(--color-bg-secondary)] p-5 text-[var(--color-text)] shadow-lg backdrop:bg-black/25">
    <form onSubmit={(event) => { event.preventDefault(); void submit() }} className="space-y-4">
      <h2 className="text-sm font-semibold">Run on its own</h2>
      <p className="text-xs text-[var(--color-text-secondary)]">The model coordinates attached agents until the goal is done or it needs your answer. You can leave this conversation while the app stays open.</p>
      <label className="block space-y-1.5 text-xs">Goal
        <textarea autoFocus aria-label="Goal" rows={5} className={`${fieldClass} resize-none`} value={goal}
          maxLength={64000} disabled={pending} onChange={(event) => setGoal(event.target.value)} />
      </label>
      <details>
        <summary className="cursor-pointer text-xs font-medium text-[var(--color-accent)]">More options</summary>
        <div className="grid grid-cols-2 gap-3 pt-3">
          <label className="space-y-1 text-xs">Turn limit
            <input aria-label="Turn limit" type="number" min={1} max={1000} step={1} value={rounds} disabled={pending}
              className={fieldClass} onChange={(event) => setRounds(event.target.value)} />
          </label>
          <label className="space-y-1 text-xs">Time limit (minutes)
            <input aria-label="Time limit (minutes)" type="number" min={1} max={1440} step={1} value={minutes} disabled={pending}
              className={fieldClass} onChange={(event) => setMinutes(event.target.value)} />
          </label>
        </div>
        <p className="pt-2 text-[11px] text-[var(--color-text-muted)]">Time pauses at saved task questions; approvals within a running agent turn still count. Each coordinator or specialist turn counts toward the turn limit.</p>
      </details>
      <div className="flex justify-end gap-2">
        <button type="button" disabled={pending} onClick={onClose} className="px-3 py-1.5 text-xs text-[var(--color-text-secondary)]">Cancel</button>
        <button type="submit" disabled={pending || !goal.trim()} className="min-w-24 rounded-md px-3 py-1.5 text-xs font-medium bg-[var(--color-accent)] text-white disabled:opacity-50">{pending ? 'Starting…' : 'Start task'}</button>
      </div>
      <div role="alert" className="h-12 overflow-y-auto text-xs text-[var(--color-danger)]">{error}</div>
    </form>
  </dialog>, document.body)
}
