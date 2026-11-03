import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { LayoutDashboard, MessageSquare, MoreHorizontal, RefreshCw } from 'lucide-react'
import { DASHBOARD_LEASE_RENEW_MS, TILE_SIZE_SPANS, type ComponentPrompt, type DashboardContext, type TileView } from '../../../../shared/dashboards'
import { useDashboardList, useDashboardTiles, useDeleteDashboard, useMoveTile, useTileResult } from '../../hooks/useDashboards'
import { useUIStore } from '../../stores/ui.store'
import { unwrapIpcError } from '../../utils/ipcError'
import { ContextMenu, CONTEXT_MENU_ITEM } from '../ui/ContextMenu'
import { ConfirmDialog } from './DashboardDialog'
import { RenameDashboardDialog } from './DashboardsList'
import { Tile, type TileChat } from './Tile'
import { DashboardChatPanel, type ContextChip, type PendingPrompt } from './DashboardChatPanel'
import { buildDashboardContext, coalescePerKey, contextIdentity, type WebTileContext } from './dashboardContext'

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
  'ambient-button flex items-center gap-1.5 rounded-md border border-[var(--color-border)] px-3 py-1.5 text-xs font-medium text-[var(--color-text)] transition-colors hover:bg-[var(--color-bg-hover)] disabled:opacity-50'
/** The agent page header's ⋯ button (AgentActionsMenu). */
const HEADER_ICON_BUTTON =
  'flex items-center rounded-md border border-[var(--color-border)] px-1.5 py-1.5 text-[var(--color-text-secondary)] transition-colors hover:bg-[var(--color-bg-hover)] hover:text-[var(--color-text)]'

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

/**
 * Focus, selection and the chat panel's context (README D3, D7, D12). A click
 * focuses a tile; the panel's agent is the focused tile's, so focusing a tile
 * of the same agent changes only the context and one of another agent switches
 * the panel's chat. A removed chip stays removed until the focus or the
 * selection changes.
 */
/**
 * The focused tile and the panel's agent per dashboard, for this window
 * session: leaving the dashboard (to Chats, say) and coming back finds the
 * panel on the same chat, as it was left, instead of an open panel asking for
 * a click.
 */
const panelFocusByDashboard = new Map<string, { focusedTileId: string | null; panelAgentId: string | null }>()

function useDashboardChat(dashboardId: string | null, dashboardName: string, tiles: TileView[]) {
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
      setWebContexts((all) => {
        const prev = all[tileId]
        if (prev && prev.summary === web.summary && prev.selection.join('\u0000') === web.selection.join('\u0000')) return all
        return { ...all, [tileId]: web }
      })
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
    if (view.component && view.state !== 'agent_missing') setPanelAgentId(view.component.agentId)
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

  const chatFor = (view: TileView): TileChat => ({
    focused: view.tile.id === focusedTileId,
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
    onAsk: () => ask(view),
    onPrompt: (prompt) => sendPrompt(view, prompt)
  })

  const panelAgentName = tiles.find((view) => view.component?.agentId === panelAgentId)?.component?.agentName ?? ''
  const starters = focused && focusedAgentId === panelAgentId ? (focused.component?.prompts ?? []) : []

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
    onPromptSent: (seq: number) => setPendingPrompt((p) => (p && p.seq === seq ? null : p))
  }
}

/** The dashboard on screen: its header, its grid of tiles, or an empty state that says where tiles come from. */
export function DashboardView(): React.JSX.Element {
  const dashboardId = useUIStore((s) => s.activeDashboardId)
  const setActiveDashboardId = useUIStore((s) => s.setActiveDashboardId)
  const list = useDashboardList()
  const tilesQuery = useDashboardTiles(dashboardId)
  const moveTile = useMoveTile()
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
  useEffect(() => {
    setEditMode(false)
    resetMove()
  }, [dashboardId, resetMove])

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

  const dashboard = tilesQuery.data?.dashboard ?? list.data?.find((d) => d.id === dashboardId) ?? null
  const chat = useDashboardChat(dashboardId, dashboard?.name ?? '', tiles)
  const panelOpen = useUIStore((s) => s.dashboardPanelOpen)
  const setPanelOpen = useUIStore((s) => s.setDashboardPanelOpen)
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

  const refreshAll = (): void => {
    for (const view of tiles) if (view.state === 'ok') void window.api.dashboards.ensureFresh(view.tile.id, 'manual').catch(() => {})
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
    <div ref={rowRef} className="relative flex min-w-0 flex-1">
    <div className="flex min-w-0 flex-1 flex-col overflow-y-auto overflow-x-hidden pt-[var(--topbar-h)] [scrollbar-gutter:stable]">
      {/* The agent page header's padding, alignment and title size (LocalAgentPage). */}
      <header className="flex items-start gap-2 px-6 pb-3 pt-6">
        <div className="min-w-0 flex-1">
          <h1 className="truncate text-xl font-semibold text-[var(--color-text)]">{dashboard?.name ?? ''}</h1>
          {/* A failed move says so under the title; the next move clears it (ux rule 6). */}
          {moveTile.error && (
            <p role="alert" className="mt-0.5 text-xs text-[var(--color-danger)]">
              The tile could not be moved: {unwrapIpcError(moveTile.error, 'try again.')}
            </p>
          )}
        </div>
        {tiles.length > 0 && (
          // Wide enough for both labels: pressing it never shrinks it under the pointer.
          <button type="button" className={`${HEADER_BUTTON} min-w-[6.5rem] justify-center`} aria-pressed={editMode} onClick={() => setEditMode((v) => !v)}>
            {editMode ? 'Done' : 'Edit layout'}
          </button>
        )}
        {tiles.length > 0 && (
          <button type="button" className={HEADER_BUTTON} aria-pressed={panelOpen} onClick={togglePanel} title={panelOpen ? 'Close the chat panel' : 'Chat with the focused tile’s agent'}>
            <MessageSquare size={12} />
            Chat
          </button>
        )}
        {tiles.length > 0 && (
          <button type="button" className={HEADER_BUTTON} onClick={refreshAll} title="Recompute every tile now">
            <RefreshCw size={12} />
            Refresh
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
            const preset = TILE_SIZE_SPANS[view.tile.size]
            return (
              <Tile
                key={view.tile.id}
                view={view}
                dashboardName={dashboard?.name ?? ''}
                span={{ cols: Math.min(preset.cols, columns), rows: preset.rows }}
                editMode={editMode}
                dragging={draggingId === view.tile.id}
                onHandlePointerDown={onHandlePointerDown}
                onVisibilityChange={onVisibilityChange}
                chat={chat.chatFor(view)}
              />
            )
          })}
        </div>
      )}

      {menu && dashboard && (
        <ContextMenu x={menu.x} y={menu.y} anchor={menu.anchor} label={`Actions for ${dashboard.name}`} onClose={() => setMenu(null)}>
          <button type="button" role="menuitem" className={CONTEXT_MENU_ITEM} onClick={() => { setMenu(null); setRenaming(true) }}>Rename…</button>
          <div className="my-1 border-t border-[var(--color-border)]" />
          <button type="button" role="menuitem" className={`${CONTEXT_MENU_ITEM} text-[var(--color-danger)]`} onClick={() => { setMenu(null); setConfirmDelete(true) }}>Delete…</button>
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
    {panelOpen && dashboardId && (
      <DashboardChatPanel
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
        rowWidth={rowWidth}
      />
    )}
    </div>
  )
}
