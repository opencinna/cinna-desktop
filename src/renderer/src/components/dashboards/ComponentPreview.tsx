import { useRef, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { TILE_SIZE_SPANS, resolveParamWords, type ComponentInfo, type TileSize } from '../../../../shared/dashboards'
import { DashboardsRefusal, refusalCode } from '../../hooks/useDashboards'
import { DashboardDialog } from './DashboardDialog'
import { CloudRefusal, useCinnaServerName } from './componentParts'
import { TileBody } from './TileBody'

const GAP = 6
/** A grid row is about this many columns' width tall on a dashboard of usual width. */
const ROW_TO_COL = 1.5

/**
 * A component drawn at a tile size, from one run of its source. Running it is
 * what the user asked for by opening the preview (D8: nothing runs from text
 * or from a listing); the result is never cached.
 */
export function ComponentPreview({
  component,
  size,
  box
}: {
  component: ComponentInfo
  size: TileSize
  /** The area the preview lives in: every size fits it, at one scale, so changing size moves nothing around it. */
  box: { width: number; height: number }
}): React.JSX.Element {
  // A page's setParams in a preview: kept here, never stored, and the source re-runs with them.
  const [pageParams, setPageParams] = useState<Record<string, unknown>>({})
  const preview = useQuery({
    queryKey: ['dashboards', 'preview', component.agentId, component.skill, component.name, pageParams],
    // The last good data stays on screen while the source re-runs with the page's params.
    placeholderData: (previous) => previous,
    queryFn: async () => {
      const outcome = await window.api.dashboards.preview(component.agentId, component.name, component.skill, pageParams)
      if (!outcome.ok) throw new DashboardsRefusal(outcome.code, outcome.message)
      return outcome.result
    },
    retry: false,
    staleTime: Infinity,
    gcTime: 0
  })
  const server = useCinnaServerName()
  const span = TILE_SIZE_SPANS[size]
  // One scale for every size: the widest preset fills the width, the tallest the height.
  const col = Math.min((box.width - 11 * GAP) / 12, (box.height - 3 * GAP) / (4 * ROW_TO_COL))
  const width = span.cols * col + (span.cols - 1) * GAP
  const height = span.rows * col * ROW_TO_COL + (span.rows - 1) * GAP
  return (
    <div
      data-testid="component-preview"
      aria-label={`Preview of ${component.title}`}
      className="relative max-w-full overflow-hidden rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)]"
      style={{ width, height }}
    >
      {preview.isError ? (
        component.cloud ? (
          // A cloud agent's refusal (D6.10): our sentence, and Retry where the server did not answer.
          <div className="px-3 py-2">
            <CloudRefusal
              code={refusalCode(preview.error)}
              message={preview.error.message}
              names={{ agent: component.agentName, server: component.cloud.server || server }}
              onRetry={() => void preview.refetch()}
              retrying={preview.isFetching}
            />
          </div>
        ) : (
          <p className="px-3 py-2 text-[11px] text-[var(--color-danger)]">{preview.error.message}</p>
        )
      ) : component.view ? (
        <div className="absolute inset-0 overflow-auto">
          <TileBody
            view={component.view}
            result={preview.data ?? null}
            loading={preview.isPending}
            frameTarget={{ agentId: component.agentId, component: component.name, skill: component.skill }}
            meta={{ component: component.name, title: component.title, params: resolveParamWords(pageParams, component.params), size }}
            actions={{ onParams: (changed) => setPageParams((current) => ({ ...current, ...changed })) }}
            cloudNames={component.cloud ? { agent: component.agentName, server: component.cloud.server || server } : undefined}
            reopenKey={component.cloud ? preview.dataUpdatedAt : undefined}
          />
        </div>
      ) : null}
    </div>
  )
}

/** Preview in a dialog: the agent tab's and the chat card's (one object, one look). */
export function ComponentPreviewDialog({ component, onClose }: { component: ComponentInfo; onClose: () => void }): React.JSX.Element {
  const closeRef = useRef<HTMLButtonElement>(null)
  return (
    <DashboardDialog label={`Preview of ${component.title}`} onClose={onClose} initialFocusRef={closeRef} width="max-w-[38rem]">
      <div className="flex items-center gap-2">
        <h2 className="min-w-0 flex-1 truncate text-sm font-semibold text-[var(--color-text)]">{component.title}</h2>
        <button ref={closeRef} type="button" onClick={onClose} className="px-2 py-1 text-xs font-medium text-[var(--color-text-muted)] hover:text-[var(--color-text-secondary)]">
          Close
        </button>
      </div>
      <div className="mt-3 flex items-center justify-center rounded-lg bg-[var(--color-bg-secondary)] p-2" style={{ height: 316 }}>
        <ComponentPreview component={component} size={component.size} box={{ width: 560, height: 300 }} />
      </div>
    </DashboardDialog>
  )
}
