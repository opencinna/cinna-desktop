import type { DashboardFrameTarget, DashboardViewKind, TileResultDto, TileSize } from '../../../../shared/dashboards'
import { ListView, MarkdownView, MetricsView, TableView, type ViewSelection } from './views/nativeViews'
import { WebView } from './views/WebView'

/** "just now", "4 min ago", "3 h ago", "2 d ago". */
export function ageLabel(fetchedAt: number | null, now = Date.now()): string {
  if (fetchedAt === null) return 'never'
  const s = Math.max(0, Math.round((now - fetchedAt) / 1000))
  if (s < 60) return 'just now'
  const m = Math.round(s / 60)
  if (m < 60) return `${m} min ago`
  const h = Math.round(m / 60)
  if (h < 48) return `${h} h ago`
  return `${Math.round(h / 24)} d ago`
}

/** A skeleton at full size: the first load, before any data. */
export function TileSkeleton(): React.JSX.Element {
  return (
    <div aria-label="Loading" className="flex h-full flex-col gap-2 p-3">
      <div className="h-3 w-1/3 animate-pulse rounded bg-[var(--color-bg-tertiary)]" />
      <div className="h-3 w-2/3 animate-pulse rounded bg-[var(--color-bg-tertiary)]" />
      <div className="h-3 w-1/2 animate-pulse rounded bg-[var(--color-bg-tertiary)]" />
    </div>
  )
}

/**
 * What a component draws, from a result: the native view, or the page with
 * the result handed to it. No data yet: the skeleton, or the error sentence.
 */
export function TileBody({
  view,
  result,
  frameTarget,
  meta,
  loading,
  selection,
  onContext
}: {
  view: DashboardViewKind
  result: TileResultDto | null
  frameTarget: DashboardFrameTarget
  meta: { component: string; title: string; params: Record<string, unknown>; size: TileSize }
  loading: boolean
  /** A tile on a dashboard: rows and items can be picked (table and list views). */
  selection?: ViewSelection
  /** A tile on a dashboard: the page's `setContext` (html view). */
  onContext?: (context: { summary: string; selection: string[] }) => void
}): React.JSX.Element {
  const hasData = !!result && result.data !== null
  if (view === 'html') {
    // The page draws its own empty state; the data reaches it when there is some.
    return (
      <div className="relative h-full w-full">
        <WebView
          target={frameTarget}
          meta={meta}
          title={meta.title}
          onContext={onContext}
          data={hasData ? { value: result!.data, fetchedAt: result!.fetchedAt, stale: result!.stale } : null}
        />
        {!hasData && result?.error && !loading && (
          <p className="absolute inset-x-0 bottom-0 bg-[var(--color-bg)] px-3 py-2 text-[11px] text-[var(--color-danger)]">{result.error}</p>
        )}
      </div>
    )
  }
  if (!hasData) {
    if (result?.error && !loading && !result.refreshing) {
      return <p className="px-3 py-2 text-[11px] text-[var(--color-danger)]">{result.error}</p>
    }
    return <TileSkeleton />
  }
  const data = result!.data
  switch (view) {
    case 'markdown':
      return <MarkdownView data={data} />
    case 'table':
      return <TableView data={data} selection={selection} />
    case 'list':
      return <ListView data={data} selection={selection} />
    case 'metrics':
      return <MetricsView data={data} />
  }
}
