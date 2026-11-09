import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Check, LayoutDashboard, LayoutGrid, MessageSquare, MoreHorizontal, Pencil, RefreshCw, Trash2 } from 'lucide-react'
import { DASHBOARD_LEASE_RENEW_MS, TILE_SPAN_LIMITS, enabledTilePrompts, tileSpan, type ComponentPrompt, type DashboardContext, type TileSpan, type TileView } from '../../../../shared/dashboards'
import { useAnyTileRefreshing, useDashboardList, useDashboardTiles, useDeleteDashboard, useMoveTile, useTileResult, useUpdateTile } from '../../hooks/useDashboards'
import { useChatStore } from '../../stores/chat.store'
import { useUIStore } from '../../stores/ui.store'
import { unwrapIpcError } from '../../utils/ipcError'
import { ContextMenu, CONTEXT_MENU_ITEM } from '../ui/ContextMenu'
import { ConfirmDialog } from './DashboardDialog'
import { RenameDashboardDialog } from './DashboardsList'
import { Tile, type TileChat } from './Tile'
import { DashboardChatPanel, usePanelPresence, type ContextChip, type PendingPrompt } from './DashboardChatPanel'
import { buildDashboardContext, coalescePerKey, contextIdentity, webContextFromCollected, type WebTileContext } from './dashboardContext'

/** Grid row height, px. */
const ROW_HEIGHT = 110
const GAP = 12

/** 12 columns, then 6 below about 900 px, then 3; a preset is narrowed, never grown. */
function columnsFor(width: number): number {
  if (width >= 900) return 12
  if (width >= 440) return 6
  return 3
}

/** The agent page header's Settings button (LocalAgentPage). */
const HEADER_BUTTON =
  'ambient-button flex h-[1.875rem] items-center gap-1.5 rounded-md border border-[var(--color-border)] px-3 py-1.5 text-xs font-medium text-[var(--color-text)] transition-colors hover:bg-[var(--color-bg-hover)] disabled:opacity-50'
/**
 * The header's Chat button: pressed while the panel is open. Accent tint, accent
 * text and a slight inset, colour and shadow only, so it moves nothing.
 */
const HEADER_TOGGLE_PRESSED =
  'aria-pressed:border-[color-mix(in_srgb,var(--color-accent)_50%,transparent)] aria-pressed:bg-[color-mix(in_srgb,var(--color-accent)_14%,transparent)] aria-pressed:text-[var(--color-accent)] aria-pressed:shadow-[inset_0_1px_2px_color-mix(in_srgb,var(--color-text)_18%,transparent)] aria-pressed:hover:bg-[color-mix(in_srgb,var(--color-accent)_20%,transparent)]'
/** The agent page header's ⋯ button (AgentActionsMenu). */
const HEADER_ICON_BUTTON =
  'flex h-[1.875rem] items-center rounded-md border border-[var(--color-border)] px-1.5 text-[var(--color-text-secondary)] transition-colors hover:bg-[var(--color-bg-hover)] hover:text-[var(--color-text)]'

/**
 * The visibility lease: while the window is shown and focused, the tiles on
 * screen are renewed every 20 s (main re-checks them); on hide, blur or
 * leaving the dashboard the lease is dropped. A tile shown for the first time
 * asks main to recompute it if stale, focused or not — the user opened it.
 */
function useTileLease(dashboardId: string | null) {
  const visible = useRef(new Set<string>())
  const asked = useRef(new Set<string>())
  /** Lease now: set by the effect, called when a tile first comes on screen (batched to one call per tick). */
  const renewSoon = useRef<() => void>(() => {})

  useEffect(() => {
    visible.current = new Set()
    asked.current = new Set()
    const active = (): boolean => document.visibilityState === 'visible' && document.hasFocus()
    const renew = (): void => {
      if (!active() || visible.current.size === 0) return
      void window.api.dashboards.lease([...visible.current]).catch(() => {})
    }
    const drop = (): void => {
      void window.api.dashboards.dropLease().catch(() => {})
    }
    // Focus moving into a tile's own frame blurs the window, but the app still has focus: keep the lease.
    const onBlur = (): void => {
      setTimeout(() => {
        if (!document.hasFocus()) drop()
      }, 0)
    }
    let pending: ReturnType<typeof setTimeout> | null = null
    renewSoon.current = () => {
      if (pending) return
      pending = setTimeout(() => {
        pending = null
        renew()
      }, 0)
    }
    const onVisibility = (): void => (document.visibilityState === 'visible' ? renew() : drop())
    const timer = setInterval(renew, DASHBOARD_LEASE_RENEW_MS)
    window.addEventListener('blur', onBlur)
    window.addEventListener('focus', renew)
    document.addEventListener('visibilitychange', onVisibility)
    return () => {
      clearInterval(timer)
      if (pending) clearTimeout(pending)
      renewSoon.current = () => {}
      window.removeEventListener('blur', onBlur)
      window.removeEventListener('focus', renew)
      document.removeEventListener('visibilitychange', onVisibility)
      drop()
    }
  }, [dashboardId])

  return useCallback((tileId: string, isVisible: boolean) => {
    if (isVisible && !visible.current.has(tileId)) {
      visible.current.add(tileId)
      // Leased at once, not at the next 20 s tick: an after-turn refresh needs a live lease.
      renewSoon.current()
    } else if (!isVisible) visible.current.delete(tileId)
    if (isVisible && !asked.current.has(tileId)) {
      asked.current.add(tileId)
      void window.api.dashboards.ensureFresh(tileId, 'visible').catch(() => {})
    }
  }, [])
}

/** Pointer-event reorder in edit mode: the order shown while dragging, then one move on release. */
function useTileDrag(tiles: TileView[], onDrop: (tileId: string, toIndex: number) => void) {
  const [drag, setDrag] = useState<{ tileId: string; order: string[] } | null>(null)
  const dragRef = useRef(drag)
  dragRef.current = drag

  const onHandlePointerDown = useCallback(
    (event: React.PointerEvent, tileId: string) => {
      event.preventDefault()
      const order = tiles.map((view) => view.tile.id)
      setDrag({ tileId, order })
      const move = (e: PointerEvent): void => {
        const current = dragRef.current
        if (!current) return
        const target = document.elementsFromPoint(e.clientX, e.clientY)
          .map((el) => (el as HTMLElement).closest?.('[data-tile-id]') as HTMLElement | null)
          .find((el) => el && el.dataset.tileId !== current.tileId)
        const overId = target?.dataset.tileId
        if (!overId) return
        // Take the place of the tile under the pointer: after it moving forward, before it moving back.
        const next = current.order.filter((id) => id !== current.tileId)
        next.splice(current.order.indexOf(overId), 0, current.tileId)
        if (next.join() !== current.order.join()) setDrag({ ...current, order: next })
      }
      const up = (): void => {
        window.removeEventListener('pointermove', move)
        window.removeEventListener('pointerup', up)
        window.removeEventListener('pointercancel', up)
        const current = dragRef.current
        setDrag(null)
        if (!current) return
        const toIndex = current.order.indexOf(current.tileId)
        if (toIndex !== tiles.findIndex((view) => view.tile.id === current.tileId)) onDrop(current.tileId, toIndex)
      }
      window.addEventListener('pointermove', move)
      window.addEventListener('pointerup', up)
      window.addEventListener('pointercancel', up)
    },
    [tiles, onDrop]
  )

  const ordered = useMemo(() => {
    if (!drag) return tiles
    const byId = new Map(tiles.map((view) => [view.tile.id, view]))
    return drag.order.map((id) => byId.get(id)).filter((view): view is TileView => !!view)
  }, [drag, tiles])

  return { ordered, draggingId: drag?.tileId ?? null, onHandlePointerDown }
}

/** The new span for a tile dragged from `start` by (dx, dy) px, snapped to the grid's cells. */
export function snapTileSpan(
  start: TileSpan,
  dx: number,
  dy: number,
  grid: { width: number; columns: number; rowHeight: number; gap: number }
): TileSpan {
  const cell = (grid.width - grid.gap * (grid.columns - 1)) / grid.columns + grid.gap
  const row = grid.rowHeight + grid.gap
  const clamp = (value: number, min: number, max: number): number => Math.max(min, Math.min(max, value))
  return {
    cols: clamp(start.cols + Math.round(dx / cell), Math.min(TILE_SPAN_LIMITS.minCols, grid.columns), grid.columns),
    rows: clamp(start.rows + Math.round(dy / row), TILE_SPAN_LIMITS.minRows, TILE_SPAN_LIMITS.maxRows)
  }
}

/** Whether one of this dashboard's own chats has a turn running: `streamingChatId` is the chat on screen, ahead of the polled list. */
export function dashboardChatRunning(
  chats: ReadonlyArray<{ id: string; originDashboardId?: string | null; activeRunId?: string | null }> | undefined,
  dashboardId: string | null,
  streamingChatId: string | null
): boolean {
  if (!chats || !dashboardId) return false
  return chats.some((chat) => chat.originDashboardId === dashboardId && (!!chat.activeRunId || chat.id === streamingChatId))
}

/**
 * {@link dashboardChatRunning} from the chat list, polled once a second as the
 * sidebar's rows are. Only the answer is selected: the rows hold dates, so every
 * poll is a new list, and the whole dashboard must not re-render for each.
 */
function useDashboardChatRunning(dashboardId: string | null): boolean {
  const streamingChatId = useChatStore((s) => (s.isStreaming ? s.activeChatId : null))
  const { data } = useQuery({
    queryKey: ['chats'],
    queryFn: () => window.api.chat.list(),
    refetchInterval: 1_000,
    select: (rows) => dashboardChatRunning(rows, dashboardId, streamingChatId)
  })
  return data ?? false
}

/** The header Refresh spins at least this long, one full turn of `animate-spin`, so even an instant refresh is seen. */
export const REFRESH_MIN_SPIN_MS = 1000

/**
 * The header Refresh's feedback: from the press until the minimum has passed,
 * every tile was asked, and none is recomputing. `ensureFresh` answers once a
 * run has started, so the tiles' own state says when it ended. Only a press
 * spins it: a tile recomputing on its own schedule does not.
 */
function useRefreshAll(tiles: TileView[], dashboardId: string | null) {
  const anyRefreshing = useAnyTileRefreshing(useMemo(() => tiles.map((view) => view.tile.id), [tiles]))
  const [press, setPress] = useState<{ minPassed: boolean; asked: boolean } | null>(null)
  const seq = useRef(0)

  useEffect(() => {
    seq.current += 1
    setPress(null)
  }, [dashboardId])
  useEffect(() => {
    if (press?.minPassed && press.asked && !anyRefreshing) setPress(null)
  }, [press, anyRefreshing])

  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current) }, [])

  const refreshAll = (): void => {
    if (press) return
    const mine = ++seq.current
    setPress({ minPassed: false, asked: false })
    timer.current = setTimeout(() => {
      if (seq.current === mine) setPress((p) => (p ? { ...p, minPassed: true } : p))
    }, REFRESH_MIN_SPIN_MS)
    const runs = tiles.filter((view) => view.state === 'ok').map((view) => window.api.dashboards.ensureFresh(view.tile.id, 'manual').catch(() => {}))
    void Promise.all(runs).then(() => {
      if (seq.current === mine) setPress((p) => (p ? { ...p, asked: true } : p))
    })
  }
  return { refreshAll, spinning: press !== null }
}

/**
 * What a resize stores. A grid narrowed by the panel or the window shows fewer
 * columns than the tile has: a drag that did not change them keeps the stored
 * ones, so changing only the height there does not shrink it for good.
 */
export function tileSpanToStore(stored: TileSpan, shownBefore: TileSpan, shown: TileSpan): TileSpan {
  return { cols: shown.cols === shownBefore.cols ? stored.cols : shown.cols, rows: shown.rows }
}

/**
 * Pointer-event resize against the grid: the span shown while dragging, then
 * one update on release, which makes the tile Custom. The tile keeps the new
 * span until the tiles query brings it, so it never snaps back in between.
 */
function useTileResize(
  tiles: TileView[],
  gridRef: React.RefObject<HTMLDivElement | null>,
  columns: number,
  commit: (tileId: string, span: TileSpan, onError: () => void) => void
) {
  const [resize, setResize] = useState<{ tileId: string; span: TileSpan; dragging: boolean } | null>(null)
  const shownSpan = useCallback((view: TileView): TileSpan => {
    const span = tileSpan(view.tile)
    return { cols: Math.min(span.cols, columns), rows: span.rows }
  }, [columns])

  useEffect(() => {
    if (!resize || resize.dragging) return
    const stored = tiles.find((view) => view.tile.id === resize.tileId)?.tile
    if (!stored || (stored.size === 'custom' && stored.customSpan?.cols === resize.span.cols && stored.customSpan?.rows === resize.span.rows)) setResize(null)
  }, [resize, tiles])

  const finish = useCallback((view: TileView, span: TileSpan, before: TileSpan) => {
    const tileId = view.tile.id
    if (span.cols === before.cols && span.rows === before.rows) return setResize(null)
    const stored = tileSpanToStore(tileSpan(view.tile), before, span)
    setResize({ tileId, span: stored, dragging: false })
    commit(tileId, stored, () => setResize(null))
  }, [commit])

  // A drag still going when the view goes: its listeners and cursor with it, and nothing committed.
  const stopDrag = useRef<(() => void) | null>(null)
  useEffect(() => () => stopDrag.current?.(), [])

  const onPointerDown = useCallback((event: React.PointerEvent, tileId: string) => {
    const view = tiles.find((t) => t.tile.id === tileId)
    const node = gridRef.current
    if (!view || !node) return
    event.preventDefault()
    event.stopPropagation()
    // Captured, so a drag over a tile's frame still reaches this window.
    event.currentTarget.setPointerCapture?.(event.pointerId)
    const style = getComputedStyle(node)
    const width = node.clientWidth - (parseFloat(style.paddingLeft) || 0) - (parseFloat(style.paddingRight) || 0)
    const start = shownSpan(view)
    const [startX, startY] = [event.clientX, event.clientY]
    let span = start
    setResize({ tileId, span, dragging: true })
    const move = (e: PointerEvent): void => {
      const next = snapTileSpan(start, e.clientX - startX, e.clientY - startY, { width, columns, rowHeight: ROW_HEIGHT, gap: GAP })
      if (next.cols === span.cols && next.rows === span.rows) return
      span = next
      setResize({ tileId, span, dragging: true })
    }
    const stop = (): void => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      window.removeEventListener('pointercancel', cancel)
      document.body.style.cursor = ''
      stopDrag.current = null
    }
    const up = (): void => {
      stop()
      finish(view, span, start)
    }
    const cancel = (): void => {
      stop()
      setResize(null)
    }
    stopDrag.current = stop
    document.body.style.cursor = 'nwse-resize'
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
    window.addEventListener('pointercancel', cancel)
  }, [tiles, gridRef, columns, shownSpan, finish])

  const onResizeBy = useCallback((tileId: string, cols: number, rows: number) => {
    const view = tiles.find((t) => t.tile.id === tileId)
    if (!view) return
    const shown = shownSpan(view)
    const start = resize?.tileId === tileId ? { cols: Math.min(resize.span.cols, columns), rows: resize.span.rows } : shown
    const clamp = (value: number, min: number, max: number): number => Math.max(min, Math.min(max, value))
    finish(view, {
      cols: clamp(start.cols + cols, Math.min(TILE_SPAN_LIMITS.minCols, columns), columns),
      rows: clamp(start.rows + rows, TILE_SPAN_LIMITS.minRows, TILE_SPAN_LIMITS.maxRows)
    }, start)
  }, [tiles, resize, columns, shownSpan, finish])

  return {
    spanOf: (view: TileView): TileSpan => (resize?.tileId === view.tile.id ? { cols: Math.min(resize.span.cols, columns), rows: resize.span.rows } : shownSpan(view)),
    onPointerDown,
    onResizeBy
  }
}

/**
 * Focus, selection and the chat panel's context (README D3, D7, D12). A click
 * focuses a tile; the panel's agent is the focused tile's, so focusing a tile
 * of the same agent changes only the context and one of another agent switches
 * the panel's chat. A removed chip stays removed until the focus or the
 * selection changes, or the user presses Ask on the tile again.
 */
/**
 * The focused tile and the panel's agent per dashboard, for this window
 * session: leaving the dashboard (to Chats, say) and coming back finds the
 * panel on the same chat, as it was left, instead of an open panel asking for
 * a click.
 */
/** The tiles' web contexts with one replaced; the same object when nothing changed, so nothing re-renders. */
function withWebContext(all: Record<string, WebTileContext>, tileId: string, web: WebTileContext): Record<string, WebTileContext> {
  const prev = all[tileId]
  if (
    prev &&
    prev.summary === web.summary &&
    prev.selection.join('\u0000') === web.selection.join('\u0000') &&
    (prev.selectedText ?? '') === (web.selectedText ?? '')
  ) return all
  return { ...all, [tileId]: web }
}

const panelFocusByDashboard = new Map<string, { focusedTileId: string | null; panelAgentId: string | null }>()

function useDashboardChat(dashboardId: string | null, dashboardName: string, tiles: TileView[], panelOpen: boolean) {
  const rememberedFor = (id: string | null) => {
    const remembered = id ? panelFocusByDashboard.get(id) : undefined
    return { dashboardId: id, focusedTileId: remembered?.focusedTileId ?? null, panelAgentId: remembered?.panelAgentId ?? null }
  }
  // Focus is held with the dashboard it belongs to. Another dashboard's
  // focus is replaced in the same render that brings the new dashboard, so
  // the panel never sees the new dashboard paired with the old agent (and
  // never opens a chat for that pair).
  const [focusState, setFocusState] = useState(() => rememberedFor(dashboardId))
  const [selections, setSelections] = useState<Record<string, string[]>>({})
  const [webContexts, setWebContexts] = useState<Record<string, WebTileContext>>({})
  const [removed, setRemoved] = useState<string | null>(null)
  const [pendingPrompt, setPendingPrompt] = useState<PendingPrompt | null>(null)
  const promptSeq = useRef(0)
  /** Bumped when the panel's composer gains focus: the focused tile's page is asked for its context. */
  const [collectRequest, setCollectRequest] = useState(0)
  const setPanelOpen = useUIStore((s) => s.setDashboardPanelOpen)

  let effective = focusState
  if (focusState.dashboardId !== dashboardId) {
    effective = rememberedFor(dashboardId)
    // Adjusting state while rendering: React re-renders before committing.
    setFocusState(effective)
    setSelections({})
    setWebContexts({})
    setRemoved(null)
    setPendingPrompt(null)
  }
  const { focusedTileId, panelAgentId } = effective
  const setFocusedTileId = useCallback((id: string | null) => setFocusState((s) => ({ ...s, focusedTileId: id })), [])
  const setPanelAgentId = useCallback((id: string | null) => setFocusState((s) => ({ ...s, panelAgentId: id })), [])

  // A suggested question is for one agent's chat: focusing another agent drops it.
  useEffect(() => {
    setPendingPrompt((p) => (p && p.agentId !== panelAgentId ? null : p))
  }, [panelAgentId])

  // setContext from a busy page arrives far faster than anyone reads it:
  // the latest per tile, at most every CONTEXT_FLUSH_MS.
  const contextQueue = useRef<ReturnType<typeof coalescePerKey<WebTileContext>> | null>(null)
  if (!contextQueue.current) {
    contextQueue.current = coalescePerKey<WebTileContext>((tileId, web) =>
      // A setContext says nothing about the text selection: the last collected one stays.
      setWebContexts((all) => withWebContext(all, tileId, { ...web, selectedText: web.selectedText ?? all[tileId]?.selectedText }))
    )
  }
  useEffect(() => {
    const queue = contextQueue.current
    return () => queue?.cancel()
  }, [dashboardId])

  useEffect(() => {
    if (dashboardId) panelFocusByDashboard.set(dashboardId, { focusedTileId, panelAgentId })
  }, [dashboardId, focusedTileId, panelAgentId])

  const focus = useCallback((view: TileView) => {
    setFocusedTileId(view.tile.id)
    if (view.component && view.state !== 'agent_missing' && view.state !== 'wrong_server') setPanelAgentId(view.component.agentId)
  }, [setFocusedTileId, setPanelAgentId])

  const focused = tiles.find((view) => view.tile.id === focusedTileId) ?? null
  const result = useTileResult(focused ? focused.tile.id : null)
  const focusedAgentId = focused?.component?.agentId ?? null
  const context = useMemo<DashboardContext | null>(() => {
    if (!dashboardId || !focused || !focused.component || focusedAgentId !== panelAgentId) return null
    return buildDashboardContext({
      dashboardId,
      dashboardName,
      focused,
      tiles,
      result: result.data ?? null,
      selection: selections[focused.tile.id] ?? [],
      web: webContexts[focused.tile.id] ?? null
    })
  }, [dashboardId, dashboardName, focused, focusedAgentId, panelAgentId, tiles, result.data, selections, webContexts])
  const identity = context ? contextIdentity(context.focused.tileId, context.focused.selection) : null
  const sendable = context && identity !== removed ? context : null
  const latest = useRef(sendable)
  latest.current = sendable
  // Removal is for what the chip showed then: coming back to that tile later brings the chip back.
  useEffect(() => {
    if (identity !== null) setRemoved((r) => (r === identity ? r : null))
  }, [identity])

  const chip: ContextChip = !context
    ? { kind: 'none' }
    : identity === removed
      ? { kind: 'removed', title: context.focused.title, onRestore: () => setRemoved(null) }
      : { kind: 'context', context, onRemove: () => setRemoved(identity) }

  const ask = useCallback((view: TileView) => {
    focus(view)
    setPanelOpen(true)
  }, [focus, setPanelOpen])

  const sendPrompt = useCallback((view: TileView, prompt: ComponentPrompt) => {
    if (!view.component) return
    ask(view)
    // The user pressed it: the context goes with it even if the chip was removed.
    setRemoved(null)
    promptSeq.current += 1
    setPendingPrompt({ agentId: view.component.agentId, prompt: prompt.prompt, seq: promptSeq.current })
  }, [ask])

  // A page's cinna.ask (D14): into the composer of the tile's agent's chat, for the user to send or not.
  const fillComposer = useCallback((view: TileView, text: string) => {
    if (!view.component || view.state === 'agent_missing') return
    ask(view)
    promptSeq.current += 1
    setPendingPrompt({ agentId: view.component.agentId, prompt: text, seq: promptSeq.current, fill: true })
  }, [ask])

  const chatFor = (view: TileView): TileChat => ({
    focused: view.tile.id === focusedTileId,
    panelClosed: !panelOpen,
    selected: selections[view.tile.id] ?? [],
    onFocus: () => focus(view),
    onPick: (key, additive) =>
      setSelections((all) => {
        const current = all[view.tile.id] ?? []
        const next = additive ? (current.includes(key) ? current.filter((k) => k !== key) : [...current, key]) : [key]
        return { ...all, [view.tile.id]: next }
      }),
    onClearSelection: () => setSelections((all) => ({ ...all, [view.tile.id]: [] })),
    onContext: (web) => contextQueue.current?.push(view.tile.id, web),
    onCollected: (collected) =>
      setWebContexts((all) => withWebContext(all, view.tile.id, webContextFromCollected(collected, all[view.tile.id] ?? null))),
    // The focused tile's only: the others' pages are not asked, and do not re-render for it.
    collectRequest: view.tile.id === focusedTileId ? collectRequest : 0,
    // Asking about the tile says to send it, even if its chip was removed. Only the user's own Ask:
    // a page's cinna.ask (onFill) needs no gesture, and must not bring back what the user took off.
    onAsk: () => { setRemoved(null); ask(view) },
    onPrompt: (prompt) => sendPrompt(view, prompt),
    onFill: (text) => fillComposer(view, text)
  })

  const panelAgentView = tiles.find((view) => view.component?.agentId === panelAgentId)
  const panelAgentName = panelAgentView?.component?.agentName ?? panelAgentView?.agentName ?? ''
  const starters = focused?.component && focusedAgentId === panelAgentId ? enabledTilePrompts(focused.component.prompts, focused.tile.promptOverride) : []

  return {
    focusedTileId,
    focus,
    chatFor,
    panelAgentId,
    panelAgentName,
    chip,
    getContext: () => latest.current,
    starters,
    onStarter: (prompt: ComponentPrompt) => { if (focused) sendPrompt(focused, prompt) },
    pendingPrompt,
    onPromptSent: (seq: number) => setPendingPrompt((p) => (p && p.seq === seq ? null : p)),
    onComposerFocus: () => setCollectRequest((n) => n + 1)
  }
}

/** The dashboard on screen: its header, its grid of tiles, or an empty state that says where tiles come from. */
export function DashboardView(): React.JSX.Element {
  const dashboardId = useUIStore((s) => s.activeDashboardId)
  const setActiveDashboardId = useUIStore((s) => s.setActiveDashboardId)
  const list = useDashboardList()
  const tilesQuery = useDashboardTiles(dashboardId)
  const moveTile = useMoveTile()
  const resizeTile = useUpdateTile()
  const deleteDashboard = useDeleteDashboard()
  const [editMode, setEditMode] = useState(false)
  const [menu, setMenu] = useState<{ x: number; y: number; anchor: HTMLElement } | null>(null)
  const [renaming, setRenaming] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [columns, setColumns] = useState(12)
  const gridRef = useRef<HTMLDivElement>(null)
  // Grid plus panel: the panel's width is clamped to it on every resize.
  const [rowWidth, setRowWidth] = useState<number | null>(null)
  const rowObserver = useRef<ResizeObserver | null>(null)
  const rowRef = useCallback((node: HTMLDivElement | null) => {
    rowObserver.current?.disconnect()
    rowObserver.current = null
    if (!node || typeof ResizeObserver === 'undefined') return
    rowObserver.current = new ResizeObserver(([entry]) => setRowWidth(Math.round(entry.contentRect.width)))
    rowObserver.current.observe(node)
  }, [])
  const onVisibilityChange = useTileLease(dashboardId)

  const resetMove = moveTile.reset
  const resetResize = resizeTile.reset
  useEffect(() => {
    setEditMode(false)
    resetMove()
    resetResize()
  }, [dashboardId, resetMove, resetResize])

  useEffect(() => {
    const node = gridRef.current
    if (!node || typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(([entry]) => setColumns(columnsFor(entry.contentRect.width)))
    observer.observe(node)
    return () => observer.disconnect()
  }, [tilesQuery.data])

  const tiles = useMemo(() => tilesQuery.data?.tiles ?? [], [tilesQuery.data])
  const onDrop = useCallback((tileId: string, toIndex: number) => moveTile.mutate({ tileId, toIndex }), [moveTile])
  const { ordered, draggingId, onHandlePointerDown } = useTileDrag(tiles, onDrop)
  const commitResize = useCallback((tileId: string, span: TileSpan, onError: () => void) => {
    resizeTile.mutate({ tileId, size: 'custom', customSpan: span }, { onError })
  }, [resizeTile])
  const resize = useTileResize(tiles, gridRef, columns, commitResize)

  const dashboard = tilesQuery.data?.dashboard ?? list.data?.find((d) => d.id === dashboardId) ?? null
  const panelOpen = useUIStore((s) => s.dashboardPanelOpen)
  const setPanelOpen = useUIStore((s) => s.setDashboardPanelOpen)
  const panelPresence = usePanelPresence(panelOpen)
  const { refreshAll, spinning } = useRefreshAll(tiles, dashboardId)
  const chatRunning = useDashboardChatRunning(dashboardId)
  const chat = useDashboardChat(dashboardId, dashboard?.name ?? '', tiles, panelOpen)
  const { focus } = chat
  const tilesRef = useRef(tiles)
  tilesRef.current = tiles

  // A click inside a tile's frame never reaches this document; the window
  // losing focus to that frame is the click, so it focuses the tile.
  useEffect(() => {
    const onBlur = (): void => {
      setTimeout(() => {
        const active = document.activeElement
        if (!(active instanceof HTMLIFrameElement)) return
        const tileId = (active.closest('[data-tile-id]') as HTMLElement | null)?.dataset.tileId
        const view = tilesRef.current.find((t) => t.tile.id === tileId)
        if (view) focus(view)
      }, 0)
    }
    window.addEventListener('blur', onBlur)
    return () => window.removeEventListener('blur', onBlur)
  }, [focus])

  if (!dashboardId || (!dashboard && !tilesQuery.isPending)) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-2 pt-[var(--topbar-h)] text-center">
        <LayoutDashboard size={22} className="text-[var(--color-text-muted)]" />
        <p className="text-xs text-[var(--color-text-secondary)]">
          {list.data && list.data.length > 0 ? 'Pick a dashboard in the sidebar.' : 'No dashboards yet. Make one with + in the sidebar.'}
        </p>
      </div>
    )
  }

  const togglePanel = (): void => {
    if (!panelOpen && !chat.panelAgentId) {
      // Opened from the header: the first tile whose agent is here, so the panel has someone to ask.
      const first = tiles.find((view) => view.component && view.state !== 'agent_missing')
      if (first) focus(first)
    }
    setPanelOpen(!panelOpen)
  }

  return (
    // Clip, not hidden: the chat card starts its slide past the window's edge with its composer taking focus,
    // and the browser would scroll the whole app sideways to reveal it. The margin is the shell's padding, for the card's shadow.
    <div ref={rowRef} className="relative flex min-w-0 flex-1 overflow-clip [overflow-clip-margin:0.5rem]">
    <div className="flex min-w-0 flex-1 flex-col overflow-y-auto overflow-x-hidden pt-[var(--topbar-h)] [scrollbar-gutter:stable]">
      {/* The agent page header's padding, alignment and title size (LocalAgentPage). */}
      <header className="flex items-start gap-2 px-6 pb-3 pt-6">
        <div className="min-w-0 flex-1">
          <h1 className="truncate text-xl font-semibold text-[var(--color-text)]">{dashboard?.name ?? ''}</h1>
          {/* A failed move or resize says so under the title; the next one clears it (ux rule 6). */}
          {moveTile.error && (
            <p role="alert" className="mt-0.5 text-xs text-[var(--color-danger)]">
              The tile could not be moved: {unwrapIpcError(moveTile.error, 'try again.')}
            </p>
          )}
          {resizeTile.error && (
            <p role="alert" className="mt-0.5 text-xs text-[var(--color-danger)]">
              The tile could not be resized: {unwrapIpcError(resizeTile.error, 'try again.')}
            </p>
          )}
        </div>
        {/* Edit layout starts in the ⋯ menu; this is its way out, for as long as it lasts. Each change is stored as it is made. */}
        {editMode && (
          <button type="button" className={HEADER_BUTTON} onClick={() => setEditMode(false)}>
            <Check size={12} />
            Save layout
          </button>
        )}
        {tiles.length > 0 && (
          <button type="button" className={`${HEADER_BUTTON} ${HEADER_TOGGLE_PRESSED} ${chatRunning ? 'app-button-running' : ''}`} aria-pressed={panelOpen} aria-busy={chatRunning || undefined} onClick={togglePanel} title={panelOpen ? 'Close the chat panel' : chatRunning ? 'A chat on this dashboard is running' : 'Open the chat panel'}>
            <MessageSquare size={12} />
            Chat
          </button>
        )}
        {tiles.length > 0 && (
          // Accent while it runs, so reduced motion, which stops the spin, still shows the press.
          <button type="button" className={HEADER_ICON_BUTTON} onClick={refreshAll} title={spinning ? 'Refreshing…' : 'Recompute every tile now'} aria-label="Refresh all tiles" aria-busy={spinning || undefined}>
            <RefreshCw size={14} className={spinning ? 'animate-spin text-[var(--color-accent)] motion-reduce:animate-none' : undefined} />
          </button>
        )}
        <button
          type="button"
          aria-label={`Actions for ${dashboard?.name ?? 'dashboard'}`}
          className={HEADER_ICON_BUTTON}
          onClick={(event) => {
            const rect = event.currentTarget.getBoundingClientRect()
            setMenu({ x: rect.right - 176, y: rect.bottom + 4, anchor: event.currentTarget })
          }}
        >
          <MoreHorizontal size={14} />
        </button>
      </header>

      {tilesQuery.isError ? (
        <p role="alert" className="px-6 text-xs text-[var(--color-danger)]">{tilesQuery.error.message}</p>
      ) : tiles.length === 0 && !tilesQuery.isPending ? (
        <div className="mx-6 mt-6 rounded-lg border border-dashed border-[var(--color-border)] px-6 py-8 text-center">
          <p className="text-xs font-medium text-[var(--color-text)]">This dashboard is empty</p>
          <p className="mx-auto mt-1.5 max-w-md text-[11px] text-[var(--color-text-secondary)]">
            Agents build components in their folders — ask one for “a view of my open deals I can keep on a dashboard”. Then open
            that agent’s Dashboards tab and press Add to dashboard.
          </p>
        </div>
      ) : (
        <div
          ref={gridRef}
          data-testid="dashboard-grid"
          className="grid px-6 pb-6"
          style={{ gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))`, gridAutoRows: `${ROW_HEIGHT}px`, gap: `${GAP}px` }}
        >
          {ordered.map((view) => {
            return (
              <Tile
                key={view.tile.id}
                view={view}
                dashboardName={dashboard?.name ?? ''}
                span={resize.spanOf(view)}
                editMode={editMode}
                dragging={draggingId === view.tile.id}
                onHandlePointerDown={onHandlePointerDown}
                onEditLayout={() => setEditMode(true)}
                onResizePointerDown={resize.onPointerDown}
                onResizeBy={resize.onResizeBy}
                onVisibilityChange={onVisibilityChange}
                chat={chat.chatFor(view)}
              />
            )
          })}
        </div>
      )}

      {menu && dashboard && (
        <ContextMenu x={menu.x} y={menu.y} anchor={menu.anchor} label={`Actions for ${dashboard.name}`} onClose={() => setMenu(null)}>
          <button type="button" role="menuitem" className={CONTEXT_MENU_ITEM} onClick={() => { setMenu(null); setRenaming(true) }}><Pencil size={12} />Rename</button>
          {tiles.length > 0 && (
            <button type="button" role="menuitem" className={CONTEXT_MENU_ITEM} onClick={() => { setMenu(null); setEditMode((v) => !v) }}>
              {editMode ? <Check size={12} /> : <LayoutGrid size={12} />}
              {editMode ? 'Save layout' : 'Edit layout'}
            </button>
          )}
          <div className="my-1 border-t border-[var(--color-border)]" />
          <button type="button" role="menuitem" className={`${CONTEXT_MENU_ITEM} text-[var(--color-danger)]`} onClick={() => { setMenu(null); setConfirmDelete(true) }}><Trash2 size={12} />Delete</button>
        </ContextMenu>
      )}
      {renaming && dashboard && <RenameDashboardDialog dashboard={dashboard} onClose={() => setRenaming(false)} />}
      {confirmDelete && dashboard && (
        <ConfirmDialog
          title={`Delete ${dashboard.name}`}
          body={`Delete ${dashboard.name} and its ${tiles.length === 1 ? 'tile' : `${tiles.length} tiles`}? The components stay in their agents’ folders; you can add them to another dashboard.`}
          confirmLabel="Delete dashboard"
          pendingLabel="Deleting…"
          pending={deleteDashboard.isPending}
          error={deleteDashboard.error?.message ?? null}
          onConfirm={() => deleteDashboard.mutate(dashboard.id, { onSuccess: () => { setConfirmDelete(false); setActiveDashboardId(null) } })}
          onClose={() => { if (!deleteDashboard.isPending) { deleteDashboard.reset(); setConfirmDelete(false) } }}
        />
      )}
    </div>
    {panelPresence.mounted && dashboardId && (
      <DashboardChatPanel
        collapsed={panelPresence.collapsed}
        sliding={panelPresence.sliding}
        dashboardId={dashboardId}
        agentId={chat.panelAgentId}
        agentName={chat.panelAgentName}
        chip={chat.chip}
        getContext={chat.getContext}
        starters={chat.starters}
        onStarter={chat.onStarter}
        pendingPrompt={chat.pendingPrompt}
        onPromptSent={chat.onPromptSent}
        onClose={() => setPanelOpen(false)}
        onComposerFocus={chat.onComposerFocus}
        rowWidth={rowWidth}
      />
    )}
    </div>
  )
}
