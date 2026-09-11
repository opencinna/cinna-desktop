import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Loader2 } from 'lucide-react'
import { PendingHandoffControl } from './PendingHandoffControl'
import { TASK_QUERY_KEY, useTakeOverTask } from '../../hooks/useTasks'
import { useOpenExternal } from '../../hooks/useSystem'
import { unwrapIpcError } from '../../utils/ipcError'
import type { TaskDto } from '../../../../shared/tasks'
import type { TaskHandoffReceipt } from '../../../../shared/taskHandoff'

const buttonClass = 'px-3 py-1.5 rounded-md text-xs font-medium border border-[var(--color-border)] text-[var(--color-text-secondary)] disabled:opacity-50'
const fieldClass = 'w-full rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] px-2.5 py-1.5 text-xs text-[var(--color-text)]'

export function HandOffTaskControl({ task }: { task: TaskDto }): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const offered = task.executor === 'desktop' && task.runsHere && !['completed', 'cancelled', 'archived'].includes(task.status)
  return <>
    <PendingHandoffControl taskId={task.id}>
    {offered && <button type="button" className={buttonClass} onClick={() => setOpen(true)}>Hand off</button>}
    </PendingHandoffControl>
    {open && <HandOffDialog key={task.id} task={task} onClose={() => setOpen(false)} />}
  </>
}

function HandOffDialog({ task, onClose }: { task: TaskDto; onClose: () => void }): React.JSX.Element {
  const dialog = useRef<HTMLDialogElement>(null)
  const queryClient = useQueryClient()
  const options = useQuery({ queryKey: ['task-handoff-options', task.id],
    queryFn: () => window.api.tasks.handoffOptions(task.id), retry: false, staleTime: 0 })
  const [selected, setSelected] = useState('')
  const [note, setNote] = useState(task.handoffNote ?? '')
  const [pending, setPending] = useState(false)
  const [recovering, setRecovering] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [receipt, setReceipt] = useState<TaskHandoffReceipt | null>(null)
  const { takeOver } = useTakeOverTask()
  const openExternal = useOpenExternal()
  const journal = useQuery({ queryKey: ['pending-handoff', task.id, undefined],
    queryFn: () => window.api.tasks.handoffReceipt(task.id), retry: false, refetchInterval: 5000 })
  const saved = [receipt, journal.data, options.data?.receipt].filter((entry): entry is TaskHandoffReceipt => !!entry)
    .sort((a, b) => b.updatedAt - a.updatedAt)[0]
  const unresolved = (!pending || recovering) && !!saved && ['creating', 'executing', 'accepted_pending', 'uncertain'].includes(saved.state)
  const assignees = options.data?.assignees ?? []
  const choice = selected || (saved?.assignee.ref && assignees.some((a) => a.ref === saved.assignee.ref)
    ? saved.assignee.ref : assignees[0]?.ref ?? '')
  useEffect(() => { dialog.current?.showModal() }, [])

  const submit = async (): Promise<void> => {
    if (pending || unresolved || !choice || !options.data?.adapterId) return
    setPending(true)
    setError(null)
    try {
      const result = await window.api.tasks.handOff(task.id, { adapterId: options.data.adapterId, ref: choice }, note)
      if (result.receipt) setReceipt(result.receipt)
      if (result.kind === 'accepted' && result.task) {
        queryClient.setQueryData(TASK_QUERY_KEY(task.id), result.task)
        void queryClient.invalidateQueries({ queryKey: ['tasks'] })
        if (task.chatId) void queryClient.invalidateQueries({ queryKey: ['chat', task.chatId] })
        onClose()
      } else setError(result.message)
    } catch (cause) {
      setError(unwrapIpcError(cause, 'This task could not be handed off.'))
      // The IPC acknowledgement may be lost after acceptance. Reload its journal.
      void journal.refetch()
    } finally { setPending(false) }
  }
  const recover = async (): Promise<void> => {
    setRecovering(true)
    setPending(true)
    setError(null)
    try { await takeOver(task.id, true); onClose() }
    catch (cause) { setError(unwrapIpcError(cause, 'This task could not be taken over.')) }
    finally { setPending(false); setRecovering(false) }
  }

  return createPortal(<dialog ref={dialog} aria-label="Hand off task"
    onCancel={(event) => { event.preventDefault(); if (!pending) onClose() }}
    className="m-auto w-[28rem] max-w-[calc(100vw-2rem)] rounded-xl border border-[var(--color-border)] bg-[var(--color-bg-secondary)] p-5 text-[var(--color-text)] shadow-lg backdrop:bg-black/25">
    <form onSubmit={(event) => { event.preventDefault(); void submit() }} className="space-y-4">
      <h2 className="text-sm font-semibold">Hand off task</h2>
      <label className="block space-y-1.5 text-xs">Remote agent
        <select aria-label="Remote agent" className={fieldClass} value={choice}
          disabled={pending || unresolved || options.isPending} onChange={(event) => setSelected(event.target.value)}>
          {!assignees.length && <option value="">{options.isPending ? 'Loading agents…' : 'No agents available'}</option>}
          {assignees.map((agent) => <option key={agent.ref} value={agent.ref}>{agent.name ?? agent.ref}</option>)}
        </select>
      </label>
      <label className="block space-y-1.5 text-xs">Handoff note
        <textarea aria-label="Handoff note" className={`${fieldClass} resize-none`} rows={5}
          value={note} maxLength={64000} disabled={pending || unresolved} onChange={(event) => setNote(event.target.value)}
          placeholder="What happened here, and what should happen next?" />
      </label>
      <div className="h-20 overflow-y-auto text-xs text-[var(--color-danger)]" role="alert">
        {error ?? (unresolved ? saved?.message ?? 'The previous handoff needs checking before work can start again.'
          : options.error ? unwrapIpcError(options.error, 'Could not load remote agents.') : options.data?.reason)}
        {unresolved && <p className="mt-1 text-[var(--color-text-secondary)]">Check the service before taking over. Taking over does not stop remote work.</p>}
        {!unresolved && (options.isError || (!options.isPending && !assignees.length)) && (
          <button type="button" className={`${buttonClass} mt-1`} disabled={pending || options.isFetching}
            onClick={() => void options.refetch()}>Retry</button>
        )}
      </div>
      <div className="flex justify-end gap-2">
        <button type="button" className={buttonClass} disabled={pending} onClick={onClose}>Cancel</button>
        {unresolved ? <>
          {saved?.remote?.url && <button type="button" className={buttonClass} disabled={pending} onClick={() => {
            void openExternal(saved.remote!.url!).then((result) => { if (!result.success) setError(result.error) })
          }}>Open service</button>}
          <button type="button" className={buttonClass} disabled={pending} onClick={() => void recover()}>Take over anyway</button>
        </> : <>
          <button type="submit" disabled={pending || options.isFetching || !choice || !!options.data?.reason}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium bg-[var(--color-accent)] text-white disabled:opacity-50">
            <span className="w-3">{pending && <Loader2 size={12} className="animate-spin" />}</span>Hand off
          </button>
        </>}
      </div>
    </form>
  </dialog>, document.body)
}
