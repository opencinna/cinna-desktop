import { useId, useRef } from 'react'
import { CalendarDays } from 'lucide-react'
import { COMPUTED_DEFAULT_TEXT, type ScriptParam, type ScriptSpec } from '../../../../shared/scriptSpec'
import { switchOn, type ScriptValues } from '../../../../shared/scriptArgs'
import { SettingsInfoTip, SettingsSwitch } from '../settings/SettingsLayout'

/** Marks the window's portaled ⋯ menu, so a press on it is not a press outside the card. */
export const RUN_SCRIPT_POPOVER_ATTR = 'data-run-script-popover'

/** Segmented buttons for at most this many choices, when their labels fit; else a select. */
const SEGMENT_MAX = 4
const SEGMENT_MAX_CHARS = 24

/** Every label of the form, switches and the Other arguments line included (the app-chrome scale). */
const labelClass = 'text-[11px] font-medium leading-4'
const fieldClass = `h-7 min-w-0 flex-1 rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] px-2 py-1 font-mono text-[12px]
  leading-5 text-[var(--color-text)] placeholder:font-sans placeholder:text-[var(--color-text-muted)] focus:border-[var(--color-accent)]
  focus:outline-none read-only:text-[var(--color-text-secondary)] disabled:text-[var(--color-text-secondary)]`
const sideButton = `inline-flex h-7 shrink-0 items-center justify-center gap-1 rounded-md border border-[var(--color-border)] px-2 text-[11px]
  font-medium leading-4 text-[var(--color-text)] transition-colors hover:bg-[var(--color-bg-hover)] disabled:opacity-50 disabled:hover:bg-transparent`

/** The default as an empty field shows it: the literal, or that the script works it out. */
function defaultLabel(param: ScriptParam): string | null {
  if (param.defaultText !== null) return param.defaultText
  return param.defaultComputed ? COMPUTED_DEFAULT_TEXT : null
}

/** What an empty field means: the script's default, else the format it wants. */
export function paramPlaceholder(param: ScriptParam): string {
  if (param.defaultText !== null) return `default: ${param.defaultText}`
  if (param.defaultComputed) return COMPUTED_DEFAULT_TEXT
  if (param.valueType === 'date') return 'YYYY-MM-DD'
  if (param.valueType === 'month') return 'YYYY-MM'
  if (param.valueType === 'year') return 'YYYY'
  if (param.kind === 'count') return '0'
  return param.metavar ?? ''
}

/** Choices shown as segmented buttons rather than a select. */
function segmented(param: ScriptParam): boolean {
  const choices = param.choices
  return !!choices && !param.multiple && choices.length <= SEGMENT_MAX && choices.join('').length <= SEGMENT_MAX_CHARS
}

/** Writing switches go last, under a divider; everything else keeps the spec's order. */
function groups(spec: ScriptSpec): { main: ScriptParam[]; writers: ScriptParam[] } {
  return {
    main: spec.params.filter((param) => !(param.kind === 'switch' && param.writes)),
    writers: spec.params.filter((param) => param.kind === 'switch' && param.writes)
  }
}

/**
 * The Run Script window's right sidebar: the script's parameters as a form,
 * in step with the command line. The window owns the values (read from the
 * line, written back to it); this only draws them.
 *
 * Its rows are fixed by the spec: typing, toggling, a run and the
 * hand-edited state change values and the one header line, never the
 * layout (ux_rules §1). Empty fields are omitted from the command.
 */
export function RunScriptForm({
  spec, values, other, readOnly, handEdited, scriptName, onChange, onChoosePath
}: {
  spec: ScriptSpec
  values: ScriptValues
  other: string
  /** A run is going or starting: everything reads, nothing edits. */
  readOnly: boolean
  /** The line no longer names the script as one simple command: the form shows its last values, read-only. */
  handEdited: boolean
  scriptName: string
  onChange: (values: ScriptValues, other: string) => void
  /** Choose… on a path: the path the form writes, or null for nothing chosen. */
  onChoosePath: () => Promise<string | null>
}): React.JSX.Element {
  const locked = readOnly || handEdited
  const { main, writers } = groups(spec)
  const set = (id: string, value: string | boolean): void => {
    if (!locked) onChange({ ...values, [id]: value }, other)
  }
  const row = (param: ScriptParam): React.JSX.Element => (
    <ParamRow key={param.id} param={param} value={values[param.id]} locked={locked}
      onValue={(value) => set(param.id, value)} onChoosePath={onChoosePath} />
  )
  const otherId = useId()

  return (
    <aside aria-label="Parameters" className="flex w-[19rem] shrink-0 flex-col border-l border-[var(--color-border)]">
      {/* One fixed-height line, filled in every state: where the form came from, or why it does not follow the line. */}
      <div data-slot="form-state" className="flex h-9 shrink-0 items-center gap-1 border-b border-[var(--color-border)] px-3">
        {handEdited ? (
          <p className="line-clamp-2 min-w-0 flex-1 text-[11px] leading-4 text-[var(--color-text-secondary)]">
            {`Edited by hand — the form follows the command again when it names ${scriptName}.`}
          </p>
        ) : (
          <p className="min-w-0 flex-1 truncate text-[11px] leading-4 text-[var(--color-text-muted)]">
            From <span className="font-mono">{scriptName}</span>
          </p>
        )}
        <SettingsInfoTip label={`About the parameters of ${scriptName}`}>
          <p>Read from the script&apos;s source; it is not run to find them. An empty field is left out of the command, and the script&apos;s own default applies.</p>
          <p>While the command no longer names {scriptName} as one simple command, the form shows its last values and does not edit.</p>
          {spec.usage && <p className="whitespace-pre-wrap font-mono text-[12px] text-[var(--color-text-muted)]">{spec.usage}</p>}
        </SettingsInfoTip>
      </div>
      {/* Both reserve the scrollbar's gutter (none where scrollbars overlay), so the Other arguments field ends where the fields above do. */}
      <div className={`min-h-0 flex-1 space-y-2 overflow-y-auto px-3 py-2 [scrollbar-gutter:stable]${handEdited ? ' opacity-60' : ''}`}>
        {main.map(row)}
        {writers.length > 0 && (
          <div className="space-y-2 border-t border-[var(--color-border)] pt-2">{writers.map(row)}</div>
        )}
      </div>
      <div className={`flex shrink-0 items-center gap-2 overflow-hidden border-t border-[var(--color-border)] px-3 py-1.5 [scrollbar-gutter:stable]${handEdited ? ' opacity-60' : ''}`}>
        <label htmlFor={otherId} className={`${labelClass} shrink-0 whitespace-nowrap text-[var(--color-text-secondary)]`}>Other arguments</label>
        <input id={otherId} type="text" className={fieldClass} value={other} readOnly={locked} spellCheck={false}
          autoCapitalize="off" autoCorrect="off"
          onChange={(event) => { if (!locked) onChange(values, event.target.value) }} />
      </div>
    </aside>
  )
}

/** A param's flags as its tip and title name them: `--x, -x`, with a switch's off flags after a slash (`--x/--no-x`). */
function flagList(param: ScriptParam): string {
  const on = param.flags.join(', ')
  return param.offFlags.length > 0 ? `${on} / ${param.offFlags.join(', ')}` : on
}

/** The (?) beside a parameter's label: its help, its default when a segmented control cannot show it, and its flags. */
function ParamTip({ param }: { param: ScriptParam }): React.JSX.Element | null {
  // A `--x/--no-x` switch can open already on with nothing on the line: its tip says so.
  const negatable = param.kind === 'switch' && param.offFlags.length > 0
  const shownDefault = segmented(param) ? defaultLabel(param) : negatable ? (param.defaultOn ? 'on' : 'off') : null
  if (!param.help && shownDefault === null) return null
  const flags = flagList(param)
  return (
    <SettingsInfoTip label={`About ${param.label}`}>
      {param.help && <p className="whitespace-pre-line">{param.help}</p>}
      {shownDefault !== null && <p>Default: <span className="font-mono">{shownDefault}</span></p>}
      {/* A getopts letter no variable names is labelled by its flag: not said twice. */}
      {param.flags.length > 0 && flags !== param.label && <p className="font-mono text-[12px] text-[var(--color-text-muted)]">{flags}</p>}
    </SettingsInfoTip>
  )
}

function ParamRow({ param, value, locked, onValue, onChoosePath }: {
  param: ScriptParam
  value: string | boolean | undefined
  locked: boolean
  onValue: (value: string | boolean) => void
  onChoosePath: () => Promise<string | null>
}): React.JSX.Element {
  const id = useId()
  const labelTone = param.writes ? 'text-[var(--color-warning)]' : 'text-[var(--color-text-secondary)]'
  if (param.kind === 'switch') {
    // The effective value: a `--x/--no-x` switch declared on shows on until the line turns it off.
    const on = switchOn(param, value)
    return (
      <div className="flex h-6 items-center gap-1">
        <label htmlFor={id} className={`min-w-0 truncate ${labelClass} ${labelTone}`} title={flagList(param)}>{param.label}</label>
        <ParamTip param={param} />
        <span className="ml-auto flex shrink-0 items-center gap-2">
          {param.writes && <span className="text-[10px] text-[var(--color-warning)]">writes</span>}
          <SettingsSwitch id={id} checked={on} disabled={locked} onToggle={() => onValue(!on)} />
        </span>
      </div>
    )
  }
  const text = typeof value === 'string' ? value : ''
  return (
    <div className="space-y-1">
      <div className="flex h-5 items-center gap-1">
        <label htmlFor={id} className={`min-w-0 truncate ${labelClass} ${labelTone}`}
          title={param.flags.length > 0 ? param.flags.join(', ') : undefined}>
          {param.label}
          {param.kind === 'positional' && param.required && <span aria-hidden className="text-[var(--color-text-muted)]"> *</span>}
        </label>
        <ParamTip param={param} />
      </div>
      <ParamControl id={id} param={param} value={text} locked={locked} onValue={onValue} onChoosePath={onChoosePath} />
    </div>
  )
}

function ParamControl({ id, param, value, locked, onValue, onChoosePath }: {
  id: string
  param: ScriptParam
  value: string
  locked: boolean
  onValue: (value: string) => void
  onChoosePath: () => Promise<string | null>
}): React.JSX.Element {
  const dateRef = useRef<HTMLInputElement>(null)
  const required = param.kind === 'positional' && param.required
  const choices = param.choices
  if (choices && !param.multiple) {
    if (segmented(param)) {
      return (
        <div id={id} role="group" aria-label={param.label} className="flex h-7 overflow-hidden rounded-md border border-[var(--color-border)]">
          {choices.map((choice) => {
            const on = value === choice
            return (
              <button key={choice} type="button" aria-pressed={on} disabled={locked}
                title={on ? 'Click again to leave it to the script' : undefined}
                onClick={() => onValue(on ? '' : choice)}
                className={`min-w-0 flex-1 truncate border-l border-[var(--color-border)] px-2 font-mono text-[12px] first:border-l-0
                  transition-colors disabled:cursor-default disabled:opacity-50 ${on
                    ? 'bg-[var(--color-accent)]/15 text-[var(--color-accent)]'
                    : 'text-[var(--color-text-secondary)] enabled:hover:bg-[var(--color-bg-hover)]'}`}>
                {choice}
              </button>
            )
          })}
        </div>
      )
    }
    const shownDefault = defaultLabel(param)
    return (
      <div className="flex">
        <select id={id} className={fieldClass} value={value} disabled={locked} aria-required={required || undefined}
          onChange={(event) => onValue(event.target.value)}>
          <option value="">{param.defaultText !== null ? `default: ${param.defaultText}` : shownDefault ?? '—'}</option>
          {choices.map((choice) => <option key={choice} value={choice}>{choice}</option>)}
        </select>
      </div>
    )
  }
  const numeric = !param.multiple && (param.valueType === 'int' || param.valueType === 'float' || param.valueType === 'year' || param.kind === 'count')
  const field = (
    <input id={id} type="text" className={fieldClass} value={value} readOnly={locked} spellCheck={false}
      autoCapitalize="off" autoCorrect="off" inputMode={numeric ? (param.valueType === 'float' ? 'decimal' : 'numeric') : undefined}
      placeholder={paramPlaceholder(param)} aria-required={required || undefined}
      onChange={(event) => onValue(event.target.value)} />
  )
  if (param.valueType === 'date' && !param.multiple) {
    return (
      <div className="flex gap-1.5">
        {/* The native calendar sits invisibly at the field's left edge, so the picker opens under the field rather than past the window's edge; its choice lands in the field. */}
        <span className="relative flex min-w-0 flex-1">
          {field}
          <input ref={dateRef} type="date" tabIndex={-1} aria-hidden className="pointer-events-none absolute bottom-0 left-0 h-full w-px opacity-0"
            onChange={(event) => { if (event.target.value) onValue(event.target.value) }} />
        </span>
        <button type="button" className={`${sideButton} w-7 px-0`} aria-label={`Pick a date for ${param.label}`} title="Pick a date"
          disabled={locked} onClick={() => {
            const picker = dateRef.current
            if (!picker) return
            picker.value = /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : ''
            try { picker.showPicker?.() } catch { /* no picker here: the field still takes a typed date */ }
          }}>
          <CalendarDays size={13} aria-hidden />
        </button>
      </div>
    )
  }
  if (param.valueType === 'path' && !param.multiple) {
    return (
      <div className="flex gap-1.5">
        {field}
        <button type="button" className={sideButton} disabled={locked} aria-label={`Choose a path for ${param.label}`}
          onClick={() => { void onChoosePath().then((path) => { if (path !== null) onValue(path) }) }}>
          Choose…
        </button>
      </div>
    )
  }
  return <div className="flex">{field}</div>
}
