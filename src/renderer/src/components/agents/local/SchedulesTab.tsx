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
import { ScheduleEditor, catchUpExplanation, scheduleButtonClass as buttonClass, scheduleDialogClass, scheduleTimingLabel } from './ScheduleEditor'
import { ScheduleHistory, scheduleStatusLabels, scheduleTime } from './ScheduleHistory'
import { relativeTimeUntil, useNow } from './scheduleClock'

/**
 * Whether a schedule runs on this device. The switch acts at once: the editor
 * already showed the timing and the instructions, and the list above names
 * both, so turning it on is not a second review.
 */
export function ScheduleSwitch({ item, checked, disabled, onToggle }: { item: LocalScheduleItem; checked: boolean; disabled: boolean; onToggle(): void }) {
  return <button type="button" role="switch" aria-checked={checked} disabled={disabled} onClick={onToggle}
    aria-label={`Run “${item.name}” on this device`}
    title={checked ? `“${item.name}” runs on this device` : `“${item.name}” does not run on this device`}
    className={`relative h-5 w-9 shrink-0 rounded-full transition-colors ${checked ? 'bg-[var(--color-accent)]' : 'bg-[var(--color-border)]'} ${disabled ? 'cursor-not-allowed opacity-50' : ''}`}>
    <div className={`absolute top-0.5 h-4 w-4 rounded-full bg-white transition-transform ${checked ? 'left-[18px]' : 'left-0.5'}`} />
  </button>
}

/** The card's timing line: template, custom days and hours, or cron, then the zone. The raw cron is the tooltip. */
export function ScheduleTimingLine({ item }: { item: LocalScheduleItem }) {
  const timing = scheduleTimingLabel(item)
  return <p title={`${item.cron} · ${item.timezone}`} className="mt-1 break-words text-[12px] text-[var(--color-text-secondary)]">
    {timing.label}{timing.detail && <> · <span className={timing.mono ? 'font-mono' : undefined}>{timing.detail}</span></>} · {item.timezone}
  </p>
}

/**
 * "Next scheduled time: … · in 8 hours", or "Off on this device". The line is
 * there in both states, so turning the switch moves nothing below the card
 * (ux_rules rule 1).
 */
export function ScheduleNextLine({ item, now }: { item: LocalScheduleItem; now: number }) {
  const next = item.binding?.enabled ? item.binding.nextDueAt ?? null : undefined
  return <p className="mt-1 text-[12px] text-[var(--color-text-secondary)]">
    {next === undefined ? 'Off on this device' : next === null ? 'Next scheduled time: —' : `Next scheduled time: ${scheduleTime(next, item.timezone)} · ${relativeTimeUntil(next, now)}`}
  </p>
}

/**
 * What a card's error was about. A switch error is shown only while the row
 * still looks as it did when the action failed, so a later poll that brings a
 * new problem line does not leave a stale alert under it.
 */
export function scheduleRowVersion(item: LocalScheduleItem): string {
  return JSON.stringify([item.revision, item.problem, item.binding?.enabled ?? null, item.binding?.reason ?? null])
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
  // Always refetched on mount: opening the tab must show what the scheduler
  // did since, not a cached list from a few seconds ago.
  const query = useQuery({ queryKey: key, queryFn: () => window.api.localSchedules.editor(agentId), refetchInterval: 5000, refetchOnMount: 'always', retry: 1 })
  const now = useNow()
  const [editor, setEditor] = useState<{ item?: LocalScheduleItem; stamp: FileStamp } | null>(null)
  const [remove, setRemove] = useState<{ item: LocalScheduleItem; stamp: FileStamp } | null>(null)
  const [history, setHistory] = useState<string | null>(null)
  const [pending, setPending] = useState<string | null>(null)
  const pendingRef = useRef(false)
  const [error, setError] = useState<{ name: string; text: string; version?: string } | null>(null)
  const [warning, setWarning] = useState<string | null>(null)
  const refresh = () => { void client.invalidateQueries({ queryKey: key }); void client.invalidateQueries({ queryKey: ['jobs'] }); void client.invalidateQueries({ queryKey: ['local-schedule-history'] }) }
  const toggle = async (item: LocalScheduleItem) => {
    if (pendingRef.current) return
    const turnOff = !!item.binding?.enabled
    if (!turnOff && !item.revision) return
    pendingRef.current = true; setPending(`toggle:${item.name}`); setError(null)
    try {
      if (turnOff) await window.api.localSchedules.disable(item.binding!.id)
      else await window.api.localSchedules.enable({ profileUserId: item.profileUserId, agentId, name: item.name, revision: item.revision!, timezone: item.timezone })
      // A save warning said this schedule could not be turned on; it now is.
      if (!turnOff) setWarning(null)
      refresh()
    } catch (cause) { setError({ name: item.name, version: scheduleRowVersion(item), text: unwrapIpcError(cause, turnOff ? 'This schedule could not be disabled.' : 'This schedule could not be enabled.') }) }
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
  const busy = !!pending || !!editor || !!remove
  return <section aria-label="Local schedules">
    <SettingsSection title="Schedules on this device" info={<SettingsInfoTip label="How schedules run">{catchUpExplanation} Disabling stops future runs. Use Stop in execution history or in the task for work already started.</SettingsInfoTip>}
      action={<button type="button" disabled={busy || !query.data || !!query.error || !profileUserId} onClick={() => setEditor({ stamp: query.data!.stamp })} className={buttonClass}>New schedule</button>}>
      {query.isPending && <p className="text-[13px] text-[var(--color-text-muted)]">Loading schedules…</p>}
      {!query.error && query.data?.items.length === 0 && <p className="text-[13px] text-[var(--color-text-muted)]">No schedules yet. Create one to run this agent at selected times.</p>}
      {query.data?.items.map((item, index) => <article key={`${item.name}:${index}`} aria-label={item.name}
        className="rounded-lg border border-[var(--color-border)] bg-[var(--color-bg-secondary)] p-4">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <h3 className="break-words text-[14px] font-medium">{item.name}</h3>
            <ScheduleTimingLine item={item} />
          </div>
          <div className="flex items-center gap-3">
            <ScheduleSwitch item={item} checked={!!item.binding?.enabled} onToggle={() => void toggle(item)}
              disabled={busy || !!query.error || (!item.binding?.enabled && (!!item.problem || !item.revision))} />
            <ScheduleActions item={item} disabled={busy || !!query.error} historyOpen={history === item.binding?.id}
              onEdit={() => setEditor({ item, stamp: query.data!.stamp })} onDelete={() => { setError(null); setRemove({ item, stamp: query.data!.stamp }) }} onHistory={() => setHistory(history === item.binding?.id ? null : item.binding!.id)} />
          </div>
        </div>
        {(item.problem ?? item.binding?.reason) && <p className="mt-2 text-[12px] text-[var(--color-text-secondary)]">{item.problem ?? item.binding?.reason}</p>}
        <ScheduleNextLine item={item} now={now} />
        {history !== item.binding?.id && <div className="mt-2 flex items-center justify-between gap-2 text-[12px]">
          <span className="min-w-0 text-[var(--color-text-secondary)]">{item.binding?.last ? `${item.binding.last.resultKind === 'quiet_ok' ? 'Quiet success' : scheduleStatusLabels[item.binding.last.status]} · ${item.binding.last.startedAt != null ? `Started ${scheduleTime(item.binding.last.startedAt, item.timezone)}` : `Scheduled for ${scheduleTime(item.binding.last.scheduledFor ?? item.binding.last.utcMinute * 60000, item.timezone)}`}` : 'No scheduled runs yet.'}</span>
          {item.binding?.last?.taskId && <button type="button" className={buttonClass} onClick={() => openTask(item.binding!.last!.taskId!)}>Open task</button>}
        </div>}
        {history !== item.binding?.id && item.binding?.last?.reason && <p className="mt-1 text-[12px] text-[var(--color-text-secondary)]">{item.binding.last.reason}</p>}
        {history === item.binding?.id && <ScheduleHistory item={item} onChanged={refresh} />}
        {error?.name === item.name && error.version === scheduleRowVersion(item) && !remove && <p role="alert" className="mt-2 text-[13px] text-[var(--color-danger)]">{error.text}</p>}
      </article>)}
      {warning && <p role="alert" className="text-[13px] text-[var(--color-danger)]">{warning}</p>}
      {query.error && <p role="alert" className="text-[13px] text-[var(--color-danger)]">{unwrapIpcError(query.error, 'Schedules could not be loaded.')}</p>}
    </SettingsSection>
    {editor && profileUserId && <ScheduleEditor agentId={agentId} profileUserId={profileUserId} stamp={editor.stamp} item={editor.item} onClose={() => setEditor(null)} onSaved={(message) => { setWarning(message ?? null); refresh() }} />}
    {remove && <DeleteScheduleDialog item={remove.item} pending={pending === 'delete'} error={error?.name === remove.item.name ? error.text : null} onClose={() => setRemove(null)} onDelete={() => void deleteSchedule()} />}
  </section>
}

export function SchedulesTab({ agentId }: { agentId: string }) {
  const profileUserId = useAuthStore((state) => state.currentUser?.id ?? null)
  return <SchedulesContent key={`${profileUserId}:${agentId}`} agentId={agentId} profileUserId={profileUserId} />
}
