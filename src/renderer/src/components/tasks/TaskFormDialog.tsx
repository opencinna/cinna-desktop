import { useCallback, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { ChevronDown, ChevronRight, Plus, X } from 'lucide-react'
import {
  TASK_PRIORITIES,
  validateTaskCustomFields,
  type TaskAssigneeInput,
  type TaskCustomFieldValue,
  type TaskCustomFields,
  type TaskDto,
  type TaskPriority,
  type TaskUpdateInput
} from '../../../../shared/tasks'
import { manualTargets, taskStatusCategory, type TaskStatus } from '../../../../shared/taskStatus'
import { useAgents } from '../../hooks/useAgents'
import type { useCreateTask, useSetTaskStatus, useUpdateTask } from '../../hooks/useTasks'
import { unwrapIpcError } from '../../utils/ipcError'
import { customFieldText, taskStatusLabel } from './tasksViewModel'

/**
 * The New task and Edit task dialogs, sharing their form parts.
 *
 * New task asks for the title and nothing else (`ux_rules.md` §3): Enter
 * creates, and everything main can default sits under a collapsed More
 * options. Edit task opens with every field, since the user came to change
 * one. Both close on success only, with main's refusal last in the dialog
 * (§1, §6), and neither owns its mutation — the component that opened it
 * does, so a success handler cannot be dropped with the dialog (§5). Escape
 * and an outside click close an untouched form only; once the user has typed,
 * Cancel is the one way to throw it away.
 */

/** No width: the custom field rows size their two inputs themselves. */
const FIELD =
  'bg-[var(--color-bg)] text-[var(--color-text)] px-2.5 py-1.5 rounded-md text-xs ' +
  'border border-[var(--color-border)] focus:border-[var(--color-accent)] focus:outline-none ' +
  'placeholder:text-[var(--color-text-muted)] disabled:opacity-50'
const INPUT = `w-full ${FIELD}`
const LABEL = 'block text-xs font-medium text-[var(--color-text)]'
const CANCEL =
  'px-3 py-1.5 rounded-md text-xs font-medium text-[var(--color-text-muted)] hover:bg-[var(--color-bg-hover)] ' +
  'hover:text-[var(--color-text)] transition-colors disabled:opacity-50 disabled:cursor-not-allowed'
const PRIMARY =
  'min-w-[5.5rem] px-3 py-1.5 rounded-md text-xs font-medium bg-[var(--color-accent)] text-white ' +
  'hover:bg-[var(--color-accent-hover)] transition-colors disabled:opacity-30 disabled:cursor-not-allowed'

const PRIORITY_LABEL: Record<TaskPriority, string> = { low: 'Low', normal: 'Normal', high: 'High', urgent: 'Urgent' }
/** The select's value for "no agent"; an agent's value is its id. */
const NO_AGENT = ''

/** One editable custom field. `original` keeps a number or a list intact when its text is untouched. */
interface FieldRow {
  id: number
  key: string
  text: string
  original?: { text: string; value: TaskCustomFieldValue }
}

let nextRowId = 1
function rowsFrom(fields: TaskCustomFields | null): FieldRow[] {
  return Object.entries(fields ?? {}).map(([key, value]) => {
    const text = customFieldText(value)
    return { id: nextRowId++, key, text, original: { text, value } }
  })
}

/** The rows as custom fields, or the first refusal (main checks again). */
function fieldsFrom(rows: FieldRow[]): { fields: TaskCustomFields } | { error: string } {
  const out: Record<string, TaskCustomFieldValue> = {}
  for (const row of rows) {
    const key = row.key.trim()
    if (!key && !row.text.trim()) continue
    if (!key) return { error: 'Give each custom field a name.' }
    if (Object.prototype.hasOwnProperty.call(out, key)) return { error: `“${key}” is used twice.` }
    out[key] = row.original && row.original.text === row.text ? row.original.value : row.text
  }
  return validateTaskCustomFields(out)
}

function sameFields(a: TaskCustomFields | null, b: TaskCustomFields): boolean {
  return JSON.stringify(a ?? {}) === JSON.stringify(b)
}

/**
 * Escape and an outside click dismiss an **unchanged** form, never one being
 * saved. With edits they do nothing: a stray click beside the card must not
 * throw away what the user typed. Returns Cancel's handler, which discards
 * edits on purpose and is held back only while saving.
 */
function useDismiss(
  cardRef: React.RefObject<HTMLElement | null>,
  { busy, dirty }: { busy: boolean; dirty: boolean },
  onClose: () => void
): () => void {
  const busyRef = useRef(busy)
  busyRef.current = busy
  const dirtyRef = useRef(dirty)
  dirtyRef.current = dirty
  const cancel = useCallback((): void => {
    if (!busyRef.current) onClose()
  }, [onClose])
  useEffect(() => {
    const dismiss = (): void => {
      if (!dirtyRef.current) cancel()
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') dismiss()
    }
    const onClick = (e: MouseEvent): void => {
      if (cardRef.current && !cardRef.current.contains(e.target as Node)) dismiss()
    }
    window.addEventListener('keydown', onKey)
    window.addEventListener('mousedown', onClick)
    return () => {
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('mousedown', onClick)
    }
  }, [cardRef, cancel])
  return cancel
}

/** The rows as they read, for "has the user changed anything". */
function rowsText(rows: FieldRow[]): string {
  return JSON.stringify(rows.map((row) => [row.key, row.text]))
}

function DialogFrame({ label, cardRef, children }: {
  label: string
  cardRef: React.RefObject<HTMLDivElement | null>
  children: React.ReactNode
}): React.JSX.Element {
  return createPortal(
    // Anchored to the top: More options and an error grow it downwards only (§1).
    <div className="fixed inset-0 z-50 flex items-start justify-center bg-black/25 px-4 pt-[8vh]">
      <div
        ref={cardRef}
        role="dialog"
        aria-label={label}
        className="w-full max-w-[30rem] max-h-[84vh] overflow-y-auto rounded-xl border border-[var(--color-border)] bg-[var(--color-bg-secondary)] shadow-lg p-6"
      >
        <h2 className="text-sm font-semibold text-[var(--color-text)]">{label}</h2>
        {children}
      </div>
    </div>,
    document.body
  )
}

function PriorityField({ id, value, onChange, disabled }: {
  id: string; value: TaskPriority; onChange: (value: TaskPriority) => void; disabled?: boolean
}): React.JSX.Element {
  return (
    <div className="space-y-1.5">
      <label htmlFor={id} className={LABEL}>Priority</label>
      <select id={id} value={value} disabled={disabled} className={INPUT}
        onChange={(event) => onChange(event.target.value as TaskPriority)}>
        {TASK_PRIORITIES.map((priority) => <option key={priority} value={priority}>{PRIORITY_LABEL[priority]}</option>)}
      </select>
    </div>
  )
}

/**
 * Who the task is for: nobody yet, or an enabled agent. There is no separate
 * "Default chat model": main stores both as `kind: 'model'`, so the two
 * choices could not be told apart afterwards.
 */
function AssigneeField({ id, value, onChange, disabled, reason, current }: {
  id: string
  value: string
  onChange: (value: string) => void
  disabled?: boolean
  /** Why it cannot change now — one line under it, only while that is so. */
  reason?: string | null
  /** The task's own agent when it is not among the enabled ones, so the select can still show it. */
  current?: { id: string; name: string } | null
}): React.JSX.Element {
  const { data: agents } = useAgents()
  const enabled = (agents ?? []).filter((agent) => agent.enabled)
  const showCurrent = current && !enabled.some((agent) => agent.id === current.id)
  return (
    <div className="space-y-1.5">
      <label htmlFor={id} className={LABEL}>Assignee</label>
      <select id={id} value={value} disabled={disabled} className={INPUT}
        onChange={(event) => onChange(event.target.value)}>
        <option value={NO_AGENT}>Unassigned</option>
        {showCurrent && <option value={current.id}>{current.name}</option>}
        {enabled.map((agent) => <option key={agent.id} value={agent.id}>{agent.name}</option>)}
      </select>
      {reason && <p className="text-[10px] text-[var(--color-text-muted)]">{reason}</p>}
    </div>
  )
}

function CustomFieldsEditor({ rows, onChange, disabled }: {
  rows: FieldRow[]; onChange: (rows: FieldRow[]) => void; disabled?: boolean
}): React.JSX.Element {
  const update = (id: number, patch: Partial<FieldRow>): void =>
    onChange(rows.map((row) => (row.id === id ? { ...row, ...patch } : row)))
  return (
    <fieldset className="space-y-1.5" disabled={disabled}>
      <legend className={LABEL}>Custom fields</legend>
      {rows.map((row, index) => (
        <div key={row.id} className="flex items-center gap-1.5">
          <input aria-label={`Field ${index + 1} name`} value={row.key} placeholder="name" spellCheck={false}
            onChange={(event) => update(row.id, { key: event.target.value })}
            className={`${FIELD} w-36 shrink-0 font-mono`} />
          <input aria-label={`Field ${index + 1} value`} value={row.text} placeholder="value"
            onChange={(event) => update(row.id, { text: event.target.value })}
            className={`${FIELD} min-w-0 flex-1`} />
          <button type="button" aria-label={`Remove field ${row.key || index + 1}`} title="Remove field"
            onClick={() => onChange(rows.filter((entry) => entry.id !== row.id))}
            className="shrink-0 rounded p-1 text-[var(--color-text-muted)] hover:bg-[var(--color-bg-hover)] hover:text-[var(--color-text)]">
            <X size={12} />
          </button>
        </div>
      ))}
      <button type="button" onClick={() => onChange([...rows, { id: nextRowId++, key: '', text: '' }])}
        className="flex items-center gap-1 text-[11px] font-medium text-[var(--color-accent)] hover:text-[var(--color-accent-hover)] transition-colors">
        <Plus size={12} /> Add field
      </button>
    </fieldset>
  )
}

function ErrorLine({ message }: { message: string | null }): React.JSX.Element | null {
  // Last in the dialog and only while there is one: it moves nothing above it (§1).
  if (!message) return null
  return <p role="alert" className="mt-3 text-[11px] leading-relaxed text-[var(--color-danger)]">{message}</p>
}

function assigneeInput(value: string): TaskAssigneeInput {
  return value === NO_AGENT ? null : { kind: 'agent', agentId: value }
}

/** New task: a title, Enter, and the user lands on the task. */
export function NewTaskDialog({ create, onClose }: {
  /** Owned by the Tasks view, whose hook-level `onCreated` closes this and opens the task. */
  create: ReturnType<typeof useCreateTask>
  onClose: () => void
}): React.JSX.Element {
  const cardRef = useRef<HTMLDivElement>(null)
  const titleRef = useRef<HTMLInputElement>(null)
  const [title, setTitle] = useState('')
  const [more, setMore] = useState(false)
  const [goal, setGoal] = useState('')
  const [priority, setPriority] = useState<TaskPriority>('normal')
  const [assignee, setAssignee] = useState(NO_AGENT)
  const [status, setStatus] = useState<'new' | 'open'>('new')
  const [rows, setRows] = useState<FieldRow[]>([])
  const [localError, setLocalError] = useState<string | null>(null)
  const pending = create.isPending
  const dirty = title !== '' || goal !== '' || priority !== 'normal' || assignee !== NO_AGENT || status !== 'new' ||
    rows.some((row) => row.key !== '' || row.text !== '')
  const dismiss = useDismiss(cardRef, { busy: pending, dirty }, onClose)

  useEffect(() => {
    titleRef.current?.focus()
  }, [])

  const submit = (): void => {
    if (!title.trim() || pending) return
    const fields = fieldsFrom(rows)
    if ('error' in fields) { setLocalError(fields.error); return }
    setLocalError(null)
    create.mutate({
      title: title.trim(),
      ...(goal.trim() ? { goal: goal.trim() } : {}),
      ...(priority !== 'normal' ? { priority } : {}),
      ...(status !== 'new' ? { status } : {}),
      ...(assignee !== NO_AGENT ? { assignee: assigneeInput(assignee) } : {}),
      ...(Object.keys(fields.fields).length > 0 ? { customFields: fields.fields } : {})
    })
  }

  const error = localError ?? (create.error ? unwrapIpcError(create.error, 'The task could not be created.') : null)

  return (
    <DialogFrame label="New task" cardRef={cardRef}>
      <form className="mt-4 space-y-4" onSubmit={(event) => { event.preventDefault(); submit() }}>
        <div className="space-y-1.5">
          <label htmlFor="new-task-title" className={LABEL}>Title</label>
          <input id="new-task-title" ref={titleRef} type="text" value={title} disabled={pending}
            onChange={(event) => setTitle(event.target.value)} placeholder="Draft the release notes" className={INPUT} />
        </div>
        <div>
          <button type="button" onClick={() => setMore((open) => !open)} aria-expanded={more}
            className="flex items-center gap-1 text-[11px] font-medium text-[var(--color-text-secondary)] transition-colors hover:text-[var(--color-text)]">
            {more ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
            More options
          </button>
          {more && (
            <div className="mt-3 space-y-3 border-l-2 border-[var(--color-border)] pl-3">
              <div className="space-y-1.5">
                <label htmlFor="new-task-goal" className={LABEL}>Goal</label>
                <textarea id="new-task-goal" rows={3} value={goal} disabled={pending} placeholder="Defaults to the title"
                  onChange={(event) => setGoal(event.target.value)} className={`${INPUT} resize-none`} />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <PriorityField id="new-task-priority" value={priority} onChange={setPriority} disabled={pending} />
                <div className="space-y-1.5">
                  <label htmlFor="new-task-status" className={LABEL}>Status</label>
                  <select id="new-task-status" value={status} disabled={pending} className={INPUT}
                    onChange={(event) => setStatus(event.target.value as 'new' | 'open')}>
                    <option value="new">Backlog</option>
                    <option value="open">Ready</option>
                  </select>
                </div>
              </div>
              <AssigneeField id="new-task-assignee" value={assignee} onChange={setAssignee} disabled={pending} />
              <CustomFieldsEditor rows={rows} onChange={setRows} disabled={pending} />
            </div>
          )}
        </div>
        <div className="flex justify-end gap-2">
          <button type="button" onClick={dismiss} disabled={pending} className={CANCEL}>Cancel</button>
          <button type="submit" disabled={!title.trim() || pending} className={PRIMARY}>
            {pending ? 'Creating…' : 'Create'}
          </button>
        </div>
      </form>
      <ErrorLine message={error} />
    </DialogFrame>
  )
}

/**
 * Why main would refuse a new assignee for this task — the same conditions as
 * `taskService`'s `assigneeEditRefusal`, read from the DTO so the control is
 * disabled before the user tries. Main remains the authority.
 */
export function assigneeLockReason(task: TaskDto): string | null {
  if (task.chatId) return 'Fixed once the task has a conversation.'
  if (task.executor !== 'desktop') return 'Set by the service running this task.'
  if (!task.runsHere) return 'Another device holds this task. Take it over to change it.'
  if (task.remote) return 'Set by the service this task is connected to.'
  if (task.router === 'script') return 'A script’s steps name their own agents.'
  if (task.runtime) return 'Fixed while a runtime owns this task.'
  return null
}

/**
 * Why Edit task cannot change the status now — a run or a question holds the
 * task, or nothing is reachable from where it is. Read from the DTO, as
 * {@link assigneeLockReason}; `task:set-status` remains the authority.
 */
export function statusLockReason(task: TaskDto, targets: readonly TaskStatus[]): string | null {
  if (task.runtime) return 'Moved by the runtime that owns this task.'
  if (task.status === 'in_progress') return 'Set by the run working on it.'
  if (task.status === 'blocked') return 'Set by the question waiting on you.'
  if (targets.length > 0) return null
  if (taskStatusCategory(task.status) === 'closed') return 'A finished task stays where it is.'
  if (task.remote) return 'Moved by the service this task is connected to.'
  return 'Nothing to move it to from here.'
}

/**
 * Where Edit task may move this task: the user-column statuses
 * `manualTargets` allows, minus any that reads as where it already is
 * (refining → new is Backlog → Backlog).
 */
function editTargets(task: TaskDto): TaskStatus[] {
  const here = taskStatusCategory(task.status)
  return manualTargets(task.status, { bound: task.remote != null })
    .filter((status) => taskStatusCategory(status) !== here)
}

/** Edit task, from the task page's ⋯. */
export function EditTaskDialog({ task, update, setStatus, onClose }: {
  task: TaskDto
  /** Owned by the actions menu, which lives as long as the page. */
  update: ReturnType<typeof useUpdateTask>
  setStatus: ReturnType<typeof useSetTaskStatus>
  onClose: () => void
}): React.JSX.Element {
  const cardRef = useRef<HTMLDivElement>(null)
  const [title, setTitle] = useState(task.title)
  const [description, setDescription] = useState(task.description ?? '')
  const [priority, setPriority] = useState<TaskPriority>(task.priority)
  const startAgent = task.assignee.kind === 'agent' && task.assignee.agentId ? task.assignee.agentId : NO_AGENT
  const [assignee, setAssignee] = useState(startAgent)
  const [status, setStatusChoice] = useState<TaskStatus>(task.status)
  const [rows, setRows] = useState<FieldRow[]>(() => rowsFrom(task.customFields))
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const startRows = useState(() => rowsText(rowsFrom(task.customFields)))[0]
  const dirty = title !== task.title || description !== (task.description ?? '') || priority !== task.priority ||
    assignee !== startAgent || status !== task.status || rowsText(rows) !== startRows
  const dismiss = useDismiss(cardRef, { busy: saving, dirty }, onClose)
  const lock = assigneeLockReason(task)
  const targets = editTargets(task)
  const statusLock = statusLockReason(task, targets)
  const statuses = [task.status, ...(statusLock ? [] : targets)]

  const save = async (): Promise<void> => {
    if (saving) return
    if (!title.trim()) { setError('Title is required.'); return }
    const fields = fieldsFrom(rows)
    if ('error' in fields) { setError(fields.error); return }
    const patch: TaskUpdateInput = {}
    if (title.trim() !== task.title) patch.title = title.trim()
    const nextDescription = description.trim() ? description : null
    if (nextDescription !== task.description) patch.description = nextDescription
    if (priority !== task.priority) patch.priority = priority
    if (!lock && assignee !== startAgent) patch.assignee = assigneeInput(assignee)
    if (!sameFields(task.customFields, fields.fields)) patch.customFields = Object.keys(fields.fields).length ? fields.fields : null
    setError(null)
    setSaving(true)
    // The status first: it is the write main is likelier to refuse, and when it
    // is refused nothing has been saved, so the sentence is simply main's.
    let statusSaved = false
    try {
      if (status !== task.status) {
        await setStatus.mutateAsync({ taskId: task.id, status })
        statusSaved = true
      }
      if (Object.keys(patch).length > 0) await update.mutateAsync({ taskId: task.id, patch })
      setSaving(false)
      onClose()
    } catch (err) {
      setSaving(false)
      const reason = unwrapIpcError(err, 'The task could not be saved.')
      // Say exactly what was kept: the status is written, the rest is still in the form.
      setError(statusSaved ? `Status changed; the other edits were not saved: ${reason}` : reason)
    }
  }

  const current = task.assignee.kind === 'agent' && task.assignee.agentId
    ? { id: task.assignee.agentId, name: task.assignee.name ?? 'Unnamed agent' }
    : null

  return (
    <DialogFrame label="Edit task" cardRef={cardRef}>
      <form className="mt-4 space-y-3" onSubmit={(event) => { event.preventDefault(); void save() }}>
        <div className="space-y-1.5">
          <label htmlFor="edit-task-title" className={LABEL}>Title</label>
          <input id="edit-task-title" type="text" value={title} disabled={saving}
            onChange={(event) => setTitle(event.target.value)} className={INPUT} />
        </div>
        <div className="space-y-1.5">
          <div className={LABEL}>Goal</div>
          <p className="max-h-20 overflow-y-auto whitespace-pre-wrap text-xs text-[var(--color-text-secondary)]">{task.goal}</p>
        </div>
        <div className="space-y-1.5">
          <label htmlFor="edit-task-description" className={LABEL}>Description</label>
          <textarea id="edit-task-description" rows={3} value={description} disabled={saving}
            onChange={(event) => setDescription(event.target.value)} className={`${INPUT} resize-none`} />
        </div>
        <div className="grid grid-cols-2 gap-3">
          <PriorityField id="edit-task-priority" value={priority} onChange={setPriority} disabled={saving} />
          <div className="space-y-1.5">
            <label htmlFor="edit-task-status" className={LABEL}>Status</label>
            <select id="edit-task-status" value={status} disabled={saving || !!statusLock} className={INPUT}
              onChange={(event) => setStatusChoice(event.target.value as TaskStatus)}>
              {statuses.map((entry) => <option key={entry} value={entry}>{taskStatusLabel(entry)}</option>)}
            </select>
            {statusLock && <p className="text-[10px] text-[var(--color-text-muted)]">{statusLock}</p>}
          </div>
        </div>
        <AssigneeField id="edit-task-assignee" value={assignee} onChange={setAssignee}
          disabled={saving || !!lock} reason={lock} current={current} />
        <CustomFieldsEditor rows={rows} onChange={setRows} disabled={saving} />
        <div className="flex justify-end gap-2 pt-1">
          <button type="button" onClick={dismiss} disabled={saving} className={CANCEL}>Cancel</button>
          <button type="submit" disabled={saving} className={PRIMARY}>{saving ? 'Saving…' : 'Save'}</button>
        </div>
      </form>
      <ErrorLine message={error} />
    </DialogFrame>
  )
}
