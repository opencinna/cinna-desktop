import { useEffect, useId, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Check, ChevronDown } from 'lucide-react'
import { usePopover } from '../../ui/usePopover'

/**
 * The zone's current offset, "GMT+2". Always the en-US wording, so searching
 * "gmt+2" works whatever the system locale. Empty for a zone Intl rejects.
 */
export function timezoneOffset(zone: string, at = new Date()): string {
  try {
    return new Intl.DateTimeFormat('en-US', { timeZone: zone, timeZoneName: 'shortOffset' })
      .formatToParts(at).find((part) => part.type === 'timeZoneName')?.value ?? ''
  } catch { return '' }
}

const displayName = (zone: string) => zone.replace(/_/g, ' ')

/**
 * Every zone Intl knows, plus UTC and the current value: a stored zone must
 * never vanish from the list just because this runtime does not list it.
 */
export function timezoneOptions(current: string): string[] {
  const zones = typeof Intl.supportedValuesOf === 'function' ? Intl.supportedValuesOf('timeZone') : []
  const all = new Set(zones)
  all.add('UTC')
  if (current) all.add(current)
  return [...all].sort((a, b) => a.localeCompare(b))
}

/** Case-insensitive; spaces and underscores are the same; offsets match too. */
export function matchesTimezone(zone: string, offset: string, query: string): boolean {
  const q = query.trim().toLowerCase().replace(/_/g, ' ')
  if (!q) return true
  return displayName(zone).toLowerCase().includes(q) || offset.toLowerCase().includes(q)
}

const MIN_WIDTH = 288 // 18rem

/**
 * A searchable timezone picker. The trigger looks like the form's other
 * inputs; the list opens as an overlay under it, so opening it changes the
 * size of nothing (ux_rules rule 1). Inside a modal <dialog> it portals into
 * the dialog, which is in the top layer, as SettingsInfoTip does. Escape
 * closes the list only: the keydown is cancelled, so the dialog never sees a
 * close request.
 */
export function TimezonePicker({ value, onChange, labelledBy, className }: {
  value: string; onChange(zone: string): void; labelledBy: string; className: string
}) {
  const popover = usePopover<HTMLButtonElement, HTMLDivElement>('below-right')
  const id = useId()
  const [query, setQuery] = useState('')
  const [active, setActive] = useState(0)
  const [width, setWidth] = useState(MIN_WIDTH)
  const list = useRef<HTMLDivElement>(null)
  const triggerOffset = useMemo(() => timezoneOffset(value), [value])
  // Offsets are read once per open: they change only at a DST boundary.
  const rows = useMemo(() => {
    if (!popover.open) return []
    const at = new Date()
    return timezoneOptions(value).map((zone) => ({ zone, offset: timezoneOffset(zone, at) }))
  }, [popover.open, value])
  const filtered = useMemo(() => rows.filter((row) => matchesTimezone(row.zone, row.offset, query)), [rows, query])

  const open = () => {
    const current = timezoneOptions(value).indexOf(value)
    setQuery('')
    setActive(current < 0 ? 0 : current)
    setWidth(Math.max(MIN_WIDTH, popover.triggerRef.current?.getBoundingClientRect().width ?? 0))
    popover.setOpen(true)
  }
  const close = (refocus: boolean) => {
    popover.setOpen(false)
    if (refocus) popover.triggerRef.current?.focus()
  }
  const pick = (zone: string) => { onChange(zone); close(true) }

  // Keep the active option in view: the current zone on open, then wherever
  // the arrows move it. jsdom has no scrollIntoView, hence the optional call.
  useEffect(() => {
    if (!popover.open) return
    list.current?.querySelector<HTMLElement>(`[data-index="${active}"]`)?.scrollIntoView?.({ block: 'nearest' })
  }, [popover.open, popover.style, active, filtered])

  const onKeyDown = (event: React.KeyboardEvent) => {
    if (event.key === 'Escape') {
      // Cancelling the keydown keeps the dialog's close request from firing.
      event.preventDefault(); event.stopPropagation(); close(true)
    } else if (event.key === 'Tab') {
      event.preventDefault(); close(true)
    } else if (event.key === 'ArrowDown') {
      event.preventDefault(); setActive((index) => Math.min(filtered.length - 1, index + 1))
    } else if (event.key === 'ArrowUp') {
      event.preventDefault(); setActive((index) => Math.max(0, index - 1))
    } else if (event.key === 'Enter') {
      event.preventDefault()
      if (filtered[active]) pick(filtered[active].zone)
    }
  }

  return <>
    <button ref={popover.triggerRef} type="button" aria-labelledby={labelledBy} aria-haspopup="listbox" aria-expanded={popover.open}
      onClick={() => popover.open ? close(false) : open()}
      className={`${className} flex items-center gap-2 text-left font-normal`}>
      <span className="min-w-0 flex-1 truncate">{displayName(value) || 'Choose a timezone'}{triggerOffset && <span className="text-[var(--color-text-muted)]"> · {triggerOffset}</span>}</span>
      <ChevronDown size={14} className="shrink-0 text-[var(--color-text-muted)]" />
    </button>
    {popover.open && popover.style && createPortal(
      <div ref={popover.popoverRef} style={{ ...popover.style, width }} onKeyDown={onKeyDown}
        className="app-popover-surface z-50 max-w-[calc(100vw-1rem)] rounded-lg border border-[var(--color-border)] p-1.5 shadow-xl">
        <input autoFocus value={query} placeholder="Search timezones" aria-label="Search timezones"
          aria-controls={`${id}-list`} aria-activedescendant={filtered[active] ? `${id}-${active}` : undefined}
          onChange={(event) => { setQuery(event.target.value); setActive(0) }}
          className="mb-1.5 block w-full rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] px-2 py-1.5 text-[13px] text-[var(--color-text)] focus:border-[var(--color-accent)] focus:outline-none" />
        <div ref={list} id={`${id}-list`} role="listbox" aria-label="Timezones" className="max-h-64 overflow-y-auto">
          {filtered.length === 0 && <p className="px-2 py-1.5 text-[13px] text-[var(--color-text-muted)]">No matching timezones</p>}
          {filtered.map((row, index) => {
            const selected = row.zone === value
            return <div key={row.zone} id={`${id}-${index}`} data-index={index} role="option" aria-selected={selected}
              onMouseDown={(event) => event.preventDefault()} onMouseEnter={() => setActive(index)} onClick={() => pick(row.zone)}
              className={`flex cursor-pointer items-center gap-2 rounded px-2 py-1 text-[13px] text-[var(--color-text)] ${index === active ? 'bg-[var(--color-bg-hover)]' : ''}`}>
              <span className="w-3.5 shrink-0 text-[var(--color-accent)]">{selected && <Check size={14} />}</span>
              <span className="min-w-0 flex-1 truncate">{displayName(row.zone)}</span>
              <span className="shrink-0 text-[12px] tabular-nums text-[var(--color-text-muted)]">{row.offset}</span>
            </div>
          })}
        </div>
      </div>,
      popover.triggerRef.current?.closest('dialog') ?? document.body
    )}
  </>
}
