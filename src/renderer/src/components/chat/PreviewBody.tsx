import { ArrowDown, ArrowUp, ArrowUpDown } from 'lucide-react'
import { useMemo, useState, type RefObject } from 'react'
import Markdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import rehypeHighlight from 'rehype-highlight'
import type { ParsedXml } from '../../utils/xmlDocument'
import { previewMarkdownComponents } from './FilePreviewContents'
import { JsonTree, JsonTreeBoundary, useParsedJson } from './JsonTree'
import { CodePreview, MAX_HIGHLIGHT_CHARS, PreviewNote, plainTextNote } from './CodePreview'
import { XmlTree, type XmlReveal } from './XmlTree'
import { MAX_PREVIEW_BYTES, type PreviewRenderKind } from '../../../../shared/filePreview'

/**
 * How a previewed file's text is shown, by its kind: markdown rendered, JSON
 * and XML as trees, CSV as a table, Python and the rest as code or text. Shared
 * by the file preview and the artifact preview; each owns the frame around it
 * (the header, the Contents panel, an HTML page or an image).
 */

const MAX_PREVIEW_MB = MAX_PREVIEW_BYTES / (1024 * 1024)

export function PreviewBody({
  kind,
  text,
  filtersEnabled,
  anchorLines
}: {
  kind: PreviewRenderKind
  text: string
  filtersEnabled: boolean
  anchorLines?: readonly number[]
}): React.JSX.Element {
  if (kind === 'json') {
    return <JsonPreview text={text} />
  }

  if (kind === 'csv') {
    return <CsvPreview text={text} filtersEnabled={filtersEnabled} />
  }

  if (kind === 'python') {
    return <CodePreview text={text} language="python" anchorLines={anchorLines} />
  }

  // Only a composer file not sent yet gets here as `html`: no frame serves it.
  if (kind === 'html') {
    return <CodePreview text={text} language="xml" />
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

/**
 * Split by the modal (see `useFrontmatter` there), which also reads the
 * headings. Over {@link MAX_HIGHLIGHT_CHARS} the body is shown as written:
 * rendering a multi-MB document hung the window.
 */
export function MarkdownPreview({ card, body }: { card: React.JSX.Element | null; body: string }): React.JSX.Element {
  if (body.length > MAX_HIGHLIGHT_CHARS) {
    return (
      <>
        {card}
        <PreviewNote>{plainTextNote('format')}</PreviewNote>
        <pre
          className="text-xs font-mono whitespace-pre-wrap break-words
            text-[var(--color-text)]"
        >
          {body}
        </pre>
      </>
    )
  }
  return (
    <>
      {card}
      <div className="file-preview-markdown markdown-body text-sm text-[var(--color-text)] leading-relaxed">
        <Markdown
          remarkPlugins={[remarkGfm]}
          rehypePlugins={[rehypeHighlight]}
          components={previewMarkdownComponents}
        >
          {body}
        </Markdown>
      </div>
    </>
  )
}

export function JsonPreview({ text }: { text: string }): React.JSX.Element {
  // A tree when it parses; the raw text otherwise, so a malformed or
  // truncated file still shows something instead of erroring.
  const parsed = useParsedJson(text)
  const raw = (
    <pre
      className="text-xs font-mono whitespace-pre-wrap break-words
        text-[var(--color-text)]"
    >
      {text}
    </pre>
  )
  if (!parsed) return raw
  return (
    <JsonTreeBoundary key={text} fallback={raw}>
      <JsonTree value={parsed.value} />
    </JsonTreeBoundary>
  )
}

/**
 * Parsed by the modal, which also builds the outline from it. A tree when the
 * text is well-formed; the highlighted source otherwise (malformed, or cut by
 * the preview cap), under a note saying why.
 */
export function XmlPreview({
  text,
  parsed,
  truncated,
  revealRef
}: {
  text: string
  parsed: ParsedXml | null
  /** Cut at the preview cap: a valid file that no longer parses is not a broken one. */
  truncated: boolean
  revealRef: RefObject<XmlReveal | null>
}): React.JSX.Element {
  const source = <CodePreview text={text} language="xml" />
  if (!parsed) {
    // Passed in, so a source too large to highlight still shows one note.
    const note = truncated
      ? `The preview is cut at ${MAX_PREVIEW_MB} MB, so it is shown as source.`
      : 'This XML could not be parsed, so it is shown as source.'
    return <CodePreview text={text} language="xml" note={note} />
  }
  return (
    <JsonTreeBoundary key={text} fallback={source}>
      <XmlTree doc={parsed} revealRef={revealRef} />
    </JsonTreeBoundary>
  )
}

/**
 * Parse delimited text into rows, honoring double-quoted fields that may
 * contain the delimiter, embedded newlines, and `""` escaped quotes
 * (RFC-4180-ish). A single pass over the whole text — not line-by-line — so a
 * quoted cell spanning multiple physical lines stays one cell instead of
 * splitting into bogus rows. Returns one array of cells per non-blank
 * record, and stops once it has more than `maxRows`.
 */
function parseDelimited(text: string, delimiter: string, maxRows = Infinity): string[][] {
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
      // A blank physical line parses to a single empty cell: not a row.
      if (!(row.length === 1 && row[0] === '')) rows.push(row)
      row = []
      field = ''
      if (rows.length > maxRows) return rows
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

export function CsvPreview({
  text,
  filtersEnabled
}: {
  text: string
  filtersEnabled: boolean
}): React.JSX.Element {
  const { rows, clipped } = useMemo(() => {
    const delimiter = text.includes('\t') && !text.includes(',') ? '\t' : ','
    // One past the cap is enough to know the table is clipped; a 25 MB file
    // is not split into millions of cells to show 500 rows.
    const all = parseDelimited(text, delimiter, MAX_PREVIEW_ROWS)
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
      <table className="file-preview-table text-xs border-collapse w-full">
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
