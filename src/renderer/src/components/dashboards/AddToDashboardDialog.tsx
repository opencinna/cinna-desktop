import { useMemo, useRef, useState } from 'react'
import { TILE_SIZES, TILE_SIZE_LABELS, type ComponentInfo, type TileRefreshOverride, type TileSize } from '../../../../shared/dashboards'
import { readLastDashboardId, useDashboardList, type useAddTile } from '../../hooks/useDashboards'
import { ComponentPreview } from './ComponentPreview'
import { DashboardDialog, DIALOG_INPUT, DIALOG_LABEL, DIALOG_PRIMARY } from './DashboardDialog'
import { RefreshFields, refreshSummary } from './EditTileDialog'

const NEW = '__new__'
const PREVIEW_BOX = { width: 560, height: 260 }

/**
 * Add a component to a dashboard. Everything is prefilled — the dashboard
 * last used (or a new one typed in place when there is none), the
 * component's title, size and refresh rule — so the user normally presses
 * Add only. Add is the last step: the dialog closes and the surface it came
 * from shows "On <dashboard>". Errors stay in the dialog (ux rule 6). The
 * mutation is the caller's, so its success outlives the dialog.
 */
export function AddToDashboardDialog({
  component,
  addTile,
  onClose
}: {
  component: ComponentInfo
  addTile: ReturnType<typeof useAddTile>
  onClose: () => void
}): React.JSX.Element {
  const dashboards = useDashboardList()
  // Focus enters on the title, so Enter adds (never on Cancel).
  const firstRef = useRef<HTMLInputElement>(null)
  const initialDashboard = useMemo(() => {
    const list = dashboards.data ?? []
    const last = readLastDashboardId()
    return list.find((d) => d.id === last)?.id ?? list[0]?.id ?? NEW
  }, [dashboards.data])
  const [dashboardChoice, setDashboardChoice] = useState<string | null>(null)
  const dashboardId = dashboardChoice ?? initialDashboard
  // With no dashboard yet, one is named for the user, so Add is still the only press.
  const [typedName, setNewName] = useState<string | null>(null)
  const newName = typedName ?? ((dashboards.data?.length ?? 0) === 0 ? 'My dashboard' : '')
  const [title, setTitle] = useState(component.title)
  const [size, setSize] = useState<TileSize>(component.size)
  const [override, setOverride] = useState<TileRefreshOverride | null>(null)
  const [changingRefresh, setChangingRefresh] = useState(false)

  const isNew = dashboardId === NEW
  const canAdd = !addTile.isPending && !dashboards.isPending && (!isNew || newName.trim() !== '')

  const submit = (): void => {
    if (!canAdd) return
    addTile.mutate(
      {
        ...(isNew ? { newDashboardName: newName } : { dashboardId }),
        agentId: component.agentId,
        component: component.name,
        skill: component.skill,
        title: title.trim() === '' || title.trim() === component.title ? null : title.trim(),
        size,
        refreshOverride: override
      },
      { onSuccess: onClose }
    )
  }

  return (
    <DashboardDialog label={`Add ${component.title} to a dashboard`} pending={addTile.isPending} onClose={() => { addTile.reset(); onClose() }} initialFocusRef={firstRef} width="max-w-[38rem]">
      <h2 className="text-sm font-semibold text-[var(--color-text)]">Add to dashboard</h2>
      <p className="mt-0.5 text-[11px] text-[var(--color-text-muted)]">{component.title} · from {component.agentName}{component.skill ? ` · from skill ${component.skill}` : ''}</p>

      <div className="mt-3 flex items-center justify-center rounded-lg bg-[var(--color-bg-secondary)] p-2" style={{ height: PREVIEW_BOX.height + 16 }}>
        <ComponentPreview component={component} size={size} box={PREVIEW_BOX} />
      </div>

      <form className="mt-3 space-y-3" onSubmit={(e) => { e.preventDefault(); submit() }}>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label htmlFor="add-tile-dashboard" className={DIALOG_LABEL}>Dashboard</label>
            {/* The new name is typed in the select's own slot: choosing New dashboard… moves nothing. */}
            {isNew ? (
              <div className="mt-1 flex items-center gap-1.5">
                <input
                  id="add-tile-dashboard"
                  className={DIALOG_INPUT}
                  placeholder="New dashboard name"
                  value={newName}
                  maxLength={80}
                  autoFocus={dashboardChoice === NEW}
                  onChange={(e) => setNewName(e.target.value)}
                />
                {(dashboards.data?.length ?? 0) > 0 && (
                  <button type="button" className="shrink-0 text-[11px] text-[var(--color-accent)] hover:text-[var(--color-accent-hover)]" onClick={() => setDashboardChoice(dashboards.data![0].id)}>
                    Pick
                  </button>
                )}
              </div>
            ) : (
              <select id="add-tile-dashboard" className={`${DIALOG_INPUT} mt-1`} value={dashboardId} onChange={(e) => setDashboardChoice(e.target.value)}>
                {(dashboards.data ?? []).map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
                <option value={NEW}>New dashboard…</option>
              </select>
            )}
          </div>
          <div>
            <label htmlFor="add-tile-size" className={DIALOG_LABEL}>Size</label>
            <select id="add-tile-size" className={`${DIALOG_INPUT} mt-1`} value={size} onChange={(e) => setSize(e.target.value as TileSize)}>
              {TILE_SIZES.map((s) => <option key={s} value={s}>{TILE_SIZE_LABELS[s]}</option>)}
            </select>
          </div>
        </div>
        <div>
          <label htmlFor="add-tile-title" className={DIALOG_LABEL}>Title</label>
          <input id="add-tile-title" ref={firstRef} className={`${DIALOG_INPUT} mt-1`} value={title} maxLength={120} onChange={(e) => setTitle(e.target.value)} />
        </div>
        <div>
          <div className="flex items-baseline gap-2">
            <span className={DIALOG_LABEL}>Refresh</span>
            <span className="min-w-0 flex-1 truncate text-[11px] text-[var(--color-text-secondary)]">{refreshSummary(component.maxAge, override)}</span>
            {!changingRefresh && (
              <button type="button" className="shrink-0 text-[11px] font-medium text-[var(--color-accent)] hover:text-[var(--color-accent-hover)]" onClick={() => setChangingRefresh(true)}>
                Change
              </button>
            )}
          </div>
          {changingRefresh && <div className="mt-2"><RefreshFields componentMaxAge={component.maxAge} value={override} onChange={setOverride} idPrefix="add-tile" /></div>}
        </div>
        <div className="flex justify-end gap-2 pt-1">
          <button type="button" className="px-3 py-1.5 text-xs font-medium text-[var(--color-text-muted)] hover:text-[var(--color-text-secondary)]" disabled={addTile.isPending} onClick={() => { addTile.reset(); onClose() }}>
            Cancel
          </button>
          <button type="submit" className={DIALOG_PRIMARY} disabled={!canAdd}>{addTile.isPending ? 'Adding…' : 'Add'}</button>
        </div>
        {addTile.error && <p role="alert" className="text-xs text-[var(--color-danger)]">{addTile.error.message}</p>}
      </form>
    </DashboardDialog>
  )
}
