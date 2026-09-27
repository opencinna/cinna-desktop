/// <reference types="vite/client" />
import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import Markdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { HelpCircle, X } from 'lucide-react'
import type { FileStamp } from '../../../../../shared/localAgents'
import type { LocalScheduleItem } from '../../../../../shared/localSchedules'
import type { LocalJobScheduleSnapshot } from '../../../../../shared/localJobSchedules'
import {
  SCHEDULE_TEMPLATES, compileScheduleRule, normalizeScheduleEditorMetadata, scheduleRuleSummary,
  type ScheduleEditorMetadata, type ScheduleRule
} from '../../../../../shared/scheduleTemplates'
import { unwrapIpcError } from '../../../utils/ipcError'
import { documentMarkdownComponents } from '../../../utils/markdownComponents'
import { SettingsInfoTip } from '../../settings/SettingsLayout'
import { relativeTimeUntil, scheduleTime, useNow } from './scheduleClock'
import cronCheatsheet from './cronCheatsheet.md?raw'

export const scheduleButtonClass = 'shrink-0 rounded-md border border-[var(--color-border)] px-3 py-1.5 text-[13px] font-medium text-[var(--color-text)] hover:bg-[var(--color-bg-hover)] disabled:opacity-50'
export const scheduleInputClass = 'block w-full rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] p-2 text-[13px] text-[var(--color-text)] disabled:opacity-60'
export const scheduleDialogClass = 'm-auto w-[54rem] max-w-[calc(100vw-2rem)] max-h-[calc(100vh-2rem)] overflow-y-auto rounded-xl border border-[var(--color-border)] bg-[var(--color-bg-secondary)] p-5 text-[var(--color-text)] shadow-lg backdrop:bg-black/25'
/**
 * The editor grows while the user works in it (badges wrap onto a new line),
 * so its top edge is pinned rather than centred: a centred dialog would move
 * its title and every field above the one being edited (ux_rules rule 1).
 */
const scheduleEditorDialogClass = 'mx-auto mt-[10vh] mb-auto w-[54rem] max-w-[calc(100vw-2rem)] max-h-[calc(90vh-1rem)] overflow-y-auto rounded-xl border border-[var(--color-border)] bg-[var(--color-bg-secondary)] p-5 text-[var(--color-text)] shadow-lg backdrop:bg-black/25'
export const catchUpExplanation = 'Runs while Cinna is open and this profile is active. If scheduled times pass while Cinna is closed or asleep, it runs once when Cinna is available again.'
const days = [{ value: 1, label: 'Mon' }, { value: 2, label: 'Tue' }, { value: 3, label: 'Wed' }, { value: 4, label: 'Thu' }, { value: 5, label: 'Fri' }, { value: 6, label: 'Sat' }, { value: 0, label: 'Sun' }]
const hourLabel = (hour: number) => `${String(hour).padStart(2, '0')}:00`

type BadgeOption = { value: number; label: string }

/**
 * A multiselect shown as an input: each chosen value is a badge with its own
 * remove button, and a compact select at the end adds one of the rest. Values
 * stay in the order of `options`, whatever order they were picked in.
 */
export function BadgeMultiSelect({ legend, options, selected, onChange, addLabel, disabled = false }: {
  legend: string; options: BadgeOption[]; selected: number[]; onChange(values: number[]): void; addLabel: string; disabled?: boolean
}) {
  const ordered = options.filter((option) => selected.includes(option.value))
  const remaining = options.filter((option) => !selected.includes(option.value))
  const set = (values: number[]) => onChange(options.map((option) => option.value).filter((value) => values.includes(value)))
  const box = useRef<HTMLDivElement>(null)
  // After a removal, focus the × that slid into the removed one's place (or
  // the one before it, or the add picker), never <body>.
  const focusAt = useRef<number | null>(null)
  useLayoutEffect(() => {
    if (focusAt.current === null || !box.current) return
    const index = focusAt.current
    focusAt.current = null
    const removes = box.current.querySelectorAll<HTMLElement>('button[data-remove]')
    ;(removes[index] ?? removes[index - 1] ?? box.current.querySelector<HTMLElement>('select'))?.focus()
  })
  const remove = (event: React.MouseEvent, value: number, index: number) => {
    // The next badge's × slides under the pointer, so the second click of a
    // double click would remove a value nobody aimed at.
    if (event.detail > 1) return
    focusAt.current = index
    set(selected.filter((entry) => entry !== value))
  }
  return <fieldset className="min-w-0" disabled={disabled} aria-invalid={selected.length === 0}>
    <legend className="mb-1.5 text-[13px] font-medium">{legend}</legend>
    <div ref={box} className="flex min-h-[2.375rem] flex-wrap items-center gap-1.5 rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] p-1.5">
      {ordered.map((option, index) => <span key={option.value} className="inline-flex items-center gap-0.5 rounded bg-[var(--color-bg-tertiary)] py-0.5 pl-1.5 pr-0.5 text-[12px] tabular-nums text-[var(--color-text)]">
        {option.label}
        <button type="button" data-remove aria-label={`Remove ${option.label}`} title={`Remove ${option.label}`} onClick={(event) => remove(event, option.value, index)}
          className="rounded p-0.5 text-[var(--color-text-muted)] hover:bg-[var(--color-bg-hover)] hover:text-[var(--color-text)]"><X size={12} /></button>
      </span>)}
      {remaining.length > 0 && <select aria-label={addLabel} value="" onChange={(event) => { if (event.target.value !== '') set([...selected, Number(event.target.value)]) }}
        className="min-w-0 rounded border-0 bg-transparent py-0.5 text-[12px] text-[var(--color-accent)] focus:outline-none">
        <option value="" disabled>{addLabel}…</option>
        {remaining.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
      </select>}
    </div>
  </fieldset>
}

const hourOptions: BadgeOption[] = Array.from({ length: 24 }, (_, hour) => ({ value: hour, label: hourLabel(hour) }))

export function ScheduleDaysHours({ rule, onChange, disabled = false }: { rule: ScheduleRule; onChange(rule: ScheduleRule): void; disabled?: boolean }) {
  return <div className="grid min-w-0 items-start gap-3 sm:grid-cols-2">
    <BadgeMultiSelect legend="Days" options={days} selected={rule.weekdays} addLabel="Add day" disabled={disabled} onChange={(weekdays) => onChange({ ...rule, weekdays })} />
    <BadgeMultiSelect legend="Hours" options={hourOptions} selected={rule.hours} addLabel="Add hour" disabled={disabled} onChange={(hours) => onChange({ ...rule, hours })} />
  </div>
}

/**
 * The cron reference, as a second modal over the editor. Escape closes this
 * one only: the cancel is stopped here, so it never reaches the editor's own
 * onCancel through the React tree.
 */
function CronCheatsheet({ onClose }: { onClose(): void }) {
  const dialog = useRef<HTMLDialogElement>(null)
  useEffect(() => { dialog.current?.showModal() }, [])
  return createPortal(<dialog ref={dialog} aria-label="Cron expression help"
    className="m-auto w-[40rem] max-w-[calc(100vw-2rem)] max-h-[calc(100vh-2rem)] overflow-y-auto rounded-xl border border-[var(--color-border)] bg-[var(--color-bg-secondary)] p-5 text-[var(--color-text)] shadow-lg backdrop:bg-black/25"
    onCancel={(event) => { event.preventDefault(); event.stopPropagation(); onClose() }}>
    <h2 className="mb-3 text-[16px] font-semibold">Cron expressions</h2>
    <div className="markdown-body text-[13px] leading-relaxed">
      <Markdown remarkPlugins={[remarkGfm]} components={documentMarkdownComponents}>{cronCheatsheet}</Markdown>
    </div>
    <div className="mt-4 flex justify-end"><button type="button" autoFocus className={scheduleButtonClass} onClick={onClose}>Close</button></div>
  </dialog>, document.body)
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
  const isJob = props.target === 'job'
  const agentId = props.target === 'job' ? '' : props.agentId
  const profileUserId = props.target === 'job' ? props.snapshot.profileUserId : props.profileUserId
  const dialog = useRef<HTMLDialogElement>(null)
  const cronHelp = useRef<HTMLButtonElement>(null)
  const cronId = useId()
  const pendingRef = useRef(false)
  const [pending, setPending] = useState(false)
  const [name, setName] = useState(item?.name ?? '')
  const [executionType, setExecutionType] = useState(item?.executionType ?? 'static_prompt')
  const [prompt, setPrompt] = useState(item?.prompt ?? '')
  const [command, setCommand] = useState(item?.command ?? '')
  const [timezone, setTimezone] = useState(item?.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone)
  // A new schedule starts enabled; an edit keeps the state the list's switch
  // shows, which is off for a binding held back by a reason (its Job changed),
  // so the save clears that reason. The switch is where it is turned back on.
  const enabled = item ? (item.binding?.enabled ?? false) : true
  const initial = useMemo(() => initialTiming(item), [item])
  const [choice, setChoice] = useState(initial.choice)
  const [rule, setRule] = useState(initial.rule)
  const [advanced, setAdvanced] = useState(initial.advanced)
  const [replacement, setReplacement] = useState<string | null>(null)
  const [cheatsheet, setCheatsheet] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [preview, setPreview] = useState<{ key: string; nextDueAt?: number; errorText?: string; resolvedCommand?: string; commandRevision?: string } | null>(null)
  const now = useNow()
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
        if (current) setPreview({ key: previewKey, nextDueAt: result.nextDueAt, resolvedCommand: result.resolvedCommand, commandRevision: result.commandRevision })
      }).catch((cause) => {
        if (current) setPreview({ key: previewKey, errorText: unwrapIpcError(cause, 'This timing rule is not valid.') })
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
    if (!isJob && (executionType === 'static_prompt' ? !prompt.trim() : !command.trim())) { setError(executionType === 'static_prompt' ? 'Enter a prompt.' : 'Enter a command.'); return }
    if (selectionError) { setError(selectionError); return }
    if (executionType === 'script_trigger' && (preview?.key !== previewKey || !preview.commandRevision || preview.errorText)) { setError('Wait for the command and timing preview, then review the resolved command before saving.'); return }
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
  const current = preview?.key === previewKey ? preview : null
  // Worded as on the schedule lists; the summary line above names the zone.
  const incomplete = !cron.trim() || !timezone.trim()
  const nextText = incomplete ? 'Next scheduled time: —' : !current ? 'Checking the next scheduled time…'
    : current.errorText ?? `Next scheduled time: ${scheduleTime(current.nextDueAt, timezone)} · ${relativeTimeUntil(current.nextDueAt!, now)}`
  const title = item ? 'Edit schedule' : 'New schedule'
  return <>{createPortal(<dialog ref={dialog} aria-label={title} className={scheduleEditorDialogClass}
    onCancel={(event) => { event.preventDefault(); if (!pendingRef.current) onClose() }}>
    <form className="min-w-0 space-y-4" onSubmit={(event) => { event.preventDefault(); void submit() }}>
      <div className="flex items-center gap-1.5">
        <h2 className="text-[16px] font-semibold">{title}</h2>
        <SettingsInfoTip label="How schedules run">
          <p>{catchUpExplanation} The first run after saving or enabling is in the future. Unfinished work prevents another run.</p>
          <p>{isJob ? 'Each run starts a new task using this Job’s instructions, runtime, and limits. Questions appear in the Inbox.' : executionType === 'script_trigger' ? 'Runs the command in this agent’s folder. Exit 0 with trimmed stdout exactly OK is recorded without starting an agent task; other completed results start a task. Commands have a five-minute limit.' : 'Each run starts a task with a 20-turn and 60-minute limit. Questions appear in the Inbox.'}</p>
        </SettingsInfoTip>
      </div>
      <fieldset disabled={pending} className="min-w-0 space-y-4">
        <div className={isJob ? 'min-w-0' : 'grid min-w-0 gap-3 sm:grid-cols-[minmax(0,1fr)_12rem]'}>
          <label className="block min-w-0 space-y-1.5 text-[13px] font-medium">Name<input className={scheduleInputClass} value={name} onChange={(event) => setName(event.target.value)} autoFocus required /></label>
          {!isJob && <label className="block min-w-0 space-y-1.5 text-[13px] font-medium">Execution type
            <select className={scheduleInputClass} value={executionType} disabled={!!item} onChange={(event) => setExecutionType(event.target.value as typeof executionType)}>
              <option value="static_prompt">Prompt scheduler</option><option value="script_trigger">Script scheduler</option>
            </select>
          </label>}
        </div>
        {!isJob && (executionType === 'static_prompt' ? <label className="block space-y-1.5 text-[13px] font-medium">Prompt
          <textarea className={scheduleInputClass} rows={3} value={prompt} onChange={(event) => setPrompt(event.target.value)} required />
        </label> : <label className="block space-y-1.5 text-[13px] font-medium">Command
          <textarea className={`${scheduleInputClass} font-mono`} rows={3} value={command} onChange={(event) => setCommand(event.target.value)} placeholder="Shell command or /run:name" required />
        </label>)}
        <div className="grid min-w-0 gap-3 sm:grid-cols-[minmax(0,1fr)_14rem]">
          <label className="block min-w-0 space-y-1.5 text-[13px] font-medium">Schedule
            <select className={scheduleInputClass} value={choice} onChange={(event) => changeChoice(event.target.value)}>
              {SCHEDULE_TEMPLATES.map((entry) => <option key={entry.id} value={entry.id}>{entry.label}</option>)}
              <option value="custom">Custom</option><option value="advanced">CRON advanced</option>
            </select>
          </label>
          <label className="block min-w-0 space-y-1.5 text-[13px] font-medium">Timezone
            <input className={scheduleInputClass} value={timezone} onChange={(event) => setTimezone(event.target.value)} placeholder="Europe/Berlin" required />
          </label>
        </div>
        {choice === 'custom' && <ScheduleDaysHours rule={rule} onChange={setRule} />}
        {choice === 'advanced' && <div className="space-y-1.5">
          <div className="flex items-center gap-1.5">
            <label htmlFor={cronId} className="text-[13px] font-medium">Cron expression</label>
            <button ref={cronHelp} type="button" aria-label="Cron expression help" title="Cron expression help" onClick={() => setCheatsheet(true)}
              className="inline-flex shrink-0 items-center justify-center rounded-full p-0.5 text-[var(--color-accent)] hover:text-[var(--color-accent-hover)]"><HelpCircle size={14} /></button>
          </div>
          <input id={cronId} className={`${scheduleInputClass} font-mono`} value={advanced} onChange={(event) => setAdvanced(event.target.value)} placeholder="minute hour day month weekday" required />
        </div>}
        {replacement && <div className="rounded-md border border-[var(--color-border)] p-3 text-[13px]">
          <p>Replace this advanced rule with {replacement === 'custom' ? 'the selected days and hours' : SCHEDULE_TEMPLATES.find((entry) => entry.id === replacement)?.label}? Your advanced text stays available until you close this form.</p>
          <div className="mt-2 flex gap-2"><button type="button" className={scheduleButtonClass} onClick={() => selectChoice(replacement)}>Replace timing</button><button type="button" className={scheduleButtonClass} onClick={() => setReplacement(null)}>Keep advanced</button></div>
        </div>}
        <div className="space-y-1 text-[12px] text-[var(--color-text-secondary)]" aria-live="polite">
          <p className="overflow-x-auto whitespace-nowrap" title={`${summary} · ${timezone}`}>{summary} · {timezone || 'Choose a timezone'}</p>
          <p className="overflow-x-auto whitespace-nowrap">{nextText}</p>
        </div>
        {executionType === 'script_trigger' && <div className="text-[12px] text-[var(--color-text-secondary)]"><p className="mb-1 font-medium">Resolved command to review</p><pre className="h-24 overflow-auto whitespace-pre-wrap break-words rounded border border-[var(--color-border)] bg-[var(--color-bg)] p-2">{current?.resolvedCommand ?? 'Checking command…'}</pre></div>}
      </fieldset>
      <div className="flex justify-end gap-2"><button type="button" className={scheduleButtonClass} disabled={pending} onClick={onClose}>Cancel</button>
        <button type="submit" disabled={pending} className={`${scheduleButtonClass} bg-[var(--color-accent)] text-white`}>{pending ? 'Saving…' : item ? 'Save schedule' : 'Create schedule'}</button>
      </div>
      {error && <p role="alert" className="text-[13px] text-[var(--color-danger)]">{error}</p>}
    </form>
  </dialog>, document.body)}
  {cheatsheet && <CronCheatsheet onClose={() => { setCheatsheet(false); cronHelp.current?.focus() }} />}
  </>
}
