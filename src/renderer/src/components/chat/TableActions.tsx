import { useCallback, useRef, useState, type MouseEvent, type SyntheticEvent } from 'react'
import { Download, MoreHorizontal, Table2 } from 'lucide-react'
import { CONTEXT_MENU_ITEM, ContextMenu } from '../ui/ContextMenu'
import { useTablePreviewStore } from '../../stores/tablePreview.store'
import { downloadCsv } from '../../utils/textTable'

const stop = (event: SyntheticEvent): void => event.stopPropagation()

/**
 * The "⋯" on a table in a chat message (a markdown table's header row, or a
 * code block that reads as a table): Open as table, Download CSV. Hidden
 * until its host is hovered or holds focus, and while its menu is open
 * (main.css, `.table-actions-trigger`); its place is always reserved, so
 * showing it moves nothing. `rows` is read when an item is picked, so a
 * table still streaming gives what is on screen then.
 */
export function TableActions({
  rows,
  className
}: {
  rows: () => string[][] | null
  /** Where it sits in its host, and its colours (each host draws it on a different surface). */
  className: string
}): React.JSX.Element {
  const buttonRef = useRef<HTMLButtonElement>(null)
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null)
  const close = useCallback(() => setMenu(null), [])
  // A press on the button while its menu is open closes the menu (its
  // outside-press listener) before the click arrives: that click must not
  // open it again.
  const pressedOpen = useRef(false)

  const toggle = (event: MouseEvent<HTMLButtonElement>): void => {
    event.stopPropagation()
    const wasOpen = pressedOpen.current
    pressedOpen.current = false
    if (menu || wasOpen) return setMenu(null)
    const rect = event.currentTarget.getBoundingClientRect()
    setMenu({ x: rect.right, y: rect.bottom + 4 })
  }

  const pick = (action: (table: string[][]) => void) => (event: MouseEvent): void => {
    event.stopPropagation()
    const table = rows()
    setMenu(null)
    if (table) action(table)
  }

  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        aria-label="Table actions"
        title="Table actions"
        aria-haspopup="menu"
        aria-expanded={menu !== null}
        onClick={toggle}
        // Not stopped: another open menu (another ⋯, the message menu) closes on this press.
        onPointerDown={() => {
          pressedOpen.current = menu !== null
        }}
        onContextMenu={stop}
        onKeyDown={(event) => {
          // Enter and Space are this button's; Escape and the rest go on as usual.
          if (event.key === 'Enter' || event.key === ' ') event.stopPropagation()
        }}
        className={
          'table-actions-trigger inline-flex size-5 items-center justify-center rounded-md ' +
          'focus-visible:outline-2 focus-visible:outline-[var(--color-accent)] ' +
          className
        }
      >
        <MoreHorizontal size={14} aria-hidden="true" />
      </button>
      {menu && (
        // Portaled, but React events still bubble through the bubble's tree:
        // a pick or a right-click inside the menu is not one on the message.
        <span className="contents" onClick={stop} onContextMenu={stop}>
          <ContextMenu x={menu.x} y={menu.y} anchor={buttonRef.current} label="Table actions" align="right" onClose={close}>
            <button
              type="button"
              role="menuitem"
              className={CONTEXT_MENU_ITEM}
              onClick={pick((table) => useTablePreviewStore.getState().open(table, buttonRef.current))}
            >
              <Table2 size={12} aria-hidden="true" />
              Open as table
            </button>
            <button type="button" role="menuitem" className={CONTEXT_MENU_ITEM} onClick={pick((table) => {
                downloadCsv(table)
                buttonRef.current?.focus({ preventScroll: true })
              })}>
              <Download size={12} aria-hidden="true" />
              Download CSV
            </button>
          </ContextMenu>
        </span>
      )}
    </>
  )
}

/** A rendered table's rows as the user sees them: every header and body row's cell text, trimmed. */
export function tableRowsFromDom(table: HTMLTableElement | null): string[][] | null {
  if (!table) return null
  const sections = [table.tHead, ...Array.from(table.tBodies)].filter((s): s is HTMLTableSectionElement => s !== null)
  const rows = sections.flatMap((section) => Array.from(section.rows, (row) => Array.from(row.cells, (cell) => (cell.textContent ?? '').trim())))
  return rows.length > 0 ? rows : null
}
