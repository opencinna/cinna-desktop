import { Check, Hash, X } from 'lucide-react'
import { useEffect } from 'react'
import { createPortal } from 'react-dom'
import { usePopover } from '../ui/usePopover'
import type { TagChip } from '../../utils/noteFormat/noteIndex'

const HEADER_BUTTON = 'p-1 rounded hover:bg-[var(--color-bg-hover)] transition-colors'
// One colour class per state: stacked, the muted one won and an active filter
// looked like none.
const HEADER_IDLE = 'text-[var(--color-text-muted)] hover:text-[var(--color-text)]'
const HEADER_ACTIVE = 'text-[var(--color-accent)]'
const ROW =
  'flex w-full items-center gap-1.5 rounded-md px-2 py-1 text-left text-xs text-[var(--color-text)] transition-colors hover:bg-[var(--color-bg-hover)]'

/**
 * The Notes header's tag filter: a `#` button opening a menu of every tag in
 * the regular notes (parents of nested tags included, each with its note
 * count), "All notes" first. Picking one sets `active`; the menu closes.
 */
export function NoteTagFilterButton({
  chips,
  active,
  onPick
}: {
  chips: TagChip[]
  active: string | null
  onPick: (key: string | null) => void
}): React.JSX.Element {
  const menu = usePopover<HTMLButtonElement>('below-right', { flipWhenNoRoom: true })
  const { open, setOpen } = menu

  // Escape closes; the arrows, Home and End move between the items, as in
  // the app's other menus.
  useEffect(() => {
    if (!open) return
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        event.stopPropagation()
        setOpen(false)
        menu.triggerRef.current?.focus()
        return
      }
      if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return
      const items = [...(menu.popoverRef.current?.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]') ?? [])]
      if (items.length === 0) return
      event.preventDefault()
      const at = items.indexOf(document.activeElement as HTMLButtonElement)
      const next =
        event.key === 'Home'
          ? 0
          : event.key === 'End'
            ? items.length - 1
            : event.key === 'ArrowDown'
              ? (at + 1) % items.length
              : (at - 1 + items.length) % items.length
      items[next].focus({ preventScroll: true })
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [open, setOpen, menu.triggerRef, menu.popoverRef])

  const pick = (key: string | null): void => {
    onPick(key)
    setOpen(false)
  }

  return (
    <>
      <button
        ref={menu.triggerRef}
        type="button"
        onClick={() => setOpen(!open)}
        aria-haspopup="menu"
        aria-expanded={open}
        className={`${HEADER_BUTTON} ${active ? HEADER_ACTIVE : HEADER_IDLE}`}
        title="Filter by tag"
        aria-label="Filter by tag"
      >
        <Hash size={14} />
      </button>
      {open &&
        menu.style &&
        createPortal(
          <div
            ref={menu.popoverRef}
            role="menu"
            aria-label="Tags"
            style={menu.style}
            className="app-popover-surface z-[60] max-h-72 w-[9.5rem] overflow-y-auto rounded-lg border border-[var(--color-border)] p-1 shadow-xl"
          >
            <button type="button" role="menuitemradio" aria-checked={active === null} onClick={() => pick(null)} className={ROW}>
              <CheckSlot on={active === null} />
              <span className="min-w-0 flex-1 truncate">All notes</span>
            </button>
            {chips.map((chip) => {
              const depth = chip.key.split('/').length - 1
              // Under its parent a nested tag shows its own segment; the full
              // path is the row's title.
              const label = depth > 0 ? chip.display.split('/').pop() : `#${chip.display}`
              return (
                <button
                  key={chip.key}
                  type="button"
                  role="menuitemradio"
                  aria-checked={active === chip.key}
                  onClick={() => pick(chip.key)}
                  title={`#${chip.display}`}
                  className={ROW}
                >
                  <CheckSlot on={active === chip.key} />
                  <span className="min-w-0 flex-1 truncate" style={depth ? { paddingLeft: `${depth * 0.75}rem` } : undefined}>
                    {label}
                  </span>
                  <span className="shrink-0 text-[10px] tabular-nums text-[var(--color-text-muted)]">{chip.count}</span>
                </button>
              )
            })}
          </div>,
          document.body
        )}
    </>
  )
}

function CheckSlot({ on }: { on: boolean }): React.JSX.Element {
  return (
    <span className="inline-flex w-3 shrink-0 justify-center" aria-hidden="true">
      {on ? <Check size={12} className="text-[var(--color-accent)]" /> : null}
    </span>
  )
}

/** The active tag filter, under the Notes header: `#tag` with a clear button. */
export function NoteTagFilterRow({ display, onClear }: { display: string; onClear: () => void }): React.JSX.Element {
  return (
    <div className="flex items-center px-3 pb-1">
      <span
        className="inline-flex min-w-0 items-center gap-0.5 rounded-full pl-2 pr-0.5 py-px text-xs
          text-[var(--color-accent)] bg-[color-mix(in_srgb,var(--color-accent)_12%,transparent)]"
      >
        <span className="truncate">#{display}</span>
        <button
          type="button"
          onClick={onClear}
          className="shrink-0 rounded-full p-0.5 hover:bg-[color-mix(in_srgb,var(--color-accent)_20%,transparent)] transition-colors"
          title="Clear tag filter"
          aria-label="Clear tag filter"
        >
          <X size={11} />
        </button>
      </span>
    </div>
  )
}
