import { useRef, useState } from 'react'
import type { ComponentRefreshRule, TileRefreshOverride, TileView } from '../../../../shared/dashboards'
import { useUpdateTile } from '../../hooks/useDashboards'
import { DashboardDialog, DIALOG_INPUT, DIALOG_LABEL, DIALOG_PRIMARY } from './DashboardDialog'

/** Max ages offered when the user changes a tile's refresh rule. */
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

/** The max-age select and the Manual switch, for the Add dialog (Edit tile has {@link RefreshOverrideFields}). */
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
        <select id={`${idPrefix}-max-age`} className={`${DIALOG_INPUT} mt-1 disabled:opacity-50`} value={maxAge} disabled={manual} onChange={(e) => set({ maxAge: e.target.value, manual })}>
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

/** How often a tile on screen may recompute on its own (`while_open_every`, at least 1m). */
export const WHILE_OPEN_CHOICES = ['1m', '5m', '15m', '1h'] as const

/** The first option of each select: no override, the component's own value named. */
const INHERIT = ''

function onOff(value: boolean | undefined): string {
  return value === undefined ? INHERIT : value ? 'on' : 'off'
}

/**
 * The tile's whole refresh override (Edit tile, D4): max age, Manual, while
 * open every, after a chat turn, on app start. Each select starts with the
 * component's own value ("Component: every 15 minutes"), which is no
 * override; anything else is stored on the tile and wins. Manual turns the
 * rest off (they stay as set, greyed), so the dialog's height never changes.
 * A cloud tile (D6) has no "When Cinna starts": core has no launch warm-up.
 */
export function RefreshOverrideFields({
  rule,
  value,
  onChange,
  cloud = false
}: {
  rule: ComponentRefreshRule
  value: TileRefreshOverride | null
  onChange: (next: TileRefreshOverride | null) => void
  cloud?: boolean
}): React.JSX.Element {
  const current = value ?? {}
  const manual = current.manual === true
  const set = (patch: Partial<Record<keyof TileRefreshOverride, unknown>>): void => {
    const next: Record<string, unknown> = { ...current, ...patch }
    for (const key of Object.keys(next)) if (next[key] === undefined || (key === 'manual' && next[key] === false)) delete next[key]
    onChange(Object.keys(next).length > 0 ? (next as TileRefreshOverride) : null)
  }
  const ages = Array.from(new Set([...MAX_AGE_CHOICES, ...(current.maxAge ? [current.maxAge] : [])]))
  const periods = Array.from(new Set([...WHILE_OPEN_CHOICES, ...(current.whileOpenEvery ? [current.whileOpenEvery] : [])]))
  const whileOpen = current.whileOpenEvery === undefined ? INHERIT : current.whileOpenEvery === null ? 'off' : current.whileOpenEvery
  // Under Manual the rule's selects are off, and look it.
  const select = `${DIALOG_INPUT} mt-1 disabled:opacity-50`
  return (
    <fieldset className="space-y-3" aria-label="Refresh">
      <div className="grid grid-cols-2 gap-3">
        <div>
          <label htmlFor="edit-tile-max-age" className={DIALOG_LABEL}>Recompute when older than</label>
          <select id="edit-tile-max-age" className={select} disabled={manual} value={current.maxAge ?? INHERIT} onChange={(e) => set({ maxAge: e.target.value === INHERIT ? undefined : e.target.value })}>
            <option value={INHERIT}>Component: {durationWords(rule.maxAge)}</option>
            {ages.map((age) => <option key={age} value={age}>{durationWords(age)}</option>)}
          </select>
        </div>
        <div>
          <label htmlFor="edit-tile-while-open" className={DIALOG_LABEL}>While on screen, every</label>
          <select
            id="edit-tile-while-open"
            className={select}
            disabled={manual}
            value={whileOpen}
            onChange={(e) => set({ whileOpenEvery: e.target.value === INHERIT ? undefined : e.target.value === 'off' ? null : e.target.value })}
          >
            <option value={INHERIT}>Component: {rule.whileOpenEvery ? `every ${durationWords(rule.whileOpenEvery)}` : 'off'}</option>
            <option value="off">Off</option>
            {periods.map((period) => <option key={period} value={period}>Every {durationWords(period)}</option>)}
          </select>
        </div>
        <div>
          <label htmlFor="edit-tile-after-turn" className={DIALOG_LABEL}>After a chat turn of its agent</label>
          <select id="edit-tile-after-turn" className={select} disabled={manual} value={onOff(current.afterTurn)} onChange={(e) => set({ afterTurn: e.target.value === INHERIT ? undefined : e.target.value === 'on' })}>
            <option value={INHERIT}>Component: {rule.afterTurn ? 'recompute' : 'off'}</option>
            <option value="on">Recompute</option>
            <option value="off">Off</option>
          </select>
        </div>
        {!cloud && <div>
          <label htmlFor="edit-tile-app-start" className={DIALOG_LABEL}>When Cinna starts</label>
          <select id="edit-tile-app-start" className={select} disabled={manual} value={onOff(current.onAppStart)} onChange={(e) => set({ onAppStart: e.target.value === INHERIT ? undefined : e.target.value === 'on' })}>
            <option value={INHERIT}>Component: {rule.onAppStart ? 'warm up' : 'off'}</option>
            <option value="on">Warm up</option>
            <option value="off">Off</option>
          </select>
        </div>}
      </div>
      <label className="flex items-center gap-2 text-xs text-[var(--color-text)]">
        <input type="checkbox" checked={manual} onChange={(e) => set({ manual: e.target.checked })} />
        Only when I press Refresh
      </label>
    </fieldset>
  )
}

/** The component's rule, or the D1 defaults when the component cannot be read. */
function ruleOf(view: TileView): ComponentRefreshRule {
  return (
    view.component?.refresh ?? {
      maxAge: view.component?.maxAge ?? '15m',
      whileOpenEvery: null,
      afterTurn: false,
      onAppStart: false,
      command: view.component?.refreshCommand ?? null,
      schedule: null
    }
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
        <RefreshOverrideFields rule={ruleOf(view)} value={override} onChange={setOverride} cloud={!!view.tile.cloud} />
        <div className="flex justify-end gap-2 pt-1">
          <button type="button" className="px-3 py-1.5 text-xs font-medium text-[var(--color-text-muted)] hover:text-[var(--color-text-secondary)]" disabled={update.isPending} onClick={onClose}>Cancel</button>
          <button type="submit" className={DIALOG_PRIMARY} disabled={update.isPending}>{update.isPending ? 'Saving…' : 'Save'}</button>
        </div>
        {update.error && <p role="alert" className="text-xs text-[var(--color-danger)]">{update.error.message}</p>}
      </form>
    </DashboardDialog>
  )
}
