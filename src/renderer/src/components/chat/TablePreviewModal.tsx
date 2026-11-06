import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Download, Filter, Table2, X } from 'lucide-react'
import { useTablePreviewStore } from '../../stores/tablePreview.store'
import { downloadCsv } from '../../utils/textTable'
import { DataTable } from './PreviewBody'
import { MODAL_HEADER_ICON } from '../ui/modalHeader'

const ICON_BUTTON =
  MODAL_HEADER_ICON + ' text-[var(--color-text-muted)] hover:bg-[var(--color-bg-hover)] hover:text-[var(--color-text)]'

const plural = (n: number, one: string): string => `${n} ${n === 1 ? one : `${one}s`}`

/**
 * A table out of a chat message, opened from its "Table actions" menu
 * (`TableActions`): the rows in the File Preview's `DataTable`, with its
 * Filter toggle, a Download CSV and Close. Driven by
 * {@link useTablePreviewStore}; mounted once at the app root, beside
 * `FilePreviewModal`. Escape and a press outside the card close it.
 */
export function TablePreviewModal(): React.JSX.Element | null {
  const rows = useTablePreviewStore((s) => s.rows)
  const openSeq = useTablePreviewStore((s) => s.openSeq)
  const close = useTablePreviewStore((s) => s.close)
  const cardRef = useRef<HTMLDivElement>(null)
  // Every table opens without filters.
  const [filtersFor, setFiltersFor] = useState<number | null>(null)
  const filtersEnabled = filtersFor === openSeq
  const body = useMemo(() => rows?.slice(1) ?? [], [rows])
  const open = rows !== null

  useLayoutEffect(() => {
    if (open) cardRef.current?.focus({ preventScroll: true })
  }, [open, openSeq])

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') close()
    }
    const onMouse = (e: MouseEvent): void => {
      if (!cardRef.current || cardRef.current.contains(e.target as Node)) return
      // Focus goes back to the button that opened it, not to the page under the scrim.
      e.preventDefault()
      close()
    }
    window.addEventListener('keydown', onKey)
    window.addEventListener('mousedown', onMouse, true)
    return () => {
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('mousedown', onMouse, true)
    }
  }, [open, close])

  if (!rows) return null
  const header = rows[0] ?? []

  return createPortal(
    <div className="table-preview-modal fixed inset-0 z-50 flex items-start justify-center px-4 pt-[10vh]">
      <div aria-hidden className="app-modal-scrim absolute inset-0" />
      <div
        ref={cardRef}
        role="dialog"
        aria-modal="true"
        aria-label="Table"
        tabIndex={-1}
        className="relative w-full max-w-3xl max-h-[80vh] flex flex-col rounded-xl border app-modal-panel focus:outline-none"
      >
        <div className="flex items-center justify-between gap-2 px-5 py-3 border-b border-[var(--color-border)]">
          <div className="flex items-center gap-2 min-w-0">
            <Table2 size={16} className="text-[var(--color-text-muted)] shrink-0" />
            <div className="text-sm font-semibold text-[var(--color-text)] truncate">Table</div>
            <div className="text-xs text-[var(--color-text-muted)] shrink-0">
              {plural(body.length, 'row')} × {plural(header.length, 'column')}
            </div>
          </div>
          <div className="flex items-center gap-1 shrink-0">
            <button
              type="button"
              onClick={() => setFiltersFor(filtersEnabled ? null : openSeq)}
              aria-pressed={filtersEnabled}
              className={
                MODAL_HEADER_ICON + ' ' +
                (filtersEnabled
                  ? 'bg-[var(--color-accent)]/15 text-[var(--color-accent)]'
                  : 'text-[var(--color-text-muted)] hover:bg-[var(--color-bg-hover)] hover:text-[var(--color-text)]')
              }
              title={filtersEnabled ? 'Hide filters & sorting' : 'Filter & sort columns'}
              aria-label="Toggle column filters and sorting"
            >
              <Filter size={14} />
            </button>
            <button
              type="button"
              onClick={() => downloadCsv(rows)}
              className={ICON_BUTTON}
              title="Download CSV"
              aria-label="Download CSV"
            >
              <Download size={14} />
            </button>
            <button type="button" onClick={close} className={ICON_BUTTON} title="Close" aria-label="Close table">
              <X size={14} />
            </button>
          </div>
        </div>
        {/* Scrollable, so Tab reaches it: the accent ring File Preview's body wears, drawn inside. */}
        <div
          tabIndex={0}
          aria-label="Table rows"
          className={
            'px-5 py-4 overflow-auto min-h-0 flex-1 rounded-b-xl focus-visible:outline-2' +
            ' focus-visible:-outline-offset-2 focus-visible:outline-[var(--color-accent)]'
          }
        >
          <DataTable key={openSeq} header={header} body={body} filtersEnabled={filtersEnabled} notes={[]} />
        </div>
      </div>
    </div>,
    document.body
  )
}
