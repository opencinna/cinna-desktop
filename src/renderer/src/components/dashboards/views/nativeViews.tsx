import { useMemo } from 'react'
import { CsvPreview, DataTable, MarkdownPreview, type DataTableRowSelection } from '../../chat/PreviewBody'
import { selectionKeyOf } from '../dashboardContext'
import type { Components, ExtraProps } from 'react-markdown'
import { previewMarkdownComponents } from '../../chat/FilePreviewContents'

/**
 * The four native views (README §5.2): the agent produces data in a shape the
 * kit defines, and the tile draws it in the app's own design. Data that does
 * not fit the shape says so in the tile; nothing here throws.
 *
 * Links are drawn only from the data's own `url` fields and open in the
 * browser on a click the host draws (D17), so no confirm is needed.
 */

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function text(value: unknown): string {
  if (value === null || value === undefined) return ''
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  return JSON.stringify(value)
}

function webUrl(value: unknown): string | null {
  if (typeof value !== 'string') return null
  try {
    const url = new URL(value)
    // The schema allows `^(https?://|mailto:)` for a list item's url.
    return url.protocol === 'http:' || url.protocol === 'https:' || url.protocol === 'mailto:' ? url.href : null
  } catch {
    return null
  }
}

function openLink(url: string): void {
  void window.api.system.openExternal(url).catch(() => {})
}

/**
 * Rows or items the user picked on a tile (README D3): keys are a list item's
 * `id`, a table row's `id` field, else the index as a string. A click picks
 * one, ⌘/Ctrl-click adds or removes; the tile clears it on Escape.
 */
export interface ViewSelection {
  selected: string[]
  onPick: (key: string, additive: boolean) => void
}

function rowSelectionFor(selection: ViewSelection | undefined, keyAt: (index: number) => string): DataTableRowSelection | undefined {
  if (!selection) return undefined
  const chosen = new Set(selection.selected)
  return {
    isSelected: (index) => chosen.has(keyAt(index)),
    onRowClick: (index, additive) => selection.onPick(keyAt(index), additive)
  }
}

export function ShapeMismatch({ view }: { view: string }): React.JSX.Element {
  return (
    <p className="px-3 py-2 text-[11px] text-[var(--color-text-muted)]">
      This data does not have the shape of a {view} view.
    </p>
  )
}

type HeadingTag = 'h1' | 'h2' | 'h3' | 'h4' | 'h5' | 'h6'
function headingAs(Tag: HeadingTag) {
  return function Heading({ node: _node, ...props }: React.JSX.IntrinsicElements[HeadingTag] & ExtraProps) {
    return <Tag {...props} />
  }
}

/**
 * A tile's markdown, two heading levels down: a tile is a part of the
 * dashboard page, whose own title is its only `<h1>`.
 */
export const tileMarkdownComponents: Components = {
  ...previewMarkdownComponents,
  h1: headingAs('h3'),
  h2: headingAs('h4'),
  h3: headingAs('h5'),
  h4: headingAs('h6'),
  h5: headingAs('h6'),
  h6: headingAs('h6')
}

export function MarkdownView({ data }: { data: unknown }): React.JSX.Element {
  const body = typeof data === 'string' ? data : isRecord(data) && typeof data.markdown === 'string' ? data.markdown : null
  if (body === null) return <ShapeMismatch view="markdown" />
  return (
    <div className="dashboard-markdown px-3 py-2 text-[12px]">
      <MarkdownPreview card={null} body={body} components={tileMarkdownComponents} />
    </div>
  )
}

const NUMBER = new Intl.NumberFormat(undefined, { maximumFractionDigits: 2 })

/** A table cell as text, by its column type. */
export function formatCell(value: unknown, type: unknown): string {
  if (value === null || value === undefined || value === '') return ''
  const n = typeof value === 'number' ? value : typeof value === 'string' && value.trim() !== '' ? Number(value) : NaN
  switch (type) {
    case 'number':
      return Number.isFinite(n) ? NUMBER.format(n) : text(value)
    case 'money':
      return Number.isFinite(n) ? NUMBER.format(Math.round(n * 100) / 100) : text(value)
    case 'percent':
      return Number.isFinite(n) ? `${NUMBER.format(Math.abs(n) <= 1 && typeof value === 'number' ? n * 100 : n)}%` : text(value)
    case 'date': {
      const d = new Date(text(value))
      return Number.isNaN(d.getTime()) ? text(value) : d.toLocaleDateString()
    }
    default:
      return text(value)
  }
}

export function TableView({ data, selection }: { data: unknown; selection?: ViewSelection }): React.JSX.Element {
  const table = useMemo(() => {
    if (!isRecord(data) || !Array.isArray(data.columns) || !Array.isArray(data.rows)) return null
    const columns = data.columns.filter(isRecord).filter((c) => typeof c.key === 'string')
    const header = columns.map((c) => text(c.label ?? c.key))
    const rows = data.rows.filter(isRecord)
    const body = rows.map((row) => columns.map((c) => formatCell(row[c.key as string], c.type)))
    return { header, body, keys: rows.map((row, index) => selectionKeyOf(row, index)) }
  }, [data])
  if (isRecord(data) && typeof data.csv === 'string') {
    return (
      <div className="px-2 py-2">
        <CsvPreview text={data.csv} filtersEnabled={false} rowSelection={rowSelectionFor(selection, String)} />
      </div>
    )
  }
  if (!table) return <ShapeMismatch view="table" />
  return (
    <div className="px-2 py-2">
      <DataTable
        header={table.header}
        body={table.body}
        filtersEnabled={false}
        notes={[]}
        rowSelection={rowSelectionFor(selection, (index) => table.keys[index] ?? String(index))}
      />
    </div>
  )
}

const PRIORITY_COLOR: Record<string, string> = {
  high: 'bg-[var(--color-danger)]',
  medium: 'bg-[var(--color-warning)]',
  low: 'bg-[var(--color-text-muted)]'
}

export function ListView({ data, selection }: { data: unknown; selection?: ViewSelection }): React.JSX.Element {
  if (!isRecord(data) || !Array.isArray(data.items)) return <ShapeMismatch view="list" />
  const items = data.items.filter(isRecord)
  const chosen = new Set(selection?.selected ?? [])
  if (items.length === 0) return <p className="px-3 py-2 text-[11px] text-[var(--color-text-muted)]">Nothing here right now.</p>
  return (
    <ul className="divide-y divide-[var(--color-border)]">
      {items.map((item, index) => {
        const url = webUrl(item.url)
        const priority = typeof item.priority === 'string' ? PRIORITY_COLOR[item.priority] : undefined
        const title = text(item.title)
        const key = selectionKeyOf(item, index)
        const picked = chosen.has(key)
        return (
          <li
            key={text(item.id) || index}
            aria-selected={selection ? picked : undefined}
            onClick={selection ? (event) => selection.onPick(key, event.metaKey || event.ctrlKey) : undefined}
            className={`flex items-start gap-2 px-3 py-1.5 ${selection ? `cursor-pointer ${picked ? 'bg-[var(--color-accent)]/10' : 'hover:bg-[var(--color-bg-hover)]'}` : ''}`}
          >
            {priority && <span aria-label={`${text(item.priority)} priority`} className={`mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full ${priority}`} />}
            <div className="min-w-0 flex-1">
              <div className="flex items-baseline gap-1.5">
                {url ? (
                  <button
                    type="button"
                    onClick={() => openLink(url)}
                    title={url}
                    className="min-w-0 truncate text-left text-xs font-medium text-[var(--color-accent)] hover:text-[var(--color-accent-hover)]"
                  >
                    {title}
                  </button>
                ) : (
                  <span className="min-w-0 truncate text-xs font-medium text-[var(--color-text)]">{title}</span>
                )}
                {item.badge !== undefined && (
                  <span className="shrink-0 rounded bg-[var(--color-bg-tertiary)] px-1 text-[9px] text-[var(--color-text-secondary)]">{text(item.badge)}</span>
                )}
                {item.time !== undefined && <span className="ml-auto shrink-0 text-[10px] text-[var(--color-text-muted)]">{text(item.time)}</span>}
              </div>
              {(item.subtitle !== undefined || item.meta !== undefined) && (
                <div className="truncate text-[10px] text-[var(--color-text-muted)]">
                  {[item.subtitle, item.meta].filter((v) => v !== undefined && v !== '').map(text).join(' · ')}
                </div>
              )}
            </div>
          </li>
        )
      })}
    </ul>
  )
}

const STATUS_COLOR: Record<string, string> = {
  ok: 'text-[var(--color-success)]',
  warning: 'text-[var(--color-warning)]',
  error: 'text-[var(--color-danger)]'
}

function Sparkline({ values }: { values: number[] }): React.JSX.Element | null {
  if (values.length < 2) return null
  const min = Math.min(...values)
  const max = Math.max(...values)
  const span = max - min || 1
  const points = values.map((v, i) => `${(i / (values.length - 1)) * 100},${28 - ((v - min) / span) * 26}`).join(' ')
  return (
    <svg viewBox="0 0 100 30" preserveAspectRatio="none" className="h-5 w-full text-[var(--color-accent)]" aria-hidden="true">
      <polyline points={points} fill="none" stroke="currentColor" strokeWidth="2" vectorEffect="non-scaling-stroke" />
    </svg>
  )
}

export function MetricsView({ data }: { data: unknown }): React.JSX.Element {
  if (!isRecord(data) || !Array.isArray(data.items)) return <ShapeMismatch view="metrics" />
  const items = data.items.filter(isRecord)
  return (
    <div className="grid h-full grid-cols-[repeat(auto-fit,minmax(7rem,1fr))] gap-2 p-3">
      {items.map((item, index) => {
        const delta = typeof item.delta === 'number' ? item.delta : null
        const good = delta === null || delta === 0 ? null : (delta > 0) === (item.delta_good !== 'down')
        const trend = Array.isArray(item.trend) ? item.trend.filter((v): v is number => typeof v === 'number' && Number.isFinite(v)) : []
        return (
          <div key={text(item.id) || index} className="min-w-0 rounded-md bg-[var(--color-bg-secondary)] px-2.5 py-2">
            <div className="truncate text-[10px] text-[var(--color-text-muted)]">{text(item.label)}</div>
            <div className={`truncate text-lg font-semibold ${typeof item.status === 'string' ? (STATUS_COLOR[item.status] ?? 'text-[var(--color-text)]') : 'text-[var(--color-text)]'}`}>
              {formatCell(item.value, 'number')}
              {item.unit !== undefined && <span className="ml-1 text-[11px] font-normal text-[var(--color-text-muted)]">{text(item.unit)}</span>}
            </div>
            {delta !== null && (
              <div className={`text-[10px] ${good === null ? 'text-[var(--color-text-muted)]' : good ? 'text-[var(--color-success)]' : 'text-[var(--color-danger)]'}`}>
                {delta > 0 ? '+' : ''}{NUMBER.format(delta)}
              </div>
            )}
            <Sparkline values={trend} />
          </div>
        )
      })}
    </div>
  )
}
