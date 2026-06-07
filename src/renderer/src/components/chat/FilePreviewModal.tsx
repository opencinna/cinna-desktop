import {
  ArrowDown,
  ArrowUp,
  ArrowUpDown,
  Download,
  FileText,
  Filter,
  Loader2,
  X
} from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import Markdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import rehypeHighlight from 'rehype-highlight'
import { markdownComponents } from '../../utils/markdownComponents'
import { useFilePreviewStore } from '../../stores/filePreview.store'
import { useFileDownloadStore } from '../../stores/fileDownload.store'
import type { PreviewRenderKind } from '../../../../shared/filePreview'

/**
 * Single global modal that previews a small text attachment (txt / csv / md /
 * json / yaml). Driven by {@link useFilePreviewStore} — a previewable badge
 * click opens it. The header's Download button reuses the standard
 * `files:download` save-as flow so preview never replaces the ability to keep
 * the file. Mounted once at the app root.
 */
export function FilePreviewModal(): React.JSX.Element | null {
  const { attachment, kind, text, isLoading, truncated, error, close } = useFilePreviewStore()
  const download = useFileDownloadStore((s) => s.download)
  const isDownloading = useFileDownloadStore((s) =>
    attachment ? s.downloadingIds.has(attachment.id) : false
  )
  const cardRef = useRef<HTMLDivElement>(null)
  // CSV-only: toggles the per-column filter/sort controls. Reset whenever a
  // different file opens so the controls don't carry over between previews.
  const [filtersEnabled, setFiltersEnabled] = useState(false)
  useEffect(() => {
    setFiltersEnabled(false)
  }, [attachment?.id])

  useEffect(() => {
    if (!attachment) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') close()
    }
    const onMouse = (e: MouseEvent): void => {
      if (cardRef.current && !cardRef.current.contains(e.target as Node)) close()
    }
    window.addEventListener('keydown', onKey)
    window.addEventListener('mousedown', onMouse)
    return () => {
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('mousedown', onMouse)
    }
  }, [attachment, close])

  if (!attachment || !kind) return null

  return createPortal(
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/25 px-4">
      <div
        ref={cardRef}
        className="w-full max-w-3xl max-h-[80vh] flex flex-col rounded-xl border
          border-[var(--color-border)] bg-[var(--color-bg-secondary)] shadow-lg"
      >
        <div
          className="flex items-center justify-between gap-2 px-5 py-3 border-b
            border-[var(--color-border)]"
        >
          <div className="flex items-center gap-2 min-w-0">
            <FileText size={16} className="text-[var(--color-text-muted)] shrink-0" />
            <div className="text-sm font-semibold text-[var(--color-text)] truncate">
              {attachment.filename}
            </div>
          </div>
          <div className="flex items-center gap-1 shrink-0">
            {kind === 'csv' && (
              <button
                type="button"
                onClick={() => setFiltersEnabled((v) => !v)}
                aria-pressed={filtersEnabled}
                className={
                  'p-1 rounded transition-colors ' +
                  (filtersEnabled
                    ? 'bg-[var(--color-accent)]/15 text-[var(--color-accent)]'
                    : 'text-[var(--color-text-muted)] hover:bg-[var(--color-bg-hover)] hover:text-[var(--color-text)]')
                }
                title={filtersEnabled ? 'Hide filters & sorting' : 'Filter & sort columns'}
                aria-label="Toggle column filters and sorting"
              >
                <Filter size={14} />
              </button>
            )}
            <button
              type="button"
              onClick={() => void download(attachment)}
              disabled={isDownloading}
              className="p-1 rounded text-[var(--color-text-muted)]
                hover:bg-[var(--color-bg-hover)] hover:text-[var(--color-text)]
                disabled:opacity-50 transition-colors"
              title={`Download ${attachment.filename}`}
              aria-label={`Download ${attachment.filename}`}
            >
              {isDownloading ? (
                <Loader2 size={14} className="animate-spin" />
              ) : (
                <Download size={14} />
              )}
            </button>
            <button
              type="button"
              onClick={close}
              className="p-1 rounded hover:bg-[var(--color-bg-hover)]
                text-[var(--color-text-muted)] hover:text-[var(--color-text)] transition-colors"
              title="Close"
              aria-label="Close preview"
            >
              <X size={14} />
            </button>
          </div>
        </div>

        <div className="px-5 py-4 overflow-auto flex-1">
          {isLoading ? (
            <div className="flex items-center gap-2 text-xs text-[var(--color-text-muted)]">
              <Loader2 size={12} className="animate-spin" />
              <span>Loading preview…</span>
            </div>
          ) : error ? (
            <div className="text-xs text-[var(--color-danger)]">
              Couldn&apos;t load preview: {error}
            </div>
          ) : (
            <>
              <PreviewBody
                key={attachment.id}
                kind={kind}
                text={text}
                filtersEnabled={filtersEnabled}
              />
              {truncated && (
                <div className="mt-3 text-[10px] italic text-[var(--color-text-muted)]">
                  Preview truncated — download the file to see the full content.
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </div>,
    document.body
  )
}

function PreviewBody({
  kind,
  text,
  filtersEnabled
}: {
  kind: PreviewRenderKind
  text: string
  filtersEnabled: boolean
}): React.JSX.Element {
  if (kind === 'markdown') {
    return (
      <div className="markdown-body text-sm text-[var(--color-text)] leading-relaxed">
        <Markdown
          remarkPlugins={[remarkGfm]}
          rehypePlugins={[rehypeHighlight]}
          components={markdownComponents}
        >
          {text}
        </Markdown>
      </div>
    )
  }

  if (kind === 'json') {
    return <JsonPreview text={text} />
  }

  if (kind === 'csv') {
    return <CsvPreview text={text} filtersEnabled={filtersEnabled} />
  }

  return (
    <pre
      className="text-xs font-mono whitespace-pre-wrap break-words
        text-[var(--color-text)]"
    >
      {text}
    </pre>
  )
}

function JsonPreview({ text }: { text: string }): React.JSX.Element {
  // Pretty-print when it parses; fall back to the raw text otherwise so a
  // malformed file still shows something instead of erroring.
  const pretty = useMemo(() => {
    try {
      return JSON.stringify(JSON.parse(text), null, 2)
    } catch {
      return text
    }
  }, [text])
  return (
    <pre
      className="text-xs font-mono whitespace-pre-wrap break-words
        text-[var(--color-text)]"
    >
      {pretty}
    </pre>
  )
}

/**
 * Parse delimited text into rows, honoring double-quoted fields that may
 * contain the delimiter, embedded newlines, and `""` escaped quotes
 * (RFC-4180-ish). A single pass over the whole text — not line-by-line — so a
 * quoted cell spanning multiple physical lines stays one cell instead of
 * splitting into bogus rows. Returns one array of cells per record.
 */
function parseDelimited(text: string, delimiter: string): string[][] {
  const rows: string[][] = []
  let row: string[] = []
  let field = ''
  let inQuotes = false
  const src = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n')
  for (let i = 0; i < src.length; i++) {
    const ch = src[i]
    if (inQuotes) {
      if (ch === '"') {
        if (src[i + 1] === '"') {
          field += '"'
          i++
        } else {
          inQuotes = false
        }
      } else {
        field += ch
      }
    } else if (ch === '"') {
      inQuotes = true
    } else if (ch === delimiter) {
      row.push(field)
      field = ''
    } else if (ch === '\n') {
      row.push(field)
      rows.push(row)
      row = []
      field = ''
    } else {
      field += ch
    }
  }
  // Flush a trailing partial record. A file ending in a newline already
  // pushed its last row and leaves nothing buffered, so this skips the empty
  // phantom row that would otherwise appear.
  if (field !== '' || row.length > 0) {
    row.push(field)
    rows.push(row)
  }
  return rows
}

/** Cap on rendered rows so a large CSV doesn't lock up layout. */
const MAX_PREVIEW_ROWS = 500

type SortDir = 'asc' | 'desc'

/** Numeric compare when both cells parse as finite numbers, else locale
 *  string compare — so a "count" column sorts 2 < 10, not "10" < "2". */
function compareCells(a: string, b: string): number {
  const na = Number(a)
  const nb = Number(b)
  const bothNumeric = a.trim() !== '' && b.trim() !== '' && !isNaN(na) && !isNaN(nb)
  if (bothNumeric) return na - nb
  return a.localeCompare(b)
}

function CsvPreview({
  text,
  filtersEnabled
}: {
  text: string
  filtersEnabled: boolean
}): React.JSX.Element {
  const { rows, clipped } = useMemo(() => {
    const delimiter = text.includes('\t') && !text.includes(',') ? '\t' : ','
    // Drop fully-blank records (a blank physical line parses to a single
    // empty cell) so they don't show as empty table rows.
    const all = parseDelimited(text, delimiter).filter(
      (r) => !(r.length === 1 && r[0] === '')
    )
    const clipped = all.length > MAX_PREVIEW_ROWS
    return { rows: clipped ? all.slice(0, MAX_PREVIEW_ROWS) : all, clipped }
  }, [text])

  // Column index → substring filter; null sort means original order.
  const [filters, setFilters] = useState<Record<number, string>>({})
  const [sort, setSort] = useState<{ col: number; dir: SortDir } | null>(null)

  const header = rows[0] ?? []
  const body = useMemo(() => rows.slice(1), [rows])

  // Filter then sort, preserving each row's original index for a stable key.
  // Both controls are gated on `filtersEnabled` — disabled = raw order.
  const processed = useMemo(() => {
    let out = body.map((row, originalIndex) => ({ row, originalIndex }))
    if (filtersEnabled) {
      const active = Object.entries(filters).filter(([, v]) => v.trim() !== '')
      if (active.length > 0) {
        out = out.filter(({ row }) =>
          active.every(([col, v]) =>
            (row[Number(col)] ?? '').toLowerCase().includes(v.toLowerCase())
          )
        )
      }
      if (sort) {
        out = [...out].sort((a, b) => {
          const cmp = compareCells(a.row[sort.col] ?? '', b.row[sort.col] ?? '')
          return sort.dir === 'asc' ? cmp : -cmp
        })
      }
    }
    return out
  }, [body, filters, sort, filtersEnabled])

  if (rows.length === 0) {
    return <div className="text-xs italic text-[var(--color-text-muted)]">Empty file.</div>
  }

  // Click a header to cycle no-sort → asc → desc → no-sort for that column.
  const cycleSort = (col: number): void => {
    setSort((prev) => {
      if (!prev || prev.col !== col) return { col, dir: 'asc' }
      if (prev.dir === 'asc') return { col, dir: 'desc' }
      return null
    })
  }

  const sortIconFor = (col: number): React.JSX.Element => {
    if (!sort || sort.col !== col) {
      return <ArrowUpDown size={11} className="shrink-0 opacity-40" />
    }
    return sort.dir === 'asc' ? (
      <ArrowUp size={11} className="shrink-0 text-[var(--color-accent)]" />
    ) : (
      <ArrowDown size={11} className="shrink-0 text-[var(--color-accent)]" />
    )
  }

  return (
    <div className="overflow-x-auto">
      <table className="text-xs border-collapse w-full">
        <thead>
          <tr>
            {header.map((cell, i) => (
              <th
                key={i}
                className="text-left font-semibold px-2 py-1 border
                  border-[var(--color-border)] bg-[var(--color-bg-elevated)]
                  text-[var(--color-text)] whitespace-nowrap"
              >
                {filtersEnabled ? (
                  <button
                    type="button"
                    onClick={() => cycleSort(i)}
                    className="flex items-center gap-1 w-full text-left
                      hover:text-[var(--color-accent)] transition-colors"
                    title="Sort by this column"
                  >
                    <span className="truncate">{cell}</span>
                    {sortIconFor(i)}
                  </button>
                ) : (
                  cell
                )}
              </th>
            ))}
          </tr>
          {filtersEnabled && (
            <tr>
              {header.map((_, i) => (
                <th
                  key={i}
                  className="p-1 border border-[var(--color-border)]
                    bg-[var(--color-bg-elevated)]"
                >
                  <input
                    type="text"
                    value={filters[i] ?? ''}
                    onChange={(e) =>
                      setFilters((prev) => ({ ...prev, [i]: e.target.value }))
                    }
                    placeholder="Filter…"
                    aria-label={`Filter ${header[i] || `column ${i + 1}`}`}
                    className="w-full min-w-[5rem] px-1 py-0.5 text-[10px] rounded
                      border border-[var(--color-border)] bg-[var(--color-bg-secondary)]
                      text-[var(--color-text)] placeholder:text-[var(--color-text-muted)]
                      focus:outline-none focus:border-[var(--color-accent)]"
                  />
                </th>
              ))}
            </tr>
          )}
        </thead>
        <tbody>
          {processed.map(({ row, originalIndex }) => (
            <tr key={originalIndex}>
              {row.map((cell, c) => (
                <td
                  key={c}
                  className="px-2 py-1 border border-[var(--color-border)]
                    text-[var(--color-text-secondary)] align-top"
                >
                  {cell}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      {filtersEnabled && processed.length === 0 && body.length > 0 && (
        <div className="mt-2 text-[10px] italic text-[var(--color-text-muted)]">
          No rows match the current filters.
        </div>
      )}
      {clipped && (
        <div className="mt-2 text-[10px] italic text-[var(--color-text-muted)]">
          Showing first {MAX_PREVIEW_ROWS} rows.
        </div>
      )}
    </div>
  )
}
