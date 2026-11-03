import { useRef, useState } from 'react'
import type { TileRefreshOverride, TileView } from '../../../../shared/dashboards'
import { useUpdateTile } from '../../hooks/useDashboards'
import { DashboardDialog, DIALOG_INPUT, DIALOG_LABEL, DIALOG_PRIMARY } from './DashboardDialog'

/** Max ages offered when the user changes a tile's refresh rule (D1: max age and manual only). */
export const MAX_AGE_CHOICES = ['1m', '5m', '15m', '1h', '6h', '1d'] as const

const UNIT_WORDS: Record<string, [string, string]> = { s: ['second', 'seconds'], m: ['minute', 'minutes'], h: ['hour', 'hours'], d: ['day', 'days'] }

/** `15m` → "15 minutes". */
export function durationWords(value: string): string {
  const match = /^(\d+)(s|m|h|d)$/.exec(value)
  if (!match) return value
  const n = Number(match[1])
  return `${n} ${UNIT_WORDS[match[2]][n === 1 ? 0 : 1]}`
}

/** The rule in one line, as the Add dialog and Edit tile show it. */
export function refreshSummary(componentMaxAge: string, override: TileRefreshOverride | null): string {
  if (override?.manual) return 'Only when you press Refresh (and on first show).'
  return `When shown and older than ${durationWords(override?.maxAge ?? componentMaxAge)}, or on Refresh.`
}

/** The max-age select and the Manual switch, shared by Add and Edit tile. */
export function RefreshFields({
  componentMaxAge,
  value,
  onChange,
  idPrefix
}: {
  componentMaxAge: string
  value: TileRefreshOverride | null
  onChange: (next: TileRefreshOverride | null) => void
  idPrefix: string
}): React.JSX.Element {
  const choices = Array.from(new Set([componentMaxAge, ...MAX_AGE_CHOICES]))
  const maxAge = value?.maxAge ?? componentMaxAge
  const manual = value?.manual === true
  const set = (next: TileRefreshOverride): void => {
    const clean: TileRefreshOverride = {}
    if (next.maxAge && next.maxAge !== componentMaxAge) clean.maxAge = next.maxAge
    if (next.manual) clean.manual = true
    onChange(Object.keys(clean).length > 0 ? clean : null)
  }
  return (
    <div className="grid grid-cols-2 items-end gap-3">
      <div>
        <label htmlFor={`${idPrefix}-max-age`} className={DIALOG_LABEL}>Recompute when older than</label>
        <select id={`${idPrefix}-max-age`} className={`${DIALOG_INPUT} mt-1`} value={maxAge} disabled={manual} onChange={(e) => set({ maxAge: e.target.value, manual })}>
          {choices.map((choice) => (
            <option key={choice} value={choice}>{durationWords(choice)}{choice === componentMaxAge ? ' (agent’s rule)' : ''}</option>
          ))}
        </select>
      </div>
      <label className="flex items-center gap-2 pb-1.5 text-xs text-[var(--color-text)]">
        <input type="checkbox" checked={manual} onChange={(e) => set({ maxAge, manual: e.target.checked })} />
        Only when I press Refresh
      </label>
    </div>
  )
}

/** Edit tile: its title and its refresh rule. Closes on success only (ux rule 6). */
export function EditTileDialog({ view, onClose }: { view: TileView; onClose: () => void }): React.JSX.Element {
  const update = useUpdateTile()
  const inputRef = useRef<HTMLInputElement>(null)
  const componentTitle = view.component?.title ?? view.tile.component
  const [title, setTitle] = useState(view.tile.title ?? '')
  const [override, setOverride] = useState<TileRefreshOverride | null>(view.tile.refreshOverride)
  const save = (): void => {
    update.mutate(
      { tileId: view.tile.id, title: title.trim() === '' || title.trim() === componentTitle ? null : title.trim(), refreshOverride: override },
      { onSuccess: onClose }
    )
  }
  return (
    <DashboardDialog label="Edit tile" pending={update.isPending} onClose={onClose} initialFocusRef={inputRef}>
      <h2 className="text-sm font-semibold text-[var(--color-text)]">Edit tile</h2>
      <form className="mt-3 space-y-3" onSubmit={(e) => { e.preventDefault(); save() }}>
        <div>
          <label htmlFor="edit-tile-title" className={DIALOG_LABEL}>Title</label>
          <input id="edit-tile-title" ref={inputRef} className={`${DIALOG_INPUT} mt-1`} value={title} placeholder={componentTitle} maxLength={120} onChange={(e) => setTitle(e.target.value)} />
        </div>
        <RefreshFields componentMaxAge={view.component?.maxAge ?? '15m'} value={override} onChange={setOverride} idPrefix="edit-tile" />
        <div className="flex justify-end gap-2 pt-1">
          <button type="button" className="px-3 py-1.5 text-xs font-medium text-[var(--color-text-muted)] hover:text-[var(--color-text-secondary)]" disabled={update.isPending} onClick={onClose}>Cancel</button>
          <button type="submit" className={DIALOG_PRIMARY} disabled={update.isPending}>{update.isPending ? 'Saving…' : 'Save'}</button>
        </div>
        {update.error && <p role="alert" className="text-xs text-[var(--color-danger)]">{update.error.message}</p>}
      </form>
    </DashboardDialog>
  )
}
