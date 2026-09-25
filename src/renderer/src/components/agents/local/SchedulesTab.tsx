import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { MoreHorizontal } from 'lucide-react'
import type { FileStamp } from '../../../../../shared/localAgents'
import type { LocalScheduleItem } from '../../../../../shared/localSchedules'
import { useAuthStore } from '../../../stores/auth.store'
import { useOpenTask } from '../../../hooks/useTasks'
import { unwrapIpcError } from '../../../utils/ipcError'
import { SettingsInfoTip, SettingsSection } from '../../settings/SettingsLayout'
import { usePopover } from '../../ui/usePopover'
import { MENU_ITEM, MENU_SURFACE } from './OpenInMenu'
import { ScheduleEditor, catchUpExplanation, scheduleButtonClass as buttonClass, scheduleDialogClass } from './ScheduleEditor'
import { ScheduleHistory, scheduleStatusLabels, scheduleTime } from './ScheduleHistory'
import { ScheduleNextTime } from './ScheduleNextTime'

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
  const isScript = item.executionType === 'script_trigger'
  return createPortal(<dialog ref={dialog} aria-label="Enable schedule"
    onCancel={(event) => { event.preventDefault(); if (!pendingRef.current) onClose() }} className={scheduleDialogClass}>
    <form onSubmit={(event) => { event.preventDefault(); void submit() }} className="space-y-3">
      <h2 className="text-[16px] font-semibold">Enable schedule</h2>
      <p className="break-words text-[13px] font-medium">{item.name}</p>
      <p className="text-[13px] text-[var(--color-text-secondary)]">{catchUpExplanation} The first run after enabling is in the future. An unfinished run, including a waiting or interrupted task, prevents another run.</p>
      <p className="break-words font-mono text-[12px]">{item.cron} · {item.timezone}</p>
      <ScheduleNextTime cron={item.cron} timezone={item.timezone} />
      <label className="block space-y-1.5 text-[13px]">{isScript ? 'Command' : 'Prompt'}
        <textarea aria-label={isScript ? 'Command' : 'Prompt'} readOnly value={isScript ? item.command ?? '' : item.prompt} rows={7}
          className="block w-full resize-none rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] p-2 text-[13px]" />
      </label>
      {isScript && item.resolvedCommand && item.resolvedCommand !== item.command && <div><p className="mb-1 text-[13px] font-medium">Resolved command</p><pre className="max-h-48 overflow-auto whitespace-pre-wrap break-words rounded border border-[var(--color-border)] bg-[var(--color-bg)] p-2 text-[12px]">{item.resolvedCommand}</pre></div>}
      <p className="text-[12px] text-[var(--color-text-secondary)]">{isScript ? 'Commands run in the agent’s folder with a five-minute limit. Exit 0 with trimmed stdout exactly OK is recorded quietly; other completed results start an agent task.' : 'Each run has a 20-turn and 60-minute limit. Questions appear in the Inbox. Changing the instructions or timing requires review again.'}</p>
      <div className="flex justify-end gap-2">
        <button type="button" disabled={pending} onClick={onClose} className={buttonClass}>Cancel</button>
        <button type="submit" disabled={pending} className={`${buttonClass} bg-[var(--color-accent)] text-white`}>{pending ? 'Enabling…' : 'Enable on this device'}</button>
      </div>
      {error && <p role="alert" className="text-[13px] text-[var(--color-danger)]">{error}</p>}
    </form>
  </dialog>, document.body)
}

function DeleteScheduleDialog({ item, pending, error, onClose, onDelete }: { item: LocalScheduleItem; pending: boolean; error: string | null; onClose(): void; onDelete(): void }) {
  const dialog = useRef<HTMLDialogElement>(null)
  useEffect(() => { dialog.current?.showModal() }, [])
  return createPortal(<dialog ref={dialog} aria-label="Delete schedule" className={scheduleDialogClass}
    onCancel={(event) => { event.preventDefault(); if (!pending) onClose() }}>
    <div className="space-y-4">
      <h2 className="text-[16px] font-semibold">Delete schedule</h2>
      <p className="text-[13px]">Existing tasks and execution records are kept. Delete “{item.name}” from this agent’s manifest and stop future runs? Work already started keeps running and can be stopped separately.</p>
      <div className="flex justify-end gap-2"><button type="button" disabled={pending} className={buttonClass} onClick={onClose}>Cancel</button><button type="button" disabled={pending} className={`${buttonClass} text-[var(--color-danger)]`} onClick={onDelete}>{pending ? 'Deleting…' : 'Delete schedule'}</button></div>
      {error && <p role="alert" className="text-[13px] text-[var(--color-danger)]">{error}</p>}
    </div>
  </dialog>, document.body)
}

export function ScheduleActions({ item, disabled, onEdit, onDelete, onHistory, historyOpen }: { item: LocalScheduleItem; disabled: boolean; onEdit(): void; onDelete(): void; onHistory(): void; historyOpen: boolean }) {
  const menu = usePopover('below-right')
  const act = (action: () => void) => { menu.setOpen(false); action() }
  return <div>
    <button ref={menu.triggerRef} type="button" disabled={disabled} aria-label={`Actions for ${item.name}`} title={`Actions for ${item.name}`} aria-haspopup="menu" aria-expanded={menu.open}
      onClick={() => menu.setOpen(!menu.open)} className={`${buttonClass} px-2`}><MoreHorizontal size={16} /></button>
    {menu.open && createPortal(<div ref={menu.popoverRef} style={menu.style ?? undefined} role="menu" aria-label={`Actions for ${item.name}`} className={MENU_SURFACE}
      onKeyDown={(event) => { if (event.key === 'Escape') { menu.setOpen(false); menu.triggerRef.current?.focus() } }}>
      <button role="menuitem" type="button" className={MENU_ITEM} onClick={() => act(onEdit)}>Edit schedule</button>
      {item.binding && <button role="menuitem" type="button" className={MENU_ITEM} onClick={() => act(onHistory)}>{historyOpen ? 'Hide execution history' : 'Execution history'}</button>}
      <div className="my-1 border-t border-[var(--color-border)]" />
      <button role="menuitem" type="button" className={`${MENU_ITEM} text-[var(--color-danger)]`} onClick={() => act(onDelete)}>Delete schedule…</button>
    </div>, document.body)}
  </div>
}

function SchedulesContent({ agentId, profileUserId }: { agentId: string; profileUserId: string | null }) {
  const client = useQueryClient()
  const openTask = useOpenTask()
  const key = ['local-schedules', profileUserId, agentId]
  const query = useQuery({ queryKey: key, queryFn: () => window.api.localSchedules.editor(agentId), refetchInterval: 5000, retry: 1 })
  const [review, setReview] = useState<LocalScheduleItem | null>(null)
  const [editor, setEditor] = useState<{ item?: LocalScheduleItem; stamp: FileStamp } | null>(null)
  const [remove, setRemove] = useState<{ item: LocalScheduleItem; stamp: FileStamp } | null>(null)
  const [history, setHistory] = useState<string | null>(null)
  const [pending, setPending] = useState<string | null>(null)
  const pendingRef = useRef(false)
  const [error, setError] = useState<{ name: string; text: string } | null>(null)
  const [warning, setWarning] = useState<string | null>(null)
  const refresh = () => { void client.invalidateQueries({ queryKey: key }); void client.invalidateQueries({ queryKey: ['jobs'] }); void client.invalidateQueries({ queryKey: ['local-schedule-history'] }) }
  const disable = async (item: LocalScheduleItem) => {
    if (!item.binding || pendingRef.current) return
    pendingRef.current = true; setPending(item.binding.id); setError(null)
    try { await window.api.localSchedules.disable(item.binding.id); refresh() }
    catch (cause) { setError({ name: item.name, text: unwrapIpcError(cause, 'This schedule could not be disabled.') }) }
    finally { pendingRef.current = false; setPending(null) }
  }
  const deleteSchedule = async () => {
    if (!remove || !profileUserId || pendingRef.current) return
    pendingRef.current = true; setPending('delete'); setError(null)
    try {
      await window.api.localSchedules.delete({ profileUserId, agentId, expectedStamp: remove.stamp, name: remove.item.name, revision: remove.item.revision })
      setRemove(null); refresh()
    } catch (cause) { setError({ name: remove.item.name, text: unwrapIpcError(cause, 'This schedule could not be deleted.') }) }
    finally { pendingRef.current = false; setPending(null) }
  }
  const busy = !!pending || !!editor || !!review || !!remove
  return <section aria-label="Local schedules">
    <SettingsSection title="Schedules on this device" info={<SettingsInfoTip label="How schedules run">{catchUpExplanation} Disabling stops future runs. Use Stop in execution history or in the task for work already started.</SettingsInfoTip>}
      action={<div className="flex gap-2"><button type="button" disabled={busy || !query.data || !!query.error || !profileUserId} onClick={() => setEditor({ stamp: query.data!.stamp })} className={buttonClass}>New schedule</button><button type="button" onClick={refresh} className={buttonClass}>Refresh</button></div>}>
      {query.isPending && <p className="text-[13px] text-[var(--color-text-muted)]">Loading schedules…</p>}
      {!query.error && query.data?.items.length === 0 && <p className="text-[13px] text-[var(--color-text-muted)]">No schedules yet. Create one to run this agent at selected times.</p>}
      {query.data?.items.map((item, index) => <article key={`${item.name}:${index}`} aria-label={item.name}
        className="rounded-lg border border-[var(--color-border)] bg-[var(--color-bg-secondary)] p-4">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <h3 className="break-words text-[14px] font-medium">{item.name}</h3>
            <p className="mt-1 break-words font-mono text-[12px] text-[var(--color-text-secondary)]">{item.cron} · {item.timezone}</p>
          </div>
          <div className="flex items-center gap-2">
            <button type="button" disabled={busy || !!query.error || (!item.binding?.enabled && (!!item.problem || !item.revision))}
              onClick={() => item.binding?.enabled ? void disable(item) : setReview(item)} className={buttonClass}>{pending === item.binding?.id ? 'Disabling…' : item.binding?.enabled ? 'Disable' : 'Review and enable'}</button>
            <ScheduleActions item={item} disabled={busy || !!query.error} historyOpen={history === item.binding?.id}
              onEdit={() => setEditor({ item, stamp: query.data!.stamp })} onDelete={() => { setError(null); setRemove({ item, stamp: query.data!.stamp }) }} onHistory={() => setHistory(history === item.binding?.id ? null : item.binding!.id)} />
          </div>
        </div>
        <p className="mt-2 text-[12px] text-[var(--color-text-secondary)]">{item.problem ?? item.binding?.reason ?? (item.binding?.enabled ? 'Enabled for this profile on this device.' : 'Not enabled on this device.')}</p>
        {item.binding?.enabled && item.binding.nextDueAt != null && <p className="mt-1 text-[12px] text-[var(--color-text-secondary)]">Next scheduled time: {scheduleTime(item.binding.nextDueAt, item.timezone)}</p>}
        {history !== item.binding?.id && <div className="mt-2 flex items-center justify-between gap-2 text-[12px]">
          <span className="min-w-0 text-[var(--color-text-secondary)]">{item.binding?.last ? `${item.binding.last.resultKind === 'quiet_ok' ? 'Quiet success' : scheduleStatusLabels[item.binding.last.status]} · ${item.binding.last.startedAt != null ? `Started ${scheduleTime(item.binding.last.startedAt, item.timezone)}` : `Scheduled for ${scheduleTime(item.binding.last.scheduledFor ?? item.binding.last.utcMinute * 60000, item.timezone)}`}` : 'No scheduled runs yet.'}</span>
          {item.binding?.last?.taskId && <button type="button" className={buttonClass} onClick={() => openTask(item.binding!.last!.taskId!)}>Open task</button>}
        </div>}
        {history !== item.binding?.id && item.binding?.last?.reason && <p className="mt-1 text-[12px] text-[var(--color-text-secondary)]">{item.binding.last.reason}</p>}
        {history === item.binding?.id && <ScheduleHistory item={item} onChanged={refresh} />}
        {error?.name === item.name && !remove && <p role="alert" className="mt-2 text-[13px] text-[var(--color-danger)]">{error.text}</p>}
      </article>)}
      {warning && <p role="alert" className="text-[13px] text-[var(--color-danger)]">{warning}</p>}
      {query.error && <p role="alert" className="text-[13px] text-[var(--color-danger)]">{unwrapIpcError(query.error, 'Schedules could not be loaded.')}</p>}
    </SettingsSection>
    {review && <EnableScheduleDialog item={review} agentId={agentId} onClose={() => setReview(null)} onEnabled={refresh} />}
    {editor && profileUserId && <ScheduleEditor agentId={agentId} profileUserId={profileUserId} stamp={editor.stamp} item={editor.item} onClose={() => setEditor(null)} onSaved={(message) => { setWarning(message ?? null); refresh() }} />}
    {remove && <DeleteScheduleDialog item={remove.item} pending={pending === 'delete'} error={error?.name === remove.item.name ? error.text : null} onClose={() => setRemove(null)} onDelete={() => void deleteSchedule()} />}
  </section>
}

export function SchedulesTab({ agentId }: { agentId: string }) {
  const profileUserId = useAuthStore((state) => state.currentUser?.id ?? null)
  return <SchedulesContent key={`${profileUserId}:${agentId}`} agentId={agentId} profileUserId={profileUserId} />
}
