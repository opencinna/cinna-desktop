import { useEffect, useRef, useState } from 'react'
import { LayoutDashboard, Plus } from 'lucide-react'
import type { DashboardDto } from '../../../../shared/dashboards'
import { useCreateDashboard, useDashboardList, useDeleteDashboard, useRenameDashboard } from '../../hooks/useDashboards'
import { useUIStore } from '../../stores/ui.store'
import { ContextMenu, CONTEXT_MENU_ITEM } from '../ui/ContextMenu'
import { ConfirmDialog, DashboardDialog, DIALOG_INPUT, DIALOG_PRIMARY } from './DashboardDialog'

/** Rename a dashboard: one field, Enter saves, closes on success only. */
export function RenameDashboardDialog({ dashboard, onClose }: { dashboard: DashboardDto; onClose: () => void }): React.JSX.Element {
  const rename = useRenameDashboard()
  const inputRef = useRef<HTMLInputElement>(null)
  const [name, setName] = useState(dashboard.name)
  useEffect(() => inputRef.current?.select(), [])
  return (
    <DashboardDialog label="Rename dashboard" pending={rename.isPending} onClose={onClose} initialFocusRef={inputRef} width="max-w-sm">
      <form onSubmit={(e) => { e.preventDefault(); if (name.trim()) rename.mutate({ dashboardId: dashboard.id, name }, { onSuccess: onClose }) }}>
        <label htmlFor="rename-dashboard" className="text-sm font-semibold text-[var(--color-text)]">Rename dashboard</label>
        <input id="rename-dashboard" ref={inputRef} className={`${DIALOG_INPUT} mt-3`} value={name} maxLength={80} onChange={(e) => setName(e.target.value)} />
        <div className="mt-4 flex justify-end gap-2">
          <button type="button" className="px-3 py-1.5 text-xs font-medium text-[var(--color-text-muted)] hover:text-[var(--color-text-secondary)]" disabled={rename.isPending} onClick={onClose}>Cancel</button>
          <button type="submit" className={DIALOG_PRIMARY} disabled={rename.isPending || !name.trim()}>{rename.isPending ? 'Saving…' : 'Save'}</button>
        </div>
        {rename.error && <p role="alert" className="mt-3 text-xs text-[var(--color-danger)]">{rename.error.message}</p>}
      </form>
    </DashboardDialog>
  )
}

/** New dashboard asks for a name only (ux rule 3), and lands on the dashboard. */
function NewDashboardDialog({ onClose }: { onClose: () => void }): React.JSX.Element {
  const create = useCreateDashboard()
  const inputRef = useRef<HTMLInputElement>(null)
  const [name, setName] = useState('')
  const submit = (): void => {
    if (!name.trim() || create.isPending) return
    create.mutate(name, {
      onSuccess: (dashboard) => {
        const ui = useUIStore.getState()
        ui.setActiveDashboardId(dashboard.id)
        ui.setActiveView('dashboard')
        onClose()
      }
    })
  }
  return (
    <DashboardDialog label="New dashboard" pending={create.isPending} onClose={onClose} initialFocusRef={inputRef} width="max-w-sm">
      <form onSubmit={(e) => { e.preventDefault(); submit() }}>
        <label htmlFor="new-dashboard-name" className="text-sm font-semibold text-[var(--color-text)]">New dashboard</label>
        <input id="new-dashboard-name" ref={inputRef} className={`${DIALOG_INPUT} mt-3`} placeholder="Name, e.g. Sales overview" value={name} maxLength={80} onChange={(e) => setName(e.target.value)} />
        <div className="mt-4 flex justify-end gap-2">
          <button type="button" className="px-3 py-1.5 text-xs font-medium text-[var(--color-text-muted)] hover:text-[var(--color-text-secondary)]" disabled={create.isPending} onClick={onClose}>Cancel</button>
          <button type="submit" className={DIALOG_PRIMARY} disabled={create.isPending || !name.trim()}>{create.isPending ? 'Creating…' : 'Create'}</button>
        </div>
        {create.error && <p role="alert" className="mt-3 text-xs text-[var(--color-danger)]">{create.error.message}</p>}
      </form>
    </DashboardDialog>
  )
}

/** The Dashboards tab: one row per dashboard (rename and delete on right-click) and New dashboard. */
export function DashboardsList(): React.JSX.Element {
  const { data: dashboards, isLoading } = useDashboardList()
  const activeView = useUIStore((s) => s.activeView)
  const activeDashboardId = useUIStore((s) => s.activeDashboardId)
  const setActiveDashboardId = useUIStore((s) => s.setActiveDashboardId)
  const setActiveView = useUIStore((s) => s.setActiveView)
  const deleteDashboard = useDeleteDashboard()
  const [creating, setCreating] = useState(false)
  const [menu, setMenu] = useState<{ x: number; y: number; anchor: HTMLElement; dashboard: DashboardDto } | null>(null)
  const [renaming, setRenaming] = useState<DashboardDto | null>(null)
  const [deleting, setDeleting] = useState<DashboardDto | null>(null)

  // A dashboard is a screen to look at: opening the tab shows the first one.
  useEffect(() => {
    if (activeView !== 'dashboard' || !dashboards || dashboards.length === 0) return
    if (!activeDashboardId || !dashboards.some((d) => d.id === activeDashboardId)) setActiveDashboardId(dashboards[0].id)
  }, [activeView, dashboards, activeDashboardId, setActiveDashboardId])

  const open = (id: string): void => {
    setActiveDashboardId(id)
    setActiveView('dashboard')
  }

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center justify-between px-3 pb-1 pt-1">
        <span className="text-[10px] uppercase tracking-wide text-[var(--color-text-muted)]">Dashboards</span>
        <button
          type="button"
          onClick={() => setCreating(true)}
          className="rounded p-1 text-[var(--color-text-muted)] transition-colors hover:bg-[var(--color-bg-hover)] hover:text-[var(--color-text)]"
          title="New dashboard"
          aria-label="New dashboard"
        >
          <Plus size={14} />
        </button>
      </div>
      <div className="app-scroll-fade flex-1 overflow-y-auto">
        {isLoading ? (
          <div className="px-2.5 py-2 text-xs text-[var(--color-text-muted)]">Loading...</div>
        ) : !dashboards || dashboards.length === 0 ? (
          <div className="px-2.5 py-6 text-center text-xs text-[var(--color-text-muted)]">No dashboards yet — click + to make one</div>
        ) : (
          <div className="space-y-px px-1.5 py-1">
            {dashboards.map((dashboard) => {
              const active = activeView === 'dashboard' && activeDashboardId === dashboard.id
              return (
                <button
                  key={dashboard.id}
                  type="button"
                  onClick={() => open(dashboard.id)}
                  onContextMenu={(event) => {
                    event.preventDefault()
                    setMenu({ x: event.clientX, y: event.clientY, anchor: event.currentTarget, dashboard })
                  }}
                  aria-current={active ? 'page' : undefined}
                  aria-label={`${dashboard.name}, ${dashboard.tileCount === 1 ? '1 tile' : `${dashboard.tileCount} tiles`}`}
                  className={`flex w-full items-center gap-1.5 rounded-md px-2.5 py-1.5 text-left text-xs transition-colors ${
                    active ? 'app-nav-active text-[var(--color-text)]' : 'text-[var(--color-text-secondary)] hover:bg-[var(--color-bg-hover)]'
                  }`}
                >
                  <LayoutDashboard size={12} className="shrink-0 text-[var(--color-text-muted)]" />
                  <span className="min-w-0 flex-1 truncate">{dashboard.name}</span>
                  <span className="shrink-0 text-[10px] text-[var(--color-text-muted)]">{dashboard.tileCount}</span>
                </button>
              )
            })}
          </div>
        )}
      </div>

      {creating && <NewDashboardDialog onClose={() => setCreating(false)} />}
      {menu && (
        <ContextMenu x={menu.x} y={menu.y} anchor={menu.anchor} label={`Actions for ${menu.dashboard.name}`} onClose={() => setMenu(null)}>
          <button type="button" role="menuitem" className={CONTEXT_MENU_ITEM} onClick={() => { setRenaming(menu.dashboard); setMenu(null) }}>Rename…</button>
          <div className="my-1 border-t border-[var(--color-border)]" />
          <button type="button" role="menuitem" className={`${CONTEXT_MENU_ITEM} text-[var(--color-danger)]`} onClick={() => { setDeleting(menu.dashboard); setMenu(null) }}>Delete…</button>
        </ContextMenu>
      )}
      {renaming && <RenameDashboardDialog dashboard={renaming} onClose={() => setRenaming(null)} />}
      {deleting && (
        <ConfirmDialog
          title={`Delete ${deleting.name}`}
          body={`Delete ${deleting.name} and its ${deleting.tileCount === 1 ? 'tile' : `${deleting.tileCount} tiles`}? The components stay in their agents’ folders; you can add them to another dashboard.`}
          confirmLabel="Delete dashboard"
          pendingLabel="Deleting…"
          pending={deleteDashboard.isPending}
          error={deleteDashboard.error?.message ?? null}
          onConfirm={() =>
            deleteDashboard.mutate(deleting.id, {
              onSuccess: () => {
                if (activeDashboardId === deleting.id) setActiveDashboardId(null)
                setDeleting(null)
              }
            })
          }
          onClose={() => { if (!deleteDashboard.isPending) { deleteDashboard.reset(); setDeleting(null) } }}
        />
      )}
    </div>
  )
}
