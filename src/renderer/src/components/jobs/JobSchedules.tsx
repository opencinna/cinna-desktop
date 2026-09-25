import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import type { LocalScheduleItem } from '../../../../shared/localSchedules'
import type { LocalJobScheduleSnapshot } from '../../../../shared/localJobSchedules'
import { useAuthStore } from '../../stores/auth.store'
import { useOpenTask } from '../../hooks/useTasks'
import { unwrapIpcError } from '../../utils/ipcError'
import { SettingsInfoTip, SettingsSection } from '../settings/SettingsLayout'
import { ScheduleEditor, catchUpExplanation, scheduleButtonClass, scheduleDialogClass, scheduleInputClass } from '../agents/local/ScheduleEditor'
import { ScheduleHistory, scheduleStatusLabels, scheduleTime } from '../agents/local/ScheduleHistory'
import { ScheduleActions } from '../agents/local/SchedulesTab'
import { JobScheduleScriptReview } from './JobScheduleScriptReview'
import { ScheduleNextTime } from '../agents/local/ScheduleNextTime'

function JobScheduleReview({ snapshot, item, onClose, onEnabled }: { snapshot: LocalJobScheduleSnapshot; item: LocalScheduleItem; onClose(): void; onEnabled(): void }) {
  const dialog = useRef<HTMLDialogElement>(null)
  const pendingRef = useRef(false)
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => { dialog.current?.showModal() }, [])
  const submit = async () => {
    if (pendingRef.current || !item.binding || !item.revision) return
    pendingRef.current = true; setPending(true); setError(null)
    try {
      await window.api.jobSchedules.enable({ profileUserId: snapshot.profileUserId, jobId: snapshot.jobId, jobRevision: snapshot.jobRevision, id: item.binding.id, revision: item.revision })
      onEnabled(); onClose()
    } catch (cause) { setError(unwrapIpcError(cause, 'This schedule could not be enabled.')) }
    finally { pendingRef.current = false; setPending(false) }
  }
  return createPortal(<dialog ref={dialog} aria-label="Enable schedule" className={scheduleDialogClass} onCancel={(event) => { event.preventDefault(); if (!pendingRef.current) onClose() }}>
    <form className="min-w-0 space-y-4" onSubmit={(event) => { event.preventDefault(); void submit() }}>
      <h2 className="text-[16px] font-semibold">Enable schedule</h2>
      <p className="text-[13px] font-medium">{item.name} · {snapshot.jobTitle}</p>
      <p className="break-words font-mono text-[12px]">{item.cron} · {item.timezone}</p>
      <ScheduleNextTime cron={item.cron} timezone={item.timezone} />
      <p className="text-[13px] text-[var(--color-text-secondary)]">{snapshot.jobSummary}</p>
      <label className="block space-y-1.5 text-[13px]">Job prompt<textarea aria-label="Job prompt" readOnly value={snapshot.jobPrompt} rows={5} className={scheduleInputClass} /></label>
      <JobScheduleScriptReview script={snapshot.jobScript} />
      <p className="text-[12px] text-[var(--color-text-secondary)]">{catchUpExplanation} The first run after enabling is in the future. An unfinished task prevents another run.</p>
      <p className="text-[12px] text-[var(--color-text-secondary)]">Each run starts a new task using this Job’s instructions, runtime, and limits. Changing the Job requires review again.</p>
      <div className="flex justify-end gap-2"><button type="button" disabled={pending} onClick={onClose} className={scheduleButtonClass}>Cancel</button><button type="submit" disabled={pending} className={`${scheduleButtonClass} bg-[var(--color-accent)] text-white`}>{pending ? 'Enabling…' : 'Enable on this device'}</button></div>
      {error && <p role="alert" className="text-[13px] text-[var(--color-danger)]">{error}</p>}
    </form>
  </dialog>, document.body)
}

function DeleteJobSchedule({ item, pending, error, onClose, onDelete }: { item: LocalScheduleItem; pending: boolean; error: string | null; onClose(): void; onDelete(): void }) {
  const dialog = useRef<HTMLDialogElement>(null)
  useEffect(() => { dialog.current?.showModal() }, [])
  return createPortal(<dialog ref={dialog} aria-label="Delete schedule" className={scheduleDialogClass} onCancel={(event) => { event.preventDefault(); if (!pending) onClose() }}>
    <div className="space-y-4"><h2 className="text-[16px] font-semibold">Delete schedule</h2>
      <p className="text-[13px]">The Job and its existing tasks are kept. Delete “{item.name}” and stop future scheduled runs? Work already started keeps running and can be stopped from its task.</p>
      <div className="flex justify-end gap-2"><button type="button" disabled={pending} className={scheduleButtonClass} onClick={onClose}>Cancel</button><button type="button" disabled={pending} className={`${scheduleButtonClass} text-[var(--color-danger)]`} onClick={onDelete}>{pending ? 'Deleting…' : 'Delete schedule'}</button></div>
      {error && <p role="alert" className="text-[13px] text-[var(--color-danger)]">{error}</p>}
    </div>
  </dialog>, document.body)
}

function JobSchedulesContent({ jobId, profileUserId }: { jobId: string; profileUserId: string | null }) {
  const client = useQueryClient()
  const openTask = useOpenTask()
  const queryKey = ['job-schedules', profileUserId, jobId]
  const query = useQuery({ queryKey, queryFn: () => window.api.jobSchedules.list(jobId), refetchInterval: 5000, retry: 1 })
  const executionVersion = query.data ? JSON.stringify(query.data.items.map((item) => [item.binding?.last?.id, item.binding?.last?.status, item.binding?.last?.taskId])) : null
  useEffect(() => {
    if (executionVersion === null) return
    // Idle Job histories do not poll. A main-owned scheduled run must become
    // visible there even when no chat is open to publish a live-run event.
    void client.invalidateQueries({ queryKey: ['jobs', jobId] })
  }, [client, jobId, executionVersion])
  const [editing, setEditing] = useState<{ snapshot: LocalJobScheduleSnapshot; item?: LocalScheduleItem } | null>(null)
  const [review, setReview] = useState<{ snapshot: LocalJobScheduleSnapshot; item: LocalScheduleItem } | null>(null)
  const [removing, setRemoving] = useState<LocalScheduleItem | null>(null)
  const [history, setHistory] = useState<string | null>(null)
  const pendingRef = useRef(false)
  const [pending, setPending] = useState<string | null>(null)
  const [error, setError] = useState<{ name: string; text: string } | null>(null)
  const refresh = () => {
    void client.invalidateQueries({ queryKey })
    void client.invalidateQueries({ queryKey: ['job-schedule-history'] })
    void client.invalidateQueries({ queryKey: ['jobs'] })
  }
  const mutate = async (item: LocalScheduleItem, operation: 'disable' | 'delete') => {
    if (pendingRef.current || !item.binding) return
    pendingRef.current = true; setPending(item.binding.id); setError(null)
    try {
      await window.api.jobSchedules[operation]({ profileUserId: item.profileUserId, jobId, id: item.binding.id, revision: item.revision })
      if (operation === 'delete') setRemoving(null)
      refresh()
    } catch (cause) { setError({ name: item.name, text: unwrapIpcError(cause, `This schedule could not be ${operation === 'delete' ? 'deleted' : 'disabled'}.`) }) }
    finally { pendingRef.current = false; setPending(null) }
  }
  const busy = !!pending || !!editing || !!review || !!removing
  return <section aria-label="Job schedules" className="min-w-0 pt-3">
    <SettingsSection title="Schedules on this device" info={<SettingsInfoTip label="How Job schedules run">{catchUpExplanation} Each occurrence starts a task for this Job. Disabling stops future runs; use the task’s Stop control for work already started.</SettingsInfoTip>}
      action={<button type="button" className={scheduleButtonClass} disabled={busy || !query.data || !!query.error} onClick={() => setEditing({ snapshot: query.data! })}>New schedule</button>}>
      {query.isPending && <p className="text-[13px] text-[var(--color-text-muted)]">Loading schedules…</p>}
      {!query.isPending && !query.error && query.data?.items.length === 0 && <p className="text-[13px] text-[var(--color-text-muted)]">No schedules yet. Choose when this Job should start a task.</p>}
      {query.data?.items.map((item) => <article key={item.binding?.id ?? item.name} aria-label={item.name} className="rounded-lg border border-[var(--color-border)] bg-[var(--color-bg-secondary)] p-4">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0"><h3 className="break-words text-[14px] font-medium">{item.name}</h3><p className="mt-1 break-words font-mono text-[12px] text-[var(--color-text-secondary)]">{item.cron} · {item.timezone}</p></div>
          <div className="flex items-center gap-2"><button type="button" className={scheduleButtonClass} disabled={busy || !!query.error || (!item.binding?.enabled && !item.revision)}
            onClick={() => item.binding?.enabled ? void mutate(item, 'disable') : setReview({ item, snapshot: query.data! })}>{pending === item.binding?.id ? 'Updating…' : item.binding?.enabled ? 'Disable' : 'Review and enable'}</button>
            <ScheduleActions item={item} disabled={busy || !!query.error} historyOpen={history === item.binding?.id} onEdit={() => setEditing({ item, snapshot: query.data! })} onDelete={() => { setError(null); setRemoving(item) }} onHistory={() => setHistory(history === item.binding?.id ? null : item.binding!.id)} />
          </div>
        </div>
        <p className="mt-2 text-[12px] text-[var(--color-text-secondary)]">{item.problem ?? item.binding?.reason ?? (item.binding?.enabled ? 'Enabled for this profile on this device.' : 'Not enabled on this device.')}</p>
        {item.binding?.enabled && item.binding.nextDueAt != null && <p className="mt-1 text-[12px] text-[var(--color-text-secondary)]">Next scheduled time: {scheduleTime(item.binding.nextDueAt, item.timezone)}</p>}
        {history !== item.binding?.id && <div className="mt-2 flex items-center justify-between gap-2 text-[12px]">
          <span className="text-[var(--color-text-secondary)]">{item.binding?.last ? `${scheduleStatusLabels[item.binding.last.status]} · ${item.binding.last.startedAt != null ? `Started ${scheduleTime(item.binding.last.startedAt, item.timezone)}` : `Scheduled for ${scheduleTime(item.binding.last.scheduledFor ?? item.binding.last.utcMinute * 60000, item.timezone)}`}` : 'No scheduled runs yet.'}</span>
          {item.binding?.last?.taskId && <button type="button" className={scheduleButtonClass} onClick={() => openTask(item.binding!.last!.taskId!)}>Open task</button>}
        </div>}
        {history === item.binding?.id && <ScheduleHistory item={item} target="job" onChanged={refresh} />}
        {!removing && error?.name === item.name && <p role="alert" className="mt-2 text-[13px] text-[var(--color-danger)]">{error.text}</p>}
      </article>)}
      {query.error && <p role="alert" className="text-[13px] text-[var(--color-danger)]">{unwrapIpcError(query.error, 'Schedules could not be loaded.')}</p>}
    </SettingsSection>
    {editing && <ScheduleEditor target="job" snapshot={editing.snapshot} item={editing.item} onClose={() => setEditing(null)} onSaved={refresh} />}
    {review && <JobScheduleReview snapshot={review.snapshot} item={review.item} onClose={() => setReview(null)} onEnabled={refresh} />}
    {removing && <DeleteJobSchedule item={removing} pending={!!pending} error={error?.name === removing.name ? error.text : null} onClose={() => setRemoving(null)} onDelete={() => void mutate(removing, 'delete')} />}
  </section>
}

export function JobSchedules({ jobId }: { jobId: string }) {
  const profileUserId = useAuthStore((state) => state.currentUser?.id ?? null)
  return <JobSchedulesContent key={`${profileUserId}:${jobId}`} jobId={jobId} profileUserId={profileUserId} />
}
