import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import type { LocalScheduleItem } from '../../../../../shared/localSchedules'
import { useAuthStore } from '../../../stores/auth.store'
import { useOpenTask } from '../../../hooks/useTasks'
import { unwrapIpcError } from '../../../utils/ipcError'

const buttonClass = 'shrink-0 rounded-md border border-[var(--color-border)] px-3 py-1.5 text-xs font-medium text-[var(--color-text)] hover:bg-[var(--color-bg-hover)] disabled:opacity-50'
const statusLabels = { prepared: 'Queued', dispatched: 'In progress', completed: 'Completed', failed: 'Failed', cancelled: 'Cancelled', interrupted: 'Needs review', skipped_overlap: 'Skipped: previous run unfinished' }

function EnableScheduleDialog({ item, agentId, onClose, onEnabled }: { item: LocalScheduleItem; agentId: string; onClose(): void; onEnabled(): void }) {
  const dialog = useRef<HTMLDialogElement>(null)
  const pendingRef = useRef(false)
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => { dialog.current?.showModal() }, [])
  const submit = async () => {
    if (pendingRef.current || !item.revision) return
    pendingRef.current = true; setPending(true); setError(null)
    try {
      await window.api.localSchedules.enable({ profileUserId: item.profileUserId, agentId, name: item.name, revision: item.revision, timezone: item.timezone })
      onEnabled(); onClose()
    } catch (cause) { setError(unwrapIpcError(cause, 'This schedule could not be enabled.')) }
    finally { pendingRef.current = false; setPending(false) }
  }
  return createPortal(<dialog ref={dialog} aria-label="Enable schedule"
    onCancel={(event) => { event.preventDefault(); if (!pendingRef.current) onClose() }}
    className="m-auto w-[32rem] max-w-[calc(100vw-2rem)] max-h-[calc(100vh-2rem)] overflow-y-auto rounded-xl border border-[var(--color-border)] bg-[var(--color-bg-secondary)] p-5 text-[var(--color-text)] shadow-lg backdrop:bg-black/25">
    <form onSubmit={(event) => { event.preventDefault(); void submit() }} className="space-y-3">
      <h2 className="text-sm font-semibold">Enable schedule</h2>
      <p className="break-words text-xs font-medium">{item.name}</p>
      <p className="text-xs text-[var(--color-text-secondary)]">Runs this agent for this profile on this device while Cinna is open. The first run is at a later matching minute. Missed times are skipped; an unfinished run, including a waiting or interrupted task, prevents another run.</p>
      <p className="break-words font-mono text-[11px]">{item.cron} · {item.timezone}</p>
      <label className="block space-y-1.5 text-xs">Prompt
        <textarea aria-label="Prompt" readOnly value={item.prompt} rows={7}
          className="block w-full resize-none rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] p-2 text-xs" />
      </label>
      <p className="text-[11px] text-[var(--color-text-secondary)]">Each run has a 20-turn and 60-minute limit. Questions appear in the Inbox. Cinna creates a Job for these runs; changing its instructions or this schedule requires review again.</p>
      <div className="flex justify-end gap-2">
        <button type="button" disabled={pending} onClick={onClose} className="px-3 py-1.5 text-xs">Cancel</button>
        <button type="submit" disabled={pending} className="min-w-40 rounded-md bg-[var(--color-accent)] px-3 py-1.5 text-xs font-medium text-white disabled:opacity-50">{pending ? 'Enabling…' : 'Enable on this device'}</button>
      </div>
      <div role="alert" className="h-12 overflow-y-auto text-xs text-[var(--color-danger)]">{error}</div>
    </form>
  </dialog>, document.body)
}

function SchedulesContent({ agentId, profileUserId }: { agentId: string; profileUserId: string | null }) {
  const client = useQueryClient()
  const openTask = useOpenTask()
  const key = ['local-schedules', profileUserId, agentId]
  const query = useQuery({ queryKey: key, queryFn: () => window.api.localSchedules.list(agentId), refetchInterval: 5000, retry: 1 })
  const [review, setReview] = useState<LocalScheduleItem | null>(null)
  const [pending, setPending] = useState<string | null>(null)
  const pendingRef = useRef(false)
  const [error, setError] = useState<{ name: string; text: string } | null>(null)
  const refresh = () => { void client.invalidateQueries({ queryKey: key }); void client.invalidateQueries({ queryKey: ['jobs'] }) }
  const disable = async (item: LocalScheduleItem) => {
    if (!item.binding || pendingRef.current) return
    pendingRef.current = true; setPending(item.binding.id); setError(null)
    try { await window.api.localSchedules.disable(item.binding.id); refresh() }
    catch (cause) { setError({ name: item.name, text: unwrapIpcError(cause, 'This schedule could not be disabled.') }) }
    finally { pendingRef.current = false; setPending(null) }
  }
  return <section className="space-y-3" aria-label="Local schedules">
    <div className="flex items-center justify-between gap-2">
      <h2 className="text-xs font-semibold">Schedules on this device</h2>
      <button type="button" onClick={refresh} className={buttonClass}>Refresh</button>
    </div>
    <p className="text-xs text-[var(--color-text-secondary)]">Runs while Cinna is open and this profile is active. Enable each schedule after reviewing its prompt. Disabling stops future runs; use the task’s Stop control for work already started.</p>
    {query.isPending && <p className="text-xs text-[var(--color-text-muted)]">Loading schedules…</p>}
    <div role="alert" className="h-10 overflow-y-auto text-xs text-[var(--color-danger)]">{query.error ? unwrapIpcError(query.error, 'Schedules could not be loaded.') : null}</div>
    {!query.error && query.data?.length === 0 && <p className="text-xs text-[var(--color-text-muted)]">This agent has no manifest schedules.</p>}
    {query.data?.map((item, index) => <article key={`${item.name}:${index}`} aria-label={item.name}
      className="rounded-lg border border-[var(--color-border)] bg-[var(--color-bg-secondary)] p-3">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 className="break-words text-xs font-medium">{item.name}</h3>
          <p className="mt-1 break-words font-mono text-[10px] text-[var(--color-text-secondary)]">{item.cron} · {item.timezone}</p>
        </div>
        <button type="button" disabled={!!pending || !!query.error || (!item.binding?.enabled && !!item.problem)}
          onClick={() => item.binding?.enabled ? void disable(item) : setReview(item)}
          className={`${buttonClass} min-w-36`}>{pending === item.binding?.id ? 'Disabling…' : item.binding?.enabled ? 'Disable' : 'Review and enable'}</button>
      </div>
      <div className="mt-2 h-10 overflow-y-auto text-[11px] text-[var(--color-text-secondary)]" role={error?.name === item.name ? 'alert' : undefined}>
        {error?.name === item.name ? error.text : item.problem ?? item.binding?.reason ?? (item.binding?.enabled ? 'Enabled for this profile on this device.' : 'Not enabled on this device.')}
      </div>
      <div className="flex min-h-8 items-center justify-between gap-2 text-[11px]">
        <span className="min-w-0 text-[var(--color-text-muted)]">{item.binding?.last ? `${statusLabels[item.binding.last.status]} · ${new Date(item.binding.last.utcMinute * 60000).toLocaleString()}` : 'No scheduled runs yet.'}</span>
        {item.binding?.last?.taskId && <button type="button" className={buttonClass} onClick={() => openTask(item.binding!.last!.taskId!)}>Open task</button>}
      </div>
      <p className="mt-1 h-10 overflow-y-auto text-[11px] text-[var(--color-text-secondary)]">{item.binding?.last?.reason}</p>
    </article>)}
    {review && <EnableScheduleDialog item={review} agentId={agentId} onClose={() => setReview(null)} onEnabled={refresh} />}
  </section>
}

export function SchedulesTab({ agentId }: { agentId: string }) {
  const profileUserId = useAuthStore((state) => state.currentUser?.id ?? null)
  return <SchedulesContent key={`${profileUserId}:${agentId}`} agentId={agentId} profileUserId={profileUserId} />
}
