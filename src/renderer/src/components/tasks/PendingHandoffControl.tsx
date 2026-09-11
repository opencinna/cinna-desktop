import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useOpenExternal } from '../../hooks/useSystem'
import { unwrapIpcError } from '../../utils/ipcError'
import type { TaskHandoffReceipt } from '../../../../shared/taskHandoff'

/** A receipt stays reachable even if a peer deletes the original task. */
export function PendingHandoffControl({ taskId, chatId, children }: { taskId?: string; chatId?: string | null; children?: React.ReactNode }): React.JSX.Element | null {
  const [open, setOpen] = useState(false)
  const receipt = useQuery({ queryKey: ['pending-handoff', taskId, chatId],
    queryFn: () => taskId ? window.api.tasks.handoffReceipt(taskId) : window.api.tasks.pendingChatHandoff(chatId!),
    enabled: !!taskId || !!chatId, retry: false, refetchInterval: 5000 })
  const pending = receipt.data && ['creating', 'executing', 'accepted_pending', 'uncertain'].includes(receipt.data.state)
  if (!pending) return <>{children}</>
  return <>
    <button type="button" onClick={() => setOpen(true)} className="text-xs px-3 py-1.5 rounded-md border border-[var(--color-border)] text-[var(--color-warning)]">Review pending handoff</button>
    {open && <Recovery receipt={receipt.data!} onClose={() => setOpen(false)} />}
  </>
}

function Recovery({ receipt, onClose }: { receipt: TaskHandoffReceipt; onClose: () => void }): React.JSX.Element {
  const dialog = useRef<HTMLDialogElement>(null)
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const client = useQueryClient()
  const openExternal = useOpenExternal()
  useEffect(() => { dialog.current?.showModal() }, [])
  const resolve = async (): Promise<void> => {
    setPending(true)
    setError(null)
    try {
      await window.api.tasks.resolveHandoff(receipt.taskId)
      void client.invalidateQueries({ queryKey: ['pending-handoff'] })
      void client.invalidateQueries({ queryKey: ['task', receipt.taskId] })
      onClose()
    } catch (cause) { setError(unwrapIpcError(cause, 'This handoff could not be resolved.')) }
    finally { setPending(false) }
  }
  const button = 'px-3 py-1.5 rounded-md text-xs font-medium text-[var(--color-text-secondary)] border border-[var(--color-border)] disabled:opacity-50'
  return createPortal(<dialog ref={dialog} aria-label="Review pending handoff"
    onCancel={(event) => { event.preventDefault(); if (!pending) onClose() }}
    className="m-auto w-[28rem] max-w-[calc(100vw-2rem)] rounded-xl border border-[var(--color-border)] bg-[var(--color-bg-secondary)] p-5 text-[var(--color-text)] shadow-lg backdrop:bg-black/25">
    <h2 className="text-sm font-semibold mb-3">Review pending handoff</h2>
    <p className="text-xs">{receipt.message ?? 'The service may have started work on this task.'}</p>
    <p className="text-xs mt-2">Check the service before continuing here. This action does not stop remote work.</p>
    <div role="alert" className="h-20 overflow-y-auto py-2 text-xs text-[var(--color-danger)]">{error}</div>
    <div className="flex justify-end gap-2">
      <button type="button" className={button} disabled={pending} onClick={onClose}>Cancel</button>
      {receipt.remote?.url && <button type="button" className={button} disabled={pending} onClick={() => {
        void openExternal(receipt.remote!.url!).then((result) => { if (!result.success) setError(result.error) })
      }}>Open service</button>}
      <button type="button" className={button} disabled={pending} onClick={() => void resolve()}>Continue here anyway</button>
    </div>
  </dialog>, document.body)
}
