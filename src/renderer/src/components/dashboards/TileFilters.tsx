import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { MoreHorizontal, X } from 'lucide-react'
import { resolveParamWords, type ComponentParamSpec } from '../../../../shared/dashboards'
import { usePopover } from '../ui/usePopover'

/** The filter row's height under the tile's bar; always this, whatever the values (ux rule 1). */
export const FILTER_ROW_HEIGHT = 'h-8'
export const FILTER_ROW_TOP = 'top-[3.75rem]'

/** Typing in a text or number filter recomputes once the typing stops. */
export const FILTER_TEXT_DEBOUNCE_MS = 600

const CONTROL =
  'h-6 rounded border border-[var(--color-border)] bg-[var(--color-bg-secondary)] px-1.5 text-[11px] text-[var(--color-text)] focus:border-[var(--color-accent)] focus:outline-none'
const LABEL = 'shrink-0 text-[10px] text-[var(--color-text-muted)]'

/**
 * Each control's width, fixed by its type and never by its value: the row
 * decides from these which filters fit, so a pick never moves one into or
 * out of the "Filters ⋯" popover (ux rule 1).
 */
const WIDTH = { select: 'w-28', text: 'w-28', number: 'w-20', date: 'w-[8.5rem]', check: 'w-3.5' } as const
/** Between filters in the row (`gap-3`), and the row's own padding (`px-2`, both sides). */
const ROW_GAP_PX = 12
const ROW_PADDING_PX = 16

/**
 * How many filters, in order, fit a row `available` px wide: all of them, or
 * as many as leave room for the "Filters ⋯" button beside them. Widths of 0
 * (not laid out yet, or jsdom) fit.
 */
export function filtersThatFit(available: number, widths: number[], moreWidth: number, gap = ROW_GAP_PX): number {
  const total = widths.reduce((sum, width, index) => sum + width + (index > 0 ? gap : 0), 0)
  if (total <= available) return widths.length
  let used = moreWidth
  let count = 0
  for (const width of widths) {
    const next = used + gap + width
    if (next > available) break
    used = next
    count += 1
  }
  return count
}

/** The native views that get a filter row: a page sets its own params (`cinna.setParams`). */
export function hasFilterRow(view: string | null | undefined, params: Record<string, ComponentParamSpec> | undefined): boolean {
  return !!view && view !== 'html' && !!params && Object.keys(params).length > 0
}

type DateRange = { from: string; to: string }

function asDateRange(value: unknown): DateRange {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const record = value as Record<string, unknown>
    return { from: typeof record.from === 'string' ? record.from : '', to: typeof record.to === 'string' ? record.to : '' }
  }
  return { from: '', to: '' }
}

function asText(value: unknown): string {
  return value === null || value === undefined ? '' : typeof value === 'string' ? value : String(value)
}

/**
 * A control's own copy of its value: it shows what the user picked at once,
 * and follows the tile's stored value when that changes (or a change was
 * refused, `revision`), except while the user is typing in it.
 */
function useDraft<T>(value: T, revision: number) {
  const [draft, setDraft] = useState(value)
  const editing = useRef(false)
  const key = JSON.stringify(value ?? null)
  useEffect(() => {
    if (!editing.current) setDraft(value)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, revision])
  return { draft, setDraft, editing }
}

/** Text and number: debounced, flushed on Enter and on blur. */
function TypedControl({
  id,
  kind,
  value,
  revision,
  onChange
}: {
  id: string
  kind: 'text' | 'number'
  value: unknown
  revision: number
  onChange: (value: unknown) => void
}): React.JSX.Element {
  const { draft, setDraft, editing } = useDraft(asText(value), revision)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const sent = useRef(asText(value))
  sent.current = asText(value)
  const commit = (text: string): void => {
    if (timer.current) clearTimeout(timer.current)
    timer.current = null
    if (text === sent.current) return
    if (kind === 'number') {
      if (text.trim() === '') return onChange(undefined)
      const n = Number(text)
      if (!Number.isFinite(n)) return
      return onChange(n)
    }
    onChange(text)
  }
  // Unmounted while the typing waits (the "Filters ⋯" popover closed, or the tile was resized): send it now.
  const pending = useRef<string | null>(null)
  const commitRef = useRef(commit)
  commitRef.current = commit
  useEffect(() => () => {
    if (timer.current && pending.current !== null) commitRef.current(pending.current)
  }, [])
  return (
    <input
      id={id}
      type={kind === 'number' ? 'number' : 'text'}
      className={`${CONTROL} ${kind === 'number' ? WIDTH.number : WIDTH.text}`}
      value={draft}
      onFocus={() => { editing.current = true }}
      onBlur={() => { editing.current = false; commit(draft) }}
      onKeyDown={(event) => { if (event.key === 'Enter') commit(draft) }}
      onChange={(event) => {
        const next = event.target.value
        setDraft(next)
        if (timer.current) clearTimeout(timer.current)
        pending.current = next
        timer.current = setTimeout(() => commit(next), FILTER_TEXT_DEBOUNCE_MS)
      }}
    />
  )
}

function ParamControl({
  id,
  spec,
  value,
  revision,
  onChange
}: {
  id: string
  spec: ComponentParamSpec
  value: unknown
  revision: number
  onChange: (value: unknown) => void
}): React.JSX.Element {
  const { draft, setDraft } = useDraft<unknown>(value, revision)
  const pick = (next: unknown): void => {
    setDraft(next)
    onChange(next)
  }
  switch (spec.type) {
    case 'enum': {
      const values = spec.values ?? []
      const current = asText(draft)
      return (
        <select id={id} className={`${CONTROL} ${WIDTH.select}`} value={current} onChange={(e) => pick(e.target.value)}>
          {!values.includes(current) && <option value={current}>{current === '' ? '—' : current}</option>}
          {values.map((v) => <option key={v} value={v}>{v}</option>)}
        </select>
      )
    }
    // A cleared date or month is no value (the default again), never "", which main refuses.
    case 'month':
      return <input id={id} type="month" className={`${CONTROL} ${WIDTH.date}`} value={asText(draft)} onChange={(e) => pick(e.target.value === '' ? undefined : e.target.value)} />
    case 'date':
      return <input id={id} type="date" className={`${CONTROL} ${WIDTH.date}`} value={asText(draft)} onChange={(e) => pick(e.target.value === '' ? undefined : e.target.value)} />
    case 'date_range': {
      const range = asDateRange(draft)
      // An empty end is an open end; both empty is no range at all.
      const pickRange = (next: DateRange): void => pick(next.from === '' && next.to === '' ? undefined : next)
      return (
        <span className="flex shrink-0 items-center gap-1">
          <input id={id} type="date" aria-label="From" className={`${CONTROL} ${WIDTH.date}`} value={range.from} onChange={(e) => pickRange({ ...range, from: e.target.value })} />
          <span className="text-[10px] text-[var(--color-text-muted)]">–</span>
          <input type="date" aria-label="To" className={`${CONTROL} ${WIDTH.date}`} value={range.to} onChange={(e) => pickRange({ ...range, to: e.target.value })} />
        </span>
      )
    }
    case 'boolean':
      return <input id={id} type="checkbox" className={`h-3.5 ${WIDTH.check}`} checked={draft === true} onChange={(e) => pick(e.target.checked)} />
    case 'number':
      return <TypedControl id={id} kind="number" value={value} revision={revision} onChange={onChange} />
    default:
      return <TypedControl id={id} kind="text" value={value} revision={revision} onChange={onChange} />
  }
}

/** A stand-in of a filter's size, for measuring: its label and a box as wide as its control. */
function FilterSize({ spec, name }: { spec: ComponentParamSpec; name: string }): React.JSX.Element {
  const box = (width: string): React.JSX.Element => <span className={`h-6 ${width} shrink-0`} />
  return (
    <span className="flex shrink-0 items-center gap-1.5">
      <span className={LABEL}>{spec.label ?? name}</span>
      {spec.type === 'enum' ? box(WIDTH.select)
        : spec.type === 'month' || spec.type === 'date' ? box(WIDTH.date)
        : spec.type === 'date_range' ? <span className="flex shrink-0 items-center gap-1">{box(WIDTH.date)}<span className="text-[10px]">–</span>{box(WIDTH.date)}</span>
        : spec.type === 'boolean' ? box(WIDTH.check)
        : spec.type === 'number' ? box(WIDTH.number)
        : box(WIDTH.text)}
    </span>
  )
}

const MORE_BUTTON =
  'flex h-6 shrink-0 items-center gap-1 rounded border border-[var(--color-border)] px-1.5 text-[11px] text-[var(--color-text)] hover:bg-[var(--color-bg-hover)]'

/**
 * A native tile's filters (README D4): one control per param of its
 * component, in a row of fixed height under the bar, always drawn (never on
 * hover). The filters that fit the tile's width sit in the row, in order; the
 * rest are behind "Filters ⋯". Which ones fit depends on the tile's width
 * and the params' types only, never on their values, so nothing moves while
 * the user picks (ux rule 1). Values are the tile's, else the component's
 * defaults (`current` and `today` shown as the month and day they mean). A
 * change hands `{name: value}` to `onChange` (`undefined`: back to the
 * default); text and numbers wait until the typing stops. `notice` (a
 * refused value) lies over the content just under the row, so the row and
 * the tile move nothing.
 */
export function TileFilters({
  tileId,
  specs,
  params,
  revision,
  notice,
  onDismissNotice,
  onChange,
  resolved,
  disabled = false
}: {
  tileId: string
  specs: Record<string, ComponentParamSpec>
  /** The tile's stored params (without defaults). */
  params: Record<string, unknown>
  /**
   * A cloud tile's `params_resolved` (D6): where a value is the word
   * `current` or `today`, the control shows what core resolved it to, so the
   * row never disagrees with the data core computed (core's timezone, not ours).
   */
  resolved?: Record<string, unknown> | null
  /** Nothing can run for this tile (its cloud agent is gone, or another server): the controls stay in place, disabled. */
  disabled?: boolean
  /** Bumped when a change was refused: the controls go back to the stored values. */
  revision: number
  /** Why the last change was not applied, or null. */
  notice?: string | null
  onDismissNotice?: () => void
  onChange: (changed: Record<string, unknown>) => void
}): React.JSX.Element {
  const shown = resolveParamWords(params, specs)
  if (resolved) {
    for (const [name, spec] of Object.entries(specs)) {
      const raw = name in params ? params[name] : spec.default
      if ((raw === 'current' || raw === 'today') && resolved[name] !== undefined) shown[name] = resolved[name]
    }
  }
  const entries = Object.entries(specs)
  const rowRef = useRef<HTMLDivElement>(null)
  const sizesRef = useRef<HTMLDivElement>(null)
  const [fit, setFit] = useState(entries.length)
  const more = usePopover<HTMLButtonElement, HTMLDivElement>('below-right', { flipWhenNoRoom: true })
  const shape = entries.map(([name, spec]) => `${name}:${spec.type}:${spec.label ?? ''}`).join('|')

  // Measured before paint, and again when the tile is resized; never on a value change.
  useLayoutEffect(() => {
    const row = rowRef.current
    const sizes = sizesRef.current
    if (!row || !sizes) return
    const measure = (): void => {
      const children = Array.from(sizes.children) as HTMLElement[]
      const widths = children.slice(0, -1).map((child) => child.getBoundingClientRect().width)
      const moreWidth = children.at(-1)?.getBoundingClientRect().width ?? 0
      const available = row.getBoundingClientRect().width - ROW_PADDING_PX
      setFit(available <= 0 ? widths.length : filtersThatFit(available, widths, moreWidth))
    }
    measure()
    if (typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(measure)
    observer.observe(row)
    return () => observer.disconnect()
  }, [shape])

  const control = (name: string, spec: ComponentParamSpec): React.JSX.Element => {
    const id = `tile-${tileId}-param-${name}`
    return (
      <span key={name} className="flex shrink-0 items-center gap-1.5">
        <label htmlFor={id} className={LABEL}>{spec.label ?? name}</label>
        <ParamControl id={id} spec={spec} value={shown[name]} revision={revision} onChange={(value) => onChange({ [name]: value })} />
      </span>
    )
  }
  const inRow = entries.slice(0, fit)
  const behind = entries.slice(fit)
  const { open: moreOpen, setOpen: setMoreOpen } = more
  useEffect(() => {
    if (behind.length === 0 && moreOpen) setMoreOpen(false)
  }, [behind.length, moreOpen, setMoreOpen])

  return (
    // A disabled fieldset disables every control in the row, and "Filters ⋯" with them.
    <fieldset disabled={disabled} aria-disabled={disabled || undefined} className={`relative m-0 min-w-0 border-0 p-0 ${disabled ? 'opacity-50' : ''}`}>
      <div
        ref={rowRef}
        data-testid="tile-filters"
        className={`relative flex ${FILTER_ROW_HEIGHT} items-center gap-3 overflow-hidden whitespace-nowrap border-b border-[var(--color-border)] bg-[var(--color-bg)] px-2`}
      >
        {/* The sizes the row decides by: invisible, out of the flow, and never focusable. */}
        <div ref={sizesRef} aria-hidden="true" className="pointer-events-none invisible absolute left-0 top-0 flex items-center gap-3">
          {entries.map(([name, spec]) => <FilterSize key={name} name={name} spec={spec} />)}
          <span className={MORE_BUTTON}>Filters<MoreHorizontal size={12} /></span>
        </div>
        {inRow.map(([name, spec]) => control(name, spec))}
        {behind.length > 0 && (
          <button
            ref={more.triggerRef}
            type="button"
            aria-haspopup="dialog"
            aria-expanded={more.open}
            title={`${behind.length} more ${behind.length === 1 ? 'filter' : 'filters'}`}
            onClick={() => more.setOpen(!more.open)}
            // Opened with the mouse, focus stays here: Escape closes it from the button too.
            onKeyDown={(event) => {
              if (event.key === 'Escape' && more.open) {
                event.stopPropagation()
                more.setOpen(false)
              }
            }}
            className={`${MORE_BUTTON} ml-auto`}
          >
            Filters<MoreHorizontal size={12} aria-hidden="true" />
          </button>
        )}
      </div>
      {notice && (
        <div role="alert" data-testid="tile-filter-notice" className="absolute inset-x-0 top-full z-10 flex items-start gap-2 border-b border-[var(--color-border)] bg-[var(--color-bg)] px-2 py-1 text-[11px] text-[var(--color-danger)]">
          <span className="min-w-0 flex-1">{notice}</span>
          {onDismissNotice && (
            <button type="button" aria-label="Dismiss" onClick={onDismissNotice} className="shrink-0 rounded p-0.5 text-[var(--color-text-muted)] hover:bg-[var(--color-bg-hover)] hover:text-[var(--color-text)]">
              <X size={11} />
            </button>
          )}
        </div>
      )}
      {more.open && behind.length > 0 && more.style && createPortal(
        <div
          ref={more.popoverRef}
          role="dialog"
          aria-label="More filters"
          style={more.style}
          onKeyDown={(event) => {
            if (event.key === 'Escape') {
              event.stopPropagation()
              more.setOpen(false)
              more.triggerRef.current?.focus()
            }
          }}
          className="app-popover-surface z-50 flex max-w-[calc(100vw-1rem)] flex-col gap-2 rounded-lg border border-[var(--color-border)] p-2 shadow-xl"
        >
          {behind.map(([name, spec]) => control(name, spec))}
        </div>,
        document.body
      )}
    </fieldset>
  )
}
