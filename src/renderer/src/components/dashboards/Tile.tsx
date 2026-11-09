import { useEffect, useRef, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { AlertTriangle, Bot, GripVertical, Info, Loader2, MessageSquare, MoreHorizontal, Pencil, RefreshCw, Trash2 } from 'lucide-react'
import { TILE_CUSTOM_LABEL, TILE_SIZES, TILE_SIZE_LABELS, enabledTilePrompts, nearestPresetSize, tileSpan, type CloudTileStatus, type CollectedPageContext, type ComponentPrompt, type TileScheduleState, type TileSize, type TileView } from '../../../../shared/dashboards'
import { tileParamsShown } from './dashboardContext'
import { useRemoveTile, useTileResult, useUpdateTile } from '../../hooks/useDashboards'
import { ContextMenu, CONTEXT_MENU_ITEM } from '../ui/ContextMenu'
import { ConfirmDialog } from './DashboardDialog'
import { EditTileDialog } from './EditTileDialog'
import { TileBody, TileSkeleton, ageLabel } from './TileBody'
import { COMPONENT_LINK, MissingCredentials, errorFindings, openAgentTab, openCinnaSignIn } from './componentParts'
import { FILTER_ROW_TOP, TileFilters, hasFilterRow } from './TileFilters'
import { TilePromptButton } from './TilePromptButton'
import type { ViewSelection } from './views/nativeViews'
import { drawnHighlights, revealFirstHighlight, revealHighlight, useTileHighlight } from './useTileHighlight'

/** What a tile on a dashboard with the chat panel gets (README D3); a tile without it has no Ask. */
export interface TileChat {
  focused: boolean
  /**
   * The chat panel is closed: focus and row picks go nowhere, so neither is
   * drawn and rows cannot be picked. Clicks still choose the tile the panel
   * opens on. Absent: open.
   */
  panelClosed?: boolean
  /** The rows or items picked here (native views). */
  selected: string[]
  /** Click anywhere on the tile. */
  onFocus: () => void
  onPick: (key: string, additive: boolean) => void
  onClearSelection: () => void
  /** The page's `setContext` (html view). */
  onContext: (context: { summary: string; selection: string[] }) => void
  /** The page's `cinna/collect-context` answer (html view, focused tile only). */
  onCollected: (collected: CollectedPageContext) => void
  /** Bumped when the panel's composer gains focus: the focused page is asked what it shows now. */
  collectRequest?: number
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

/** Whether a tile this wide has room for its suggested questions on the hover bar; narrower, they are in ⋯. */
export function promptsFitOnBar(cols: number): boolean {
  return cols >= 4
}

const BAR_TEXT_BUTTON =
  'shrink-0 max-w-[10rem] truncate rounded px-1.5 py-0.5 text-[12px] font-medium text-[var(--color-accent)] hover:bg-[var(--color-bg-hover)] hover:text-[var(--color-accent-hover)]'

/**
 * The hover controls when they are not in edit mode: over the end of the bar
 * rather than beside the title, so a hidden control takes none of the title's
 * width and showing one moves and resizes nothing (ux rule 1). Their left edge
 * fades into the bar's colour, over the title's end.
 */
const BAR_OVERLAY_CONTROLS =
  'absolute inset-y-0 right-full flex items-center gap-1 whitespace-nowrap bg-[linear-gradient(to_right,transparent,var(--color-bg)_1.25rem)] pl-6 opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100'

/**
 * The title off: the bar, and under it the filter row, are one floating header
 * (`data-tile-header`). Both slide down from the tile's top and fade in on hover
 * or with focus in either, reversing to leave, over the content and moving
 * nothing (ux rule 1); the tile clips them at rest. The filter row starts two
 * heights up, under the bar, so they travel as one. Both are opaque and take
 * their clicks, so nothing unseen is pressed through them. Fade alone with Extra
 * UI animation off or under reduced motion.
 */
const FLOATING_REVEAL =
  'transition-[opacity,translate] duration-200 ease-out group-hover:opacity-100 group-hover:translate-y-0 group-has-[[data-tile-header]:focus-within]:opacity-100 group-has-[[data-tile-header]:focus-within]:translate-y-0 motion-reduce:translate-y-0 [[data-motion-fade]_&]:translate-y-0'
const FLOATING_BAR_HIDDEN = 'opacity-0 -translate-y-full'
const FLOATING_FILTERS_HIDDEN = 'opacity-0 -translate-y-[200%]'

const MARK = 'pointer-events-auto rounded-full bg-[var(--color-bg)] p-0.5'

type CloudMarkValue = NonNullable<CloudTileStatus['mark']>

/**
 * Why a cloud tile cannot be brought up to date (D6.10): main's sentence and
 * the action its code has. As a `pill` it sits over the cached data at the
 * tile's foot and moves nothing; as a `block` it fills a tile that has no
 * data to keep (and an html tile whose files the server did not serve).
 */
/** A mark's action: the accent link every Retry on a dashboard uses (ux rule 13). */
const MARK_ACTION = `${COMPONENT_LINK} disabled:cursor-default disabled:opacity-50`

function CloudMark({
  mark,
  layout,
  agentId,
  onRetry,
  retrying = false,
  onRemove
}: {
  mark: CloudMarkValue
  layout: 'pill' | 'block'
  /** The cloud agent's row id, for Open agent; null when the tile has never read its component. */
  agentId: string | null
  onRetry: () => void
  /** A Retry is in flight: the button is disabled, its label unchanged (no width change, ux rule 1). */
  retrying?: boolean
  onRemove: () => void
}): React.JSX.Element {
  const action =
    mark.code === 'unreachable' ? { label: 'Retry', run: onRetry }
      : mark.code === 'reauth_required' ? { label: 'Open settings', run: openCinnaSignIn }
        : mark.code === 'agent_gone' ? { label: 'Remove', run: onRemove }
          : mark.code === 'needs_credentials' && agentId ? { label: 'Open agent', run: () => openAgentTab(agentId, 'overview') }
            : null
  const busy = !!action && action.run === onRetry && retrying
  const icon =
    mark.code === 'waking'
      ? <Loader2 size={11} aria-hidden="true" className="shrink-0 animate-spin text-[var(--color-text-muted)] motion-reduce:animate-none" />
      : <AlertTriangle size={11} aria-hidden="true" className="shrink-0 text-[var(--color-warning)]" />
  if (layout === 'block') {
    return (
      <div data-cloud-mark={mark.code} className="flex h-full flex-col items-start justify-center gap-2 p-3">
        <p className="m-0 flex items-center gap-1.5 text-[11px] text-[var(--color-text-secondary)]">{icon}{mark.message}</p>
        {action && (
          <button type="button" onClick={action.run} disabled={busy} aria-busy={busy || undefined} className={`text-[11px] ${MARK_ACTION}`}>
            {action.label}
          </button>
        )}
      </div>
    )
  }
  return (
    <div
      data-cloud-mark={mark.code}
      role="status"
      className="pointer-events-auto inline-flex min-h-5 max-w-full items-center gap-1 rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] px-1.5 py-0.5 text-[10px] leading-[13px] text-[var(--color-text-secondary)]"
    >
      {icon}
      {/* Two lines at most: on a Small tile the reason is read, not hovered for (ux rule 7). */}
      <span data-cloud-mark-text className="min-w-0 break-words line-clamp-2" title={mark.message}>{mark.message}</span>
      {action && (
        <button type="button" onClick={action.run} disabled={busy} aria-busy={busy || undefined} className={`shrink-0 ${MARK_ACTION}`}>
          {action.label}
        </button>
      )}
    </div>
  )
}

/**
 * The bar's strip, reserved at the top of every tile: the bar's height, and
 * where the content starts. 34 px, the design pack's scale (title 13, age 12);
 * `FILTER_ROW_TOP` in TileFilters is this plus the filter row.
 */
const BAR_HEIGHT = 'h-[34px]'
const BAR_HEIGHT_TOP = 'top-[34px]'

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
  onEditLayout,
  onResizePointerDown,
  onResizeBy,
  onVisibilityChange,
  chat
}: {
  view: TileView
  dashboardName: string
  span: { cols: number; rows: number }
  editMode: boolean
  dragging: boolean
  onHandlePointerDown: (event: React.PointerEvent, tileId: string) => void
  /** Choosing Custom: resizing happens in edit layout, so the corner shows at once. */
  onEditLayout?: () => void
  /** The corner handle, in edit layout only; the view snaps it to the grid. */
  onResizePointerDown?: (event: React.PointerEvent, tileId: string) => void
  /** The corner handle's arrow keys: one cell. */
  onResizeBy?: (tileId: string, cols: number, rows: number) => void
  /** The tile came on screen or left it (scrolled); the view keeps the lease and first loads. */
  onVisibilityChange: (tileId: string, visible: boolean) => void
  /** Focus, selection, Ask and suggested questions (the chat panel, D3). */
  chat?: TileChat
}): React.JSX.Element {
  const { tile, displayTitle, state, component } = view
  const cloud = !!tile.cloud
  // A credential the agent has not attached: nothing runs, the tile says which (README D16).
  // A cloud tile keeps its cached data and says so in its mark instead (D6.10).
  const needsCredentials = !cloud && state === 'ok' && !!component && component.missingCredentials.length > 0
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
  // Interface (Edit tile). Edit layout draws both whatever they say: the tile's bounds and its handle are the point there.
  const borderShown = tile.showBorder !== false || editMode
  const titleShown = tile.showTitle !== false || editMode
  /** The filter row's and the questions' menus are portaled: the pointer in one is off the tile. */
  const [filtersMenuOpen, setFiltersMenuOpen] = useState(false)
  const [promptMenuOpen, setPromptMenuOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  // What an agent highlighted here (D5); the owner's own pick or Escape ends it.
  const highlight = useTileHighlight(tile.id)
  const highlightKey = highlight.ids.join('\u0000')
  /** The page's last reported selection: only a change to a non-empty one is the owner's pick. */
  const pageSelection = useRef('')

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

  // The first highlighted row in view, inside the tile only; once per highlight, as soon as it is drawn.
  const revealed = useRef<string | null>(null)
  /** Which drawn highlighted row the bar's "N highlighted" showed last; a new highlight starts at the first. */
  const stepped = useRef(0)
  /** How many highlighted rows the tile draws (native views); the page of a web tile draws its own. */
  const [drawnCount, setDrawnCount] = useState(0)
  useEffect(() => {
    const count = ref.current ? drawnHighlights(ref.current).length : 0
    if (count !== drawnCount) setDrawnCount(count)
    if (highlightKey === '') {
      revealed.current = null
      return
    }
    if (revealed.current === highlightKey || !ref.current) return
    if (revealFirstHighlight(ref.current)) {
      revealed.current = highlightKey
      stepped.current = 0
    }
  })
  const showNextHighlight = (): void => {
    if (!ref.current) return
    stepped.current += 1
    revealHighlight(ref.current, stepped.current)
  }

  const refresh = (): Promise<void> => {
    setRefreshError(null)
    return window.api.dashboards
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
  const agentName = view.agentName ?? component?.agentName ?? 'its agent'
  const unavailable =
    state === 'wrong_server'
      ? 'Not on this server.'
      : state === 'agent_missing'
        ? cloud ? `${agentName} is no longer available.` : 'The agent behind this tile is not on this computer.'
      : state === 'component_missing'
        ? cloud ? `${tile.component} is no longer in ${agentName}.` : `${tile.component} is no longer in ${agentName}’s folder.`
        : state === 'invalid'
          ? `${displayTitle} has problems to fix: ${(component && errorFindings(component)[0]?.message) ?? 'its component.json is not valid'}`
          : null
  // A cloud tile's mark says why with its action; its `error` is the same sentence, so it is not drawn twice.
  const cloudMark = ok ? (data?.cloud?.mark ?? null) : null
  const mark = refreshError ?? (cloudMark ? null : (data?.error ?? null))
  const bodyData = cloudMark && data ? { ...data, error: null } : data
  // An html tile whose files the server did not serve shows the sentence and Retry in place of
  // the frame; Retry re-opens the frame until the next answer says otherwise.
  const [frameRetryAt, setFrameRetryAt] = useState<number | null>(null)
  const frameBlocked = cloudMark?.code === 'unreachable' && component?.view === 'html' && frameRetryAt !== result.dataUpdatedAt
  // No data to keep under the mark (and not waking, where the skeleton waits): the mark fills the tile.
  const markFills = !!cloudMark && (frameBlocked || (!hasData && component?.view !== 'html' && cloudMark.code !== 'waking'))
  // One Retry at a time: a manual refresh can wake the agent's environment, so a second click waits for the first.
  const [retrying, setRetrying] = useState(false)
  const retryingRef = useRef(false)
  const retryCloud = (): void => {
    if (retryingRef.current || data?.refreshing) return
    retryingRef.current = true
    setRetrying(true)
    if (component?.view === 'html') setFrameRetryAt(result.dataUpdatedAt)
    void refresh().finally(() => {
      retryingRef.current = false
      setRetrying(false)
    })
  }
  const retryBusy = retrying || !!data?.refreshing
  // Asking needs the agent: the panel's chat is that agent's.
  // A cloud tile whose agent core no longer has (or made on another server): nothing runs, so
  // its filters, Ask and Refresh stay where they are, disabled (ux rule 1).
  const gone = state === 'agent_missing' || state === 'wrong_server' || cloudMark?.code === 'agent_gone'
  const canAsk = !!chat && !!component && !gone
  const prompts = canAsk ? enabledTilePrompts(component!.prompts, tile.promptOverride) : []
  const onBar = promptsFitOnBar(span.cols) ? prompts : []
  const inMenu = onBar.length > 0 ? [] : prompts
  const selection: ViewSelection | undefined = chat && !chat.panelClosed
    ? { selected: chat.selected, onPick: (key, additive) => { highlight.clear(); chat.onPick(key, additive) } }
    : undefined
  // A page's setContext: a new non-empty selection is the owner's pick there, which ends the agent's highlight.
  const onPageContext = (context: { summary: string; selection: string[] }): void => {
    const key = context.selection.join('\u0000')
    if (context.selection.length > 0 && key !== pageSelection.current) highlight.clear()
    pageSelection.current = key
    chat?.onContext(context)
  }
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
      result={bodyData}
      loading={result.isPending}
      frameTarget={{ tileId: tile.id }}
      // A cloud tile shows the params core computed with (`current`, `today` in the owner's server time zone).
      meta={{ component: tile.component, title: displayTitle, params: tileParamsShown(tile, component, data), size: tile.size === 'custom' ? nearestPresetSize(tileSpan(tile)) : tile.size }}
      selection={selection}
      onContext={onPageContext}
      actions={{ onParams: setParams, onAsk: canAsk ? (text) => { chat!.onFill(text); return true } : undefined }}
      highlight={{
        ids: highlight.ids,
        label: `Highlighted by ${agentName}`,
        onReady: () => void window.api.dashboards.highlightReady(tile.id).catch(() => {}),
        onLost: () => void window.api.dashboards.highlightReady(tile.id, false).catch(() => {})
      }}
      collect={chat ? { enabled: chat.focused, onCollected: chat.onCollected, request: chat.collectRequest } : undefined}
      cloudNames={tile.cloud ? { agent: agentName, server: tile.cloud.server } : undefined}
      reopenKey={tile.cloud ? result.dataUpdatedAt : undefined}
    />
  )

  const headerPinned = !!menu || !!filterNotice || drawnCount > 0 || filtersMenuOpen || promptMenuOpen

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
      onKeyDown={chat || highlight.ids.length > 0 ? (event) => {
        if (event.key !== 'Escape' || ((chat?.selected.length ?? 0) === 0 && highlight.ids.length === 0)) return
        event.stopPropagation()
        if (chat && chat.selected.length > 0) chat.onClearSelection()
        highlight.clear()
      } : undefined}
      style={{ gridColumn: `span ${span.cols}`, gridRow: `span ${span.rows}` }}
      // The focus ring is a box-shadow: focusing a tile moves nothing (ux rule 1).
      className={`@container group relative min-h-0 min-w-0 overflow-hidden rounded-lg border bg-[var(--color-bg)] outline-none ${
        dragging ? 'border-[var(--color-accent)] opacity-60' : borderShown ? 'border-[var(--color-border)]' : 'border-transparent'
      } ${chat?.focused && !chat.panelClosed ? 'ring-1 ring-[color-mix(in_srgb,var(--color-accent)_55%,transparent)]' : ''}`}
      onContextMenu={(event) => {
        event.preventDefault()
        setMenu({ x: event.clientX, y: event.clientY, anchor: event.currentTarget })
      }}
    >
      {/* Below the bar's strip: the content scrolls inside and never sits under the bar. */}
      <div data-testid="tile-content" className={`absolute inset-x-0 bottom-0 ${!titleShown ? 'top-0' : filters ? FILTER_ROW_TOP : BAR_HEIGHT_TOP} overflow-auto`}>
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
        ) : markFills ? (
          <CloudMark mark={cloudMark!} layout="block" agentId={component?.agentId ?? null} onRetry={retryCloud} retrying={retryBusy} onRemove={() => setConfirmRemove(true)} />
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
        <div
          data-tile-header
          data-testid="tile-filter-slot"
          className={`absolute inset-x-0 ${BAR_HEIGHT_TOP} ${
            titleShown ? '' : `${FLOATING_REVEAL} z-[5] ${borderShown ? '' : 'border-x border-[var(--color-border)] shadow-sm'} ${headerPinned ? '' : FLOATING_FILTERS_HIDDEN}`
          }`}
        >
          <TileFilters
            tileId={tile.id}
            specs={component!.params}
            params={stored}
            revision={paramsRevision}
            notice={filterNotice}
            onDismissNotice={() => setFilterNotice(null)}
            onChange={setParams}
            resolved={cloud ? (data?.cloud?.paramsResolved ?? null) : null}
            disabled={gone}
            onMoreOpenChange={setFiltersMenuOpen}
          />
        </div>
      )}

      {/* A cloud tile's mark, over the cached data at the tile's foot: it never moves the content. */}
      {cloudMark && !markFills && (
        <div className="pointer-events-none absolute bottom-1.5 left-1.5 right-10 flex">
          <CloudMark mark={cloudMark} layout="pill" agentId={component?.agentId ?? null} onRetry={retryCloud} retrying={retryBusy} onRemove={() => setConfirmRemove(true)} />
        </div>
      )}

      {/* Corner marks: they sit over the content and never move it, and clear of the resize corner, whose tooltip would hide theirs. */}
      <div className={`pointer-events-none absolute bottom-1.5 flex items-center gap-1 ${onResizePointerDown && editMode ? 'right-6' : 'right-1.5'}`}>
        {hasData && data?.notice && <span className={MARK} title={data.notice} aria-label={data.notice}><Info size={12} className="text-[var(--color-warning)]" /></span>}
        {hasData && data?.tooLarge && <span className={MARK} title="Too large to keep: shown until Cinna restarts." aria-label="Too large to keep"><Info size={12} className="text-[var(--color-text-muted)]" /></span>}
        {mark && <span className={MARK} title={mark} aria-label={`Last refresh failed: ${mark}`}><AlertTriangle size={12} className="text-[var(--color-danger)]" /></span>}
      </div>
      {hasData && data?.refreshing && (
        <Loader2 size={12} aria-label="Refreshing" className="pointer-events-none absolute right-2 top-[11px] animate-spin text-[var(--color-text-muted)] group-hover:opacity-0" />
      )}

      {/*
        The bar's strip is reserved on every tile, so nothing moves on hover:
        the title always shows there and takes the whole strip; the controls
        fade in over its end on hover or keyboard focus (and sit beside it in
        edit mode, where they stay shown).
      */}
      <div
        data-testid="tile-bar"
        data-tile-header
        className={`absolute inset-x-0 top-0 flex ${BAR_HEIGHT} items-center gap-1 bg-[var(--color-bg)] px-2 ${titleShown ? (borderShown ? 'border-b border-[var(--color-border)]' : '') : `${FLOATING_REVEAL} z-[6] ${borderShown ? 'border-b border-[var(--color-border)]' : `border border-[var(--color-border)] ${filters ? 'rounded-t-lg' : 'rounded-lg shadow-sm'}`} ${headerPinned ? '' : FLOATING_BAR_HIDDEN}`}`}
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
        <span className="min-w-0 flex-1 truncate text-[13px] font-medium text-[var(--color-text)]">{displayTitle}</span>
        {/*
          The end of the strip: the highlight count (always shown while rows are
          highlighted, so one below the fold is not missed) and, just before
          it, the controls.
        */}
        <div className="relative flex shrink-0 items-center gap-1 self-stretch">
          <div data-testid="tile-bar-controls" className={editMode ? 'flex shrink-0 items-center gap-1' : BAR_OVERLAY_CONTROLS}>
          {ok && <span className={`shrink-0 text-[12px] text-[var(--color-text-muted)] ${onBar.length > 0 ? 'hidden @sm:inline' : ''}`}>{data?.refreshing ? 'Refreshing…' : ageLabel(data?.fetchedAt ?? null)}</span>}
          {schedule && !scheduleOff && (
            // Only where the tile is wide enough to keep its title readable; Refresh's tooltip says it everywhere.
            <span data-testid="tile-schedule-line" title={scheduleLine(schedule)} className="hidden max-w-[14rem] truncate text-[12px] text-[var(--color-text-muted)] @sm:inline">
              · {scheduleLine(schedule)}
            </span>
          )}
          <TilePromptButton prompts={onBar} tileTitle={displayTitle} onPrompt={(prompt) => chat!.onPrompt(prompt)} onMenuChange={setPromptMenuOpen} />
          {(canAsk || (gone && !!chat && !!component)) && (
            <button type="button" onClick={canAsk ? chat!.onAsk : undefined} disabled={!canAsk} title={canAsk ? `Ask ${agentName} about this` : undefined} aria-label={`Ask about ${displayTitle}`} className="rounded p-0.5 text-[var(--color-text-muted)] hover:bg-[var(--color-bg-hover)] hover:text-[var(--color-text)] disabled:cursor-default disabled:opacity-50 disabled:hover:bg-transparent">
              <MessageSquare size={12} />
            </button>
          )}
          {ok && (
            <button type="button" onClick={refresh} disabled={gone} title={gone ? undefined : refreshTitle} aria-label={`Refresh ${displayTitle}`} className="rounded p-0.5 text-[var(--color-text-muted)] hover:bg-[var(--color-bg-hover)] hover:text-[var(--color-text)] disabled:cursor-default disabled:opacity-50 disabled:hover:bg-transparent">
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
          {drawnCount > 0 && (
            <button
              type="button"
              data-testid="tile-highlight-count"
              onClick={showNextHighlight}
              title={`Highlighted by ${agentName}: show the next one`}
              className={BAR_TEXT_BUTTON}
            >
              {drawnCount} highlighted
            </button>
          )}
        </div>
      </div>

      {onResizePointerDown && editMode && (
        <button
          type="button"
          aria-label={`Resize ${displayTitle}`}
          title="Drag to resize"
          data-testid="tile-resize-handle"
          onPointerDown={(event) => onResizePointerDown(event, tile.id)}
          onKeyDown={(event) => {
            const step = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }[event.key]
            if (!step) return
            event.preventDefault()
            onResizeBy?.(tile.id, step[0], step[1])
          }}
          className="absolute bottom-0 right-0 z-10 flex h-5 w-5 cursor-nwse-resize touch-none items-end justify-end rounded-br-lg p-1 text-[var(--color-text-muted)] hover:text-[var(--color-accent)]"
        >
          <span aria-hidden="true" className="block h-2 w-2 rounded-br-[3px] border-b-2 border-r-2 border-current" />
        </button>
      )}

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
          <button
            type="button"
            role="menuitemradio"
            aria-checked={tile.size === 'custom'}
            className={CONTEXT_MENU_ITEM}
            // From the cells it has now; edit layout then shows its corner.
            onClick={() => updateTile.mutate({ tileId: tile.id, size: 'custom', customSpan: tile.customSpan ?? tileSpan(tile) }, { onSuccess: () => { setMenu(null); onEditLayout?.() } })}
          >
            <span className="w-3">{tile.size === 'custom' ? '✓' : ''}</span>
            {TILE_CUSTOM_LABEL}
          </button>
          {inMenu.length > 0 && (
            <>
              <div className="my-1 border-t border-[var(--color-border)]" />
              <div className="px-2 pb-0.5 pt-1 text-[10px] uppercase tracking-wide text-[var(--color-text-muted)]">Ask</div>
              {inMenu.map((prompt, index) => (
                <button key={index} type="button" role="menuitem" title={prompt.prompt} className={CONTEXT_MENU_ITEM} onClick={() => { setMenu(null); chat!.onPrompt(prompt) }}>
                  <MessageSquare size={12} className="shrink-0" />
                  {prompt.label}
                </button>
              ))}
            </>
          )}
          <div className="my-1 border-t border-[var(--color-border)]" />
          <button type="button" role="menuitem" className={CONTEXT_MENU_ITEM} onClick={() => { setMenu(null); setEditing(true) }}>
            <Pencil size={12} />
            Edit
          </button>
          {component && (
            <button type="button" role="menuitem" className={CONTEXT_MENU_ITEM} onClick={() => { setMenu(null); openAgent() }}>
              <Bot size={12} />
              Open agent
            </button>
          )}
          <div className="my-1 border-t border-[var(--color-border)]" />
          <button type="button" role="menuitem" className={`${CONTEXT_MENU_ITEM} text-[var(--color-danger)]`} onClick={() => { setMenu(null); setConfirmRemove(true) }}>
            <Trash2 size={12} />
            Remove
          </button>
        </ContextMenu>
      )}

      {confirmRemove && (
        <ConfirmDialog
          title={`Remove ${displayTitle}`}
          body={
            cloud && (view.state === 'agent_missing' || cloudMark?.code === 'agent_gone')
              ? `Remove ${displayTitle} from ${dashboardName}? ${agentName} is no longer available, so its data goes with the tile.`
              : cloud && view.state === 'wrong_server'
                ? `Remove ${displayTitle} from ${dashboardName}? It was made on another Cinna server, so its data goes with the tile.`
                : cloud
                  ? `Remove ${displayTitle} from ${dashboardName}? The component stays with ${agentName}; you can add it again.`
              : `Remove ${displayTitle} from ${dashboardName}? The component stays in ${agentName}’s folder; you can add it again.`
          }
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
