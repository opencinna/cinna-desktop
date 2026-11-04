import { useEffect, useRef, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { AlertTriangle, GripVertical, Info, Loader2, MoreHorizontal, RefreshCw } from 'lucide-react'
import { TILE_SIZES, TILE_SIZE_LABELS, resolveParamWords, type ComponentPrompt, type TileScheduleState, type TileSize, type TileView } from '../../../../shared/dashboards'
import { useRemoveTile, useTileResult, useUpdateTile } from '../../hooks/useDashboards'
import { ContextMenu, CONTEXT_MENU_ITEM } from '../ui/ContextMenu'
import { ConfirmDialog } from './DashboardDialog'
import { EditTileDialog } from './EditTileDialog'
import { TileBody, TileSkeleton, ageLabel } from './TileBody'
import { COMPONENT_LINK, MissingCredentials, errorFindings, openAgentTab } from './componentParts'
import { FILTER_ROW_TOP, TileFilters, hasFilterRow } from './TileFilters'
import type { ViewSelection } from './views/nativeViews'

/** What a tile on a dashboard with the chat panel gets (README D3); a tile without it has no Ask. */
export interface TileChat {
  focused: boolean
  /** The rows or items picked here (native views). */
  selected: string[]
  /** Click anywhere on the tile. */
  onFocus: () => void
  onPick: (key: string, additive: boolean) => void
  onClearSelection: () => void
  /** The page's `setContext` (html view). */
  onContext: (context: { summary: string; selection: string[] }) => void
  /** Ask: focus the tile and open the panel. */
  onAsk: () => void
  /** A suggested question: focus, open the panel and send it with the context. */
  onPrompt: (prompt: ComponentPrompt) => void
  /** The page's `cinna.ask`: focus, open the panel and put the text in its composer; never sends (D14). */
  onFill: (text: string) => void
}

/** "14:00" today, "Mon 14:00" this week, "12 Nov 14:00" later. */
export function nextRunLabel(at: number, now = Date.now()): string {
  const when = new Date(at)
  const time = when.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
  const today = new Date(now)
  if (when.toDateString() === today.toDateString()) return time
  if (at - now < 6 * 24 * 3600_000) return `${when.toLocaleDateString(undefined, { weekday: 'short' })} ${time}`
  return `${when.toLocaleDateString(undefined, { day: 'numeric', month: 'short' })} ${time}`
}

/** "Fed by Nightly ranking · next run 02:00": the hover line of a schedule-fed tile. */
export function scheduleLine(schedule: TileScheduleState, now = Date.now()): string {
  return `Fed by ${schedule.name}${schedule.nextRunAt !== null ? ` · next run ${nextRunLabel(schedule.nextRunAt, now)}` : ''}`
}

/** How many suggested questions fit on the hover bar for a tile this wide; the rest are in ⋯. */
export function promptsOnBar(cols: number): number {
  return cols >= 8 ? 2 : cols >= 4 ? 1 : 0
}

const BAR_TEXT_BUTTON =
  'shrink-0 max-w-[10rem] truncate rounded px-1.5 py-0.5 text-[10px] font-medium text-[var(--color-accent)] hover:bg-[var(--color-bg-hover)] hover:text-[var(--color-accent-hover)]'

const MARK = 'pointer-events-auto rounded-full bg-[var(--color-bg)] p-0.5'

/** The bar's strip, reserved at the top of every tile: the bar's height, and where the content starts. */
const BAR_HEIGHT = 'h-7'
const BAR_HEIGHT_TOP = 'top-7'

/**
 * One tile: a fixed-size box whose content never resizes it (ux rule 1). A
 * strip at the top holds the title, and on hover the age, Refresh and ⋯;
 * the content scrolls below it and never sits under it. Every
 * state is drawn inside the tile: the skeleton on first load, a corner
 * spinner while refreshing with data, a mark whose tooltip gives the reason
 * when a refresh failed, the sentence when there is no data, and the sentence
 * plus Remove when the component cannot be drawn at all.
 */
export function Tile({
  view,
  dashboardName,
  span,
  editMode,
  dragging,
  onHandlePointerDown,
  onVisibilityChange,
  chat
}: {
  view: TileView
  dashboardName: string
  span: { cols: number; rows: number }
  editMode: boolean
  dragging: boolean
  onHandlePointerDown: (event: React.PointerEvent, tileId: string) => void
  /** The tile came on screen or left it (scrolled); the view keeps the lease and first loads. */
  onVisibilityChange: (tileId: string, visible: boolean) => void
  /** Focus, selection, Ask and suggested questions (the chat panel, D3). */
  chat?: TileChat
}): React.JSX.Element {
  const { tile, displayTitle, state, component } = view
  // A credential the agent has not attached: nothing runs, the tile says which (README D16).
  const needsCredentials = state === 'ok' && !!component && component.missingCredentials.length > 0
  const ok = state === 'ok' && !!component?.view && !needsCredentials
  const result = useTileResult(tile.id)
  const removeTile = useRemoveTile()
  const updateTile = useUpdateTile()
  const [menu, setMenu] = useState<{ x: number; y: number; anchor: HTMLElement } | null>(null)
  const [confirmRemove, setConfirmRemove] = useState(false)
  const [editing, setEditing] = useState(false)
  const [refreshError, setRefreshError] = useState<string | null>(null)
  /** Bumped when a filter change is refused: the controls go back to the stored values. */
  const [paramsRevision, setParamsRevision] = useState(0)
  /** Why the last filter change was not applied, shown under the filter row. */
  const [filterNotice, setFilterNotice] = useState<string | null>(null)
  const queryClient = useQueryClient()
  /**
   * The params main last stored (`stored`), and the ones last sent (`sent`),
   * which the next change merges over: a change names only what changed, and
   * `tile.params` lags until the tiles query refetches, so two quick picks
   * must not drop the first. Both follow `tile.params` when it changes.
   */
  const [stored, setStored] = useState<Record<string, unknown>>(tile.params)
  const storedRef = useRef(tile.params)
  const sentRef = useRef(tile.params)
  const requestRef = useRef(0)
  const tileParamsKey = JSON.stringify(tile.params)
  const seenParamsKey = useRef(tileParamsKey)
  if (seenParamsKey.current !== tileParamsKey) {
    seenParamsKey.current = tileParamsKey
    storedRef.current = tile.params
    // A change on its way is merged over what it was sent with, not over this.
    if (requestRef.current === 0) sentRef.current = tile.params
  }
  useEffect(() => {
    setStored(storedRef.current)
  }, [tileParamsKey])
  const ref = useRef<HTMLDivElement>(null)

  // Whether the tile is on screen (inside the scrolled grid): the view leases what is shown.
  useEffect(() => {
    if (!ok) return
    const node = ref.current
    if (!node || typeof IntersectionObserver === 'undefined') {
      onVisibilityChange(tile.id, true)
      return () => onVisibilityChange(tile.id, false)
    }
    const observer = new IntersectionObserver((entries) => {
      const entry = entries[entries.length - 1]
      if (entry) onVisibilityChange(tile.id, entry.isIntersecting)
    })
    observer.observe(node)
    return () => {
      observer.disconnect()
      onVisibilityChange(tile.id, false)
    }
  }, [ok, tile.id, onVisibilityChange])

  const refresh = (): void => {
    setRefreshError(null)
    void window.api.dashboards
      .ensureFresh(tile.id, 'manual')
      .then((outcome) => { if (!outcome.ok) setRefreshError(outcome.message) })
      .catch(() => setRefreshError('The tile could not be refreshed.'))
  }

  /**
   * A filter or the page's setParams names what it changed (`undefined`:
   * back to the default); main replaces the whole set, so it goes merged over
   * the params last sent. Main validates, stores and recomputes; the result
   * arrives as a tile change. A refusal puts the controls back to what main
   * stored and says why under the filter row (a page has no row: the mark).
   */
  const setParams = (changed: Record<string, unknown>): void => {
    const next: Record<string, unknown> = { ...sentRef.current }
    for (const [name, value] of Object.entries(changed)) {
      if (value === undefined) delete next[name]
      else next[name] = value
    }
    sentRef.current = next
    const request = ++requestRef.current
    const latest = (): boolean => request === requestRef.current
    setRefreshError(null)
    setFilterNotice(null)
    const refused = (message: string): void => {
      if (!latest()) return
      requestRef.current = 0
      sentRef.current = storedRef.current
      if (filters) setFilterNotice(message)
      else setRefreshError(message)
      setStored(storedRef.current)
      setParamsRevision((n) => n + 1)
    }
    void window.api.dashboards
      .setParams({ tileId: tile.id, params: next })
      .then((outcome) => {
        if (!outcome.ok) {
          refused(outcome.code === 'rate_limited' ? `Not applied: ${outcome.message}` : `Value refused: ${outcome.message}`)
          return
        }
        storedRef.current = outcome.tile?.params ?? next
        void queryClient.invalidateQueries({ queryKey: ['dashboards', 'tiles'] })
        // An earlier answer behind a later change leaves the controls on the later values.
        if (!latest()) return
        requestRef.current = 0
        sentRef.current = storedRef.current
        setStored(storedRef.current)
      })
      .catch(() => refused('Not applied: the filter could not be sent.'))
  }

  const openAgent = (): void => {
    if (component) openAgentTab(component.agentId, 'dashboards')
  }

  const data = result.data ?? null
  const hasData = !!data && data.data !== null
  const agentName = component?.agentName ?? 'its agent'
  const unavailable =
    state === 'agent_missing'
      ? 'The agent behind this tile is not on this computer.'
      : state === 'component_missing'
        ? `${tile.component} is no longer in ${agentName}’s folder.`
        : state === 'invalid'
          ? `${displayTitle} has problems to fix: ${(component && errorFindings(component)[0]?.message) ?? 'its component.json is not valid'}`
          : null
  const mark = refreshError ?? data?.error ?? null
  // Asking needs the agent on this machine: the panel's chat is that agent's.
  const canAsk = !!chat && !!component && state !== 'agent_missing'
  const prompts = canAsk ? component!.prompts : []
  const onBar = prompts.slice(0, promptsOnBar(span.cols))
  const inMenu = prompts.slice(onBar.length)
  const selection: ViewSelection | undefined = chat ? { selected: chat.selected, onPick: chat.onPick } : undefined
  const filters = ok && hasFilterRow(component!.view, component!.params)
  // The schedule that writes what the source reads (D4); one that will not run here is said, never silent.
  const schedule = ok ? (view.schedule ?? null) : null
  const scheduleOff = schedule && (!schedule.exists || !schedule.onThisDevice) ? schedule : null
  const scheduleNotice = scheduleOff && (
    <p data-testid="tile-schedule-notice" className="m-0 text-[11px] text-[var(--color-text-secondary)]">
      {scheduleOff.exists ? (
        <>
          Fed by {scheduleOff.name}, which is off on this device.{' '}
          <button type="button" className={COMPONENT_LINK} onClick={() => openAgentTab(component!.agentId, 'schedules')}>
            Turn on…
          </button>
        </>
      ) : (
        `Fed by ${scheduleOff.name}, which this agent no longer has.`
      )}
    </p>
  )
  const refreshTitle = schedule
    ? `Re-read what ${schedule.name} wrote${schedule.nextRunAt !== null ? ` (next run ${nextRunLabel(schedule.nextRunAt)})` : ''}`
    : 'Refresh'
  const body = ok && (
    <TileBody
      view={component!.view!}
      result={data}
      loading={result.isPending}
      frameTarget={{ tileId: tile.id }}
      meta={{ component: tile.component, title: displayTitle, params: resolveParamWords(tile.params, component!.params), size: tile.size }}
      selection={selection}
      onContext={chat?.onContext}
      actions={{ onParams: setParams, onAsk: canAsk ? (text) => { chat!.onFill(text); return true } : undefined }}
    />
  )

  return (
    <div
      ref={ref}
      role="group"
      aria-label={displayTitle}
      data-tile-id={tile.id}
      data-focused={chat?.focused || undefined}
      // Focusable by click, so Escape reaches it; the ring, not the outline, shows focus.
      tabIndex={chat ? -1 : undefined}
      onPointerDown={chat && !editMode ? () => { if (!chat.focused) chat.onFocus() } : undefined}
      onKeyDown={chat ? (event) => {
        if (event.key === 'Escape' && chat.selected.length > 0) {
          event.stopPropagation()
          chat.onClearSelection()
        }
      } : undefined}
      style={{ gridColumn: `span ${span.cols}`, gridRow: `span ${span.rows}` }}
      // The focus ring is a box-shadow: focusing a tile moves nothing (ux rule 1).
      className={`@container group relative min-h-0 min-w-0 overflow-hidden rounded-lg border bg-[var(--color-bg)] outline-none ${
        dragging ? 'border-[var(--color-accent)] opacity-60' : 'border-[var(--color-border)]'
      } ${chat?.focused ? 'ring-2 ring-[var(--color-accent)]' : ''}`}
      onContextMenu={(event) => {
        event.preventDefault()
        setMenu({ x: event.clientX, y: event.clientY, anchor: event.currentTarget })
      }}
    >
      {/* Below the bar's strip: the content scrolls inside and never sits under the bar. */}
      <div data-testid="tile-content" className={`absolute inset-x-0 bottom-0 ${filters ? FILTER_ROW_TOP : BAR_HEIGHT_TOP} overflow-auto`}>
        {unavailable ? (
          <div className="flex h-full flex-col items-start justify-center gap-2 p-3">
            <p className="text-[11px] text-[var(--color-text-secondary)]">{unavailable}</p>
            <button type="button" onClick={() => setConfirmRemove(true)} className="rounded-md border border-[var(--color-border)] px-2 py-1 text-[11px] text-[var(--color-text)] hover:bg-[var(--color-bg-hover)]">
              Remove
            </button>
          </div>
        ) : needsCredentials ? (
          <div className="flex h-full flex-col items-start justify-center p-3">
            <MissingCredentials component={component!} scale="chrome" />
          </div>
        ) : !ok || result.isPending ? (
          <TileSkeleton />
        ) : scheduleNotice && !hasData ? (
          // Instead of the empty state: nothing will fill this tile here until the schedule runs.
          <div className="flex h-full flex-col items-start justify-center p-3">{scheduleNotice}</div>
        ) : scheduleNotice ? (
          // Above the cached data, which stays readable.
          <div className="flex h-full flex-col">
            <div className="shrink-0 border-b border-[var(--color-border)] px-3 py-1.5">{scheduleNotice}</div>
            <div className="relative min-h-0 flex-1 overflow-auto">{body}</div>
          </div>
        ) : (
          body
        )}
      </div>

      {/* The filters: a row of fixed height under the bar, always drawn, so nothing moves (D4). */}
      {filters && (
        <div className={`absolute inset-x-0 ${BAR_HEIGHT_TOP}`}>
          <TileFilters
            tileId={tile.id}
            specs={component!.params}
            params={stored}
            revision={paramsRevision}
            notice={filterNotice}
            onDismissNotice={() => setFilterNotice(null)}
            onChange={setParams}
          />
        </div>
      )}

      {/* Corner marks: they sit over the content and never move it. */}
      <div className="pointer-events-none absolute bottom-1.5 right-1.5 flex items-center gap-1">
        {hasData && data?.notice && <span className={MARK} title={data.notice} aria-label={data.notice}><Info size={12} className="text-[var(--color-warning)]" /></span>}
        {hasData && data?.tooLarge && <span className={MARK} title="Too large to keep: shown until Cinna restarts." aria-label="Too large to keep"><Info size={12} className="text-[var(--color-text-muted)]" /></span>}
        {mark && <span className={MARK} title={mark} aria-label={`Last refresh failed: ${mark}`}><AlertTriangle size={12} className="text-[var(--color-danger)]" /></span>}
      </div>
      {hasData && data?.refreshing && (
        <Loader2 size={12} aria-label="Refreshing" className="pointer-events-none absolute right-2 top-2 animate-spin text-[var(--color-text-muted)] group-hover:opacity-0" />
      )}

      {/*
        The bar's strip is reserved on every tile, so nothing moves on hover:
        the title always shows there, the controls fade in on hover (and stay
        in edit mode).
      */}
      <div
        data-testid="tile-bar"
        className={`absolute inset-x-0 top-0 flex ${BAR_HEIGHT} items-center gap-1 border-b border-[var(--color-border)] bg-[var(--color-bg)] px-2`}
      >
        {editMode && (
          <button
            type="button"
            aria-label={`Move ${displayTitle}`}
            title="Drag to move"
            onPointerDown={(event) => onHandlePointerDown(event, tile.id)}
            className="cursor-grab touch-none rounded p-0.5 text-[var(--color-text-muted)] hover:text-[var(--color-text)] active:cursor-grabbing"
          >
            <GripVertical size={13} />
          </button>
        )}
        <span className="min-w-0 flex-1 truncate text-[11px] font-medium text-[var(--color-text)]">{displayTitle}</span>
        <div
          className={`flex shrink-0 items-center gap-1 transition-opacity ${
            editMode ? 'opacity-100' : 'opacity-0 group-hover:opacity-100 focus-within:opacity-100'
          }`}
        >
        {ok && <span className="shrink-0 text-[10px] text-[var(--color-text-muted)]">{data?.refreshing ? 'Refreshing…' : ageLabel(data?.fetchedAt ?? null)}</span>}
        {schedule && !scheduleOff && (
          // Only where the tile is wide enough to keep its title readable; Refresh's tooltip says it everywhere.
          <span data-testid="tile-schedule-line" title={scheduleLine(schedule)} className="hidden max-w-[14rem] truncate text-[10px] text-[var(--color-text-muted)] @sm:inline">
            · {scheduleLine(schedule)}
          </span>
        )}
        {onBar.map((prompt, index) => (
          <button key={index} type="button" title={prompt.prompt} onClick={() => chat!.onPrompt(prompt)} className={BAR_TEXT_BUTTON}>
            {prompt.label}
          </button>
        ))}
        {canAsk && (
          <button type="button" onClick={chat!.onAsk} title={`Ask ${agentName} about this`} aria-label={`Ask about ${displayTitle}`} className={BAR_TEXT_BUTTON}>
            Ask
          </button>
        )}
        {ok && (
          <button type="button" onClick={refresh} title={refreshTitle} aria-label={`Refresh ${displayTitle}`} className="rounded p-0.5 text-[var(--color-text-muted)] hover:bg-[var(--color-bg-hover)] hover:text-[var(--color-text)]">
            <RefreshCw size={12} className={data?.refreshing ? 'animate-spin' : undefined} />
          </button>
        )}
        <button
          type="button"
          aria-label={`Actions for ${displayTitle}`}
          onClick={(event) => {
            const rect = event.currentTarget.getBoundingClientRect()
            setMenu({ x: rect.left, y: rect.bottom + 4, anchor: event.currentTarget })
          }}
          className="rounded p-0.5 text-[var(--color-text-muted)] hover:bg-[var(--color-bg-hover)] hover:text-[var(--color-text)]"
        >
          <MoreHorizontal size={13} />
        </button>
        </div>
      </div>

      {menu && (
        <ContextMenu x={menu.x} y={menu.y} anchor={menu.anchor} label={`Actions for ${displayTitle}`} error={updateTile.error?.message ?? null} onClose={() => setMenu(null)}>
          <div className="px-2 pb-0.5 pt-1 text-[10px] uppercase tracking-wide text-[var(--color-text-muted)]">Size</div>
          {TILE_SIZES.map((size: TileSize) => (
            <button
              key={size}
              type="button"
              role="menuitemradio"
              aria-checked={tile.size === size}
              className={CONTEXT_MENU_ITEM}
              onClick={() => updateTile.mutate({ tileId: tile.id, size }, { onSuccess: () => setMenu(null) })}
            >
              <span className="w-3">{tile.size === size ? '✓' : ''}</span>
              {TILE_SIZE_LABELS[size]}
            </button>
          ))}
          {inMenu.length > 0 && (
            <>
              <div className="my-1 border-t border-[var(--color-border)]" />
              <div className="px-2 pb-0.5 pt-1 text-[10px] uppercase tracking-wide text-[var(--color-text-muted)]">Ask</div>
              {inMenu.map((prompt, index) => (
                <button key={index} type="button" role="menuitem" title={prompt.prompt} className={CONTEXT_MENU_ITEM} onClick={() => { setMenu(null); chat!.onPrompt(prompt) }}>
                  {prompt.label}
                </button>
              ))}
            </>
          )}
          <div className="my-1 border-t border-[var(--color-border)]" />
          <button type="button" role="menuitem" className={CONTEXT_MENU_ITEM} onClick={() => { setMenu(null); setEditing(true) }}>
            Edit tile…
          </button>
          {component && (
            <button type="button" role="menuitem" className={CONTEXT_MENU_ITEM} onClick={() => { setMenu(null); openAgent() }}>
              Open agent
            </button>
          )}
          <div className="my-1 border-t border-[var(--color-border)]" />
          <button type="button" role="menuitem" className={`${CONTEXT_MENU_ITEM} text-[var(--color-danger)]`} onClick={() => { setMenu(null); setConfirmRemove(true) }}>
            Remove…
          </button>
        </ContextMenu>
      )}

      {confirmRemove && (
        <ConfirmDialog
          title={`Remove ${displayTitle}`}
          body={`Remove ${displayTitle} from ${dashboardName}? The component stays in ${agentName}’s folder; you can add it again.`}
          confirmLabel="Remove"
          pendingLabel="Removing…"
          pending={removeTile.isPending}
          error={removeTile.error?.message ?? null}
          onConfirm={() => removeTile.mutate(tile.id, { onSuccess: () => setConfirmRemove(false) })}
          onClose={() => { if (!removeTile.isPending) { removeTile.reset(); setConfirmRemove(false) } }}
        />
      )}
      {editing && <EditTileDialog view={view} onClose={() => setEditing(false)} />}
    </div>
  )
}
