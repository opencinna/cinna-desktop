import { useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { FileStamp } from '../../../../../shared/localAgents'
import type { LocalScheduleItem } from '../../../../../shared/localSchedules'
import type { LocalJobScheduleSnapshot } from '../../../../../shared/localJobSchedules'
import {
  SCHEDULE_TEMPLATES, compileScheduleRule, normalizeScheduleEditorMetadata, scheduleRuleSummary,
  type ScheduleEditorMetadata, type ScheduleRule
} from '../../../../../shared/scheduleTemplates'
import { unwrapIpcError } from '../../../utils/ipcError'
import { JobScheduleScriptReview } from '../../jobs/JobScheduleScriptReview'

export const scheduleButtonClass = 'shrink-0 rounded-md border border-[var(--color-border)] px-3 py-1.5 text-[13px] font-medium text-[var(--color-text)] hover:bg-[var(--color-bg-hover)] disabled:opacity-50'
export const scheduleInputClass = 'block w-full rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] p-2 text-[13px] text-[var(--color-text)] disabled:opacity-60'
export const scheduleDialogClass = 'm-auto w-[54rem] max-w-[calc(100vw-2rem)] max-h-[calc(100vh-2rem)] overflow-y-auto rounded-xl border border-[var(--color-border)] bg-[var(--color-bg-secondary)] p-5 text-[var(--color-text)] shadow-lg backdrop:bg-black/25'
export const catchUpExplanation = 'Runs while Cinna is open and this profile is active. If scheduled times pass while Cinna is closed or asleep, it runs once when Cinna is available again.'
const days = [{ value: 1, label: 'Mon' }, { value: 2, label: 'Tue' }, { value: 3, label: 'Wed' }, { value: 4, label: 'Thu' }, { value: 5, label: 'Fri' }, { value: 6, label: 'Sat' }, { value: 0, label: 'Sun' }]
const hourLabel = (hour: number) => `${String(hour).padStart(2, '0')}:00`

export function ScheduleDaysHours({ rule, onChange, disabled = false }: { rule: ScheduleRule; onChange(rule: ScheduleRule): void; disabled?: boolean }) {
  const toggle = (field: keyof ScheduleRule, value: number) => onChange({ ...rule, [field]: rule[field].includes(value) ? rule[field].filter((entry) => entry !== value) : [...rule[field], value].sort((a, b) => a - b) })
  return <div className="min-w-0 space-y-3">
    <fieldset className="min-w-0" disabled={disabled} aria-invalid={rule.weekdays.length === 0}>
      <legend className="mb-2 text-[13px] font-medium">Days</legend>
      <div className="flex flex-wrap gap-3">{days.map((day) => <label key={day.value} className="flex items-center gap-1.5 text-[13px]">
        <input type="checkbox" checked={rule.weekdays.includes(day.value)} onChange={() => toggle('weekdays', day.value)} />{day.label}
      </label>)}</div>
    </fieldset>
    <fieldset className="min-w-0" disabled={disabled} aria-invalid={rule.hours.length === 0}>
      <legend className="mb-2 text-[13px] font-medium">Hours</legend>
      <div className="w-full min-w-0 max-w-full overflow-x-auto pb-1">
        <div data-testid="schedule-hour-grid" className="grid min-w-[45rem] gap-x-2 gap-y-3" style={{ gridTemplateColumns: 'repeat(12, minmax(0, 1fr))' }}>
          {Array.from({ length: 24 }, (_, hour) => <label key={hour} className="flex items-center gap-1 text-[12px] tabular-nums">
            <input type="checkbox" aria-label={hourLabel(hour)} checked={rule.hours.includes(hour)} onChange={() => toggle('hours', hour)} />{hourLabel(hour)}
          </label>)}
        </div>
      </div>
    </fieldset>
  </div>
}

function initialTiming(item?: LocalScheduleItem): { choice: string; rule: ScheduleRule; advanced: string } {
  const template = SCHEDULE_TEMPLATES[0]
  if (!item) return { choice: template.id, rule: template.rule, advanced: '' }
  const metadata = normalizeScheduleEditorMetadata(item.editorMetadata, item.cron)
  if (metadata?.mode === 'custom' || metadata?.mode === 'template') {
    const rule = { weekdays: metadata.weekdays!, hours: metadata.hours! }
    // Stored values remain authoritative even if a bundled template changes later.
    const current = SCHEDULE_TEMPLATES.find((entry) => entry.id === metadata.templateId)
    const sameTemplate = metadata.mode === 'template' && current && compileScheduleRule(current.rule) === compileScheduleRule(rule)
    return { choice: sameTemplate ? current.id : 'custom', rule, advanced: '' }
  }
  return { choice: 'advanced', rule: template.rule, advanced: item.cron }
}

type ScheduleEditorProps = {
  item?: LocalScheduleItem; onClose(): void; onSaved(warning?: string): void
} & ({ target?: 'agent'; agentId: string; profileUserId: string; stamp: FileStamp }
  | { target: 'job'; snapshot: LocalJobScheduleSnapshot })

export function ScheduleEditor(props: ScheduleEditorProps) {
  const { item, onClose, onSaved } = props
  const job = props.target === 'job' ? props.snapshot : null
  const agentId = props.target === 'job' ? '' : props.agentId
  const profileUserId = props.target === 'job' ? props.snapshot.profileUserId : props.profileUserId
  const dialog = useRef<HTMLDialogElement>(null)
  const pendingRef = useRef(false)
  const [pending, setPending] = useState(false)
  const [name, setName] = useState(item?.name ?? '')
  const [executionType, setExecutionType] = useState(item?.executionType ?? 'static_prompt')
  const [prompt, setPrompt] = useState(item?.prompt ?? '')
  const [command, setCommand] = useState(item?.command ?? '')
  const [timezone, setTimezone] = useState(item?.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone)
  const [enabled, setEnabled] = useState(item?.binding?.enabled ?? false)
  const initial = useMemo(() => initialTiming(item), [item])
  const [choice, setChoice] = useState(initial.choice)
  const [rule, setRule] = useState(initial.rule)
  const [advanced, setAdvanced] = useState(initial.advanced)
  const [replacement, setReplacement] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [preview, setPreview] = useState<{ key: string; text: string; error?: boolean; resolvedCommand?: string; commandRevision?: string } | null>(null)
  let cron = advanced
  let selectionError: string | null = null
  if (choice !== 'advanced') {
    try { cron = compileScheduleRule(rule) }
    catch (cause) { selectionError = cause instanceof Error ? cause.message : 'Select at least one day and one hour.'; cron = '' }
  }
  const previewKey = JSON.stringify([cron, timezone, executionType, command])
  useEffect(() => { dialog.current?.showModal() }, [])
  useEffect(() => {
    if (!cron.trim() || !timezone.trim()) return
    let current = true
    const timer = setTimeout(() => {
      window.api.localSchedules.preview({ cron, timezone, ...(executionType === 'script_trigger' ? { agentId, profileUserId, command } : {}) }).then((result) => {
        if (current) setPreview({ key: previewKey, text: `Next scheduled time: ${new Date(result.nextDueAt).toLocaleString(undefined, { timeZone: timezone })} (${timezone})`, resolvedCommand: result.resolvedCommand, commandRevision: result.commandRevision })
      }).catch((cause) => {
        if (current) setPreview({ key: previewKey, text: unwrapIpcError(cause, 'This timing rule is not valid.'), error: true })
      })
    }, 250)
    return () => { current = false; clearTimeout(timer) }
  }, [cron, timezone, previewKey, executionType, command, agentId, profileUserId])

  const selectChoice = (next: string) => {
    if (next === 'advanced') {
      // Keep the unsaved advanced draft when a user explores a replacement.
      if (!advanced) setAdvanced(cron)
      setChoice(next)
    } else if (next === 'custom') {
      setChoice(next)
    } else {
      const template = SCHEDULE_TEMPLATES.find((entry) => entry.id === next)!
      setRule({ weekdays: [...template.rule.weekdays], hours: [...template.rule.hours] })
      setChoice(next)
    }
    setReplacement(null)
  }
  const changeChoice = (next: string) => {
    if (choice === 'advanced' && next !== 'advanced') setReplacement(next)
    else selectChoice(next)
  }
  const submit = async () => {
    if (pendingRef.current) return
    if (!name.trim()) { setError('Enter a schedule name.'); return }
    if (!job && (executionType === 'static_prompt' ? !prompt.trim() : !command.trim())) { setError(executionType === 'static_prompt' ? 'Enter a prompt.' : 'Enter a command.'); return }
    if (selectionError) { setError(selectionError); return }
    if (executionType === 'script_trigger' && (preview?.key !== previewKey || !preview.commandRevision || preview.error)) { setError('Wait for the command and timing preview, then review the resolved command before saving.'); return }
    if (replacement) { setError('Replace the advanced timing or keep it before saving.'); return }
    pendingRef.current = true; setPending(true); setError(null)
    const template = SCHEDULE_TEMPLATES.find((entry) => entry.id === choice)
    const editorMetadata: ScheduleEditorMetadata = choice === 'advanced' ? { mode: 'advanced' } : {
      mode: template ? 'template' : 'custom', ...(template ? { templateId: template.id, templateVersion: template.version } : {}),
      weekdays: rule.weekdays, hours: rule.hours
    }
    try {
      if (props.target === 'job') {
        await window.api.jobSchedules.save({ profileUserId, jobId: props.snapshot.jobId, jobRevision: props.snapshot.jobRevision,
          id: item?.binding?.id, revision: item?.revision, name: name.trim(), cron, timezone, enabled, editorMetadata })
        onSaved()
      } else {
        const result = await window.api.localSchedules.save({
          profileUserId, agentId, expectedStamp: props.stamp, originalName: item?.name, revision: item?.revision ?? undefined,
          name: name.trim(), executionType, prompt, command, cron, timezone, enabled, editorMetadata,
          ...(executionType === 'script_trigger' ? { commandRevision: preview?.commandRevision } : {})
        })
        onSaved(result.warning)
      }
      onClose()
    } catch (cause) { setError(unwrapIpcError(cause, 'This schedule could not be saved. Your edits are still here.')) }
    finally { pendingRef.current = false; setPending(false) }
  }
  const summary = choice === 'advanced' ? `Advanced rule: ${cron || 'Enter a five-field cron rule'}` : selectionError ?? scheduleRuleSummary(rule)
  return createPortal(<dialog ref={dialog} aria-label={item ? 'Edit schedule' : 'New schedule'} className={scheduleDialogClass}
    onCancel={(event) => { event.preventDefault(); if (!pendingRef.current) onClose() }}>
    <form className="min-w-0 space-y-4" onSubmit={(event) => { event.preventDefault(); void submit() }}>
      <h2 className="text-[16px] font-semibold">{item ? 'Edit schedule' : 'New schedule'}</h2>
      <fieldset disabled={pending} className="min-w-0 space-y-4">
        <label className="block space-y-1.5 text-[13px] font-medium">Name<input className={scheduleInputClass} value={name} onChange={(event) => setName(event.target.value)} autoFocus required /></label>
        {!job && <><label className="block space-y-1.5 text-[13px] font-medium">Execution type
          <select className={scheduleInputClass} value={executionType} disabled={!!item} onChange={(event) => setExecutionType(event.target.value as typeof executionType)}>
            <option value="static_prompt">Prompt scheduler</option><option value="script_trigger">Script scheduler</option>
          </select>
        </label>
        {executionType === 'static_prompt' ? <label className="block space-y-1.5 text-[13px] font-medium">Prompt
          <textarea className={scheduleInputClass} rows={4} value={prompt} onChange={(event) => setPrompt(event.target.value)} required />
        </label> : <label className="block space-y-1.5 text-[13px] font-medium">Command
          <textarea className={`${scheduleInputClass} font-mono`} rows={4} value={command} onChange={(event) => setCommand(event.target.value)} placeholder="Shell command or /run:name" required />
        </label>}</>}
        <label className="block space-y-1.5 text-[13px] font-medium">Schedule
          <select className={scheduleInputClass} value={choice} onChange={(event) => changeChoice(event.target.value)}>
            {SCHEDULE_TEMPLATES.map((entry) => <option key={entry.id} value={entry.id}>{entry.label}</option>)}
            <option value="custom">Custom</option><option value="advanced">CRON advanced</option>
          </select>
        </label>
        {choice === 'custom' && <ScheduleDaysHours rule={rule} onChange={setRule} />}
        {choice === 'advanced' && <label className="block space-y-1.5 text-[13px] font-medium">Cron expression
          <input className={`${scheduleInputClass} font-mono`} value={advanced} onChange={(event) => setAdvanced(event.target.value)} placeholder="minute hour day month weekday" required />
        </label>}
        {replacement && <div className="rounded-md border border-[var(--color-border)] p-3 text-[13px]">
          <p>Replace this advanced rule with {replacement === 'custom' ? 'the selected days and hours' : SCHEDULE_TEMPLATES.find((entry) => entry.id === replacement)?.label}? Your advanced text stays available until you close this form.</p>
          <div className="mt-2 flex gap-2"><button type="button" className={scheduleButtonClass} onClick={() => selectChoice(replacement)}>Replace timing</button><button type="button" className={scheduleButtonClass} onClick={() => setReplacement(null)}>Keep advanced</button></div>
        </div>}
        <label className="block space-y-1.5 text-[13px] font-medium">Timezone
          <input className={scheduleInputClass} value={timezone} onChange={(event) => setTimezone(event.target.value)} placeholder="Europe/Berlin" required />
        </label>
        <div className="space-y-1 text-[12px] text-[var(--color-text-secondary)]" aria-live="polite">
          <p className="overflow-x-auto whitespace-nowrap" title={`${summary} · ${timezone}`}>{summary} · {timezone || 'Choose a timezone'}</p>
          <p className="overflow-x-auto whitespace-nowrap">{preview?.key === previewKey ? preview.text : 'Checking the next scheduled time…'}</p>
        </div>
        <label className="flex items-center gap-2 text-[13px] font-medium"><input type="checkbox" checked={enabled} onChange={(event) => setEnabled(event.target.checked)} />Enable on this device</label>
      </fieldset>
      <div className="space-y-2 text-[12px] text-[var(--color-text-secondary)]">
        {job && <div className="space-y-2 rounded-md border border-[var(--color-border)] p-3">
          <p className="text-[13px] font-medium text-[var(--color-text)]">Runs Job: {job.jobTitle}</p>
          <p>{job.jobSummary}</p>
          <label className="block space-y-1.5">Job prompt<textarea aria-label="Job prompt" readOnly value={job.jobPrompt} rows={4} className={scheduleInputClass} /></label>
          <JobScheduleScriptReview script={job.jobScript} />
        </div>}
        {executionType === 'script_trigger' && <div><p className="mb-1 font-medium">Resolved command to review</p><pre className="h-24 overflow-auto whitespace-pre-wrap break-words rounded border border-[var(--color-border)] bg-[var(--color-bg)] p-2">{preview?.key === previewKey && preview.resolvedCommand ? preview.resolvedCommand : 'Checking command…'}</pre></div>}
        <p>{catchUpExplanation} The first run after saving or enabling is in the future. Unfinished work prevents another run.</p>
        <p>{job ? 'Each run starts a new task using this Job’s instructions, runtime, and limits. Changes to the Job require review again. Questions appear in the Inbox.' : executionType === 'script_trigger' ? 'Runs the command in this agent’s folder. Exit 0 with trimmed stdout exactly OK is recorded without starting an agent task; other completed results start a task. Commands have a five-minute limit.' : 'Each run starts a task with a 20-turn and 60-minute limit. Questions appear in the Inbox.'}</p>
        <p>{enabled ? 'Save and enable confirms your review of the exact instructions, timing, timezone, and catch-up behavior above.' : 'Saving keeps this schedule disabled on this device.'}</p>
      </div>
      <div className="flex justify-end gap-2"><button type="button" className={scheduleButtonClass} disabled={pending} onClick={onClose}>Cancel</button>
        <button type="submit" disabled={pending} className={`${scheduleButtonClass} bg-[var(--color-accent)] text-white`}>{pending ? 'Saving…' : enabled ? 'Save and enable' : 'Save schedule'}</button>
      </div>
      {error && <p role="alert" className="text-[13px] text-[var(--color-danger)]">{error}</p>}
    </form>
  </dialog>, document.body)
}
