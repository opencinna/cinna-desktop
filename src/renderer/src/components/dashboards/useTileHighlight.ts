import { useCallback, useEffect, useRef, useState } from 'react'

/**
 * What an agent highlighted on one tile (D5, `dashboards_update_tile`). Main
 * holds it in memory: the tile reads it on mount and follows the pushes
 * (`ids: []` clears). The owner selecting something on the tile, or Escape,
 * ends it here and in main ({@link TileHighlight.clear}).
 */
export interface TileHighlight {
  ids: string[]
  /** Drop the highlight locally and tell main; nothing when there is none. */
  clear: () => void
}

function idsOf(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((id): id is string => typeof id === 'string' && id !== '') : []
}

export function useTileHighlight(tileId: string): TileHighlight {
  const [ids, setIds] = useState<string[]>([])
  const idsRef = useRef(ids)
  idsRef.current = ids

  useEffect(() => {
    let cancelled = false
    // A push that lands before the held ids arrive is newer than them.
    let pushed = false
    setIds([])
    const off = window.api.dashboards.onTileHighlight((payload) => {
      if (payload.tileId !== tileId) return
      pushed = true
      setIds(idsOf(payload.ids))
    })
    window.api.dashboards
      .highlight(tileId)
      .then((held) => {
        if (!cancelled && !pushed) setIds(idsOf(held))
      })
      .catch(() => {})
    return () => {
      cancelled = true
      off()
    }
  }, [tileId])

  const clear = useCallback(() => {
    if (idsRef.current.length === 0) return
    idsRef.current = []
    setIds([])
    void window.api.dashboards.clearHighlight(tileId).catch(() => {})
  }, [tileId])

  return { ids, clear }
}

/** A row drawn as highlighted: a selected row shows the selection instead (main.css), so it is not one. */
const DRAWN_HIGHLIGHT = '[data-highlighted="true"]:not([aria-selected="true"])'

/** The highlighted rows the tile draws, in document order. */
export function drawnHighlights(tile: HTMLElement): HTMLElement[] {
  return [...tile.querySelectorAll<HTMLElement>(DRAWN_HIGHLIGHT)]
}

/**
 * Scroll the tile's own scrolling boxes (never the dashboard: the walk stops
 * at the tile) so its first highlighted row shows. Nearest edge, as
 * `scrollIntoView({block: 'nearest'})` would, without bubbling past the tile.
 * False when nothing highlighted is drawn yet.
 */
export function revealFirstHighlight(tile: HTMLElement): boolean {
  return revealHighlight(tile, 0)
}

/** {@link revealFirstHighlight} for the `index`-th drawn highlighted row, wrapping around. */
export function revealHighlight(tile: HTMLElement, index: number): boolean {
  const rows = drawnHighlights(tile)
  if (rows.length === 0) return false
  const target = rows[((index % rows.length) + rows.length) % rows.length]
  // A floating header (the title off) lies over the content's top: a row under it is not shown.
  const headerBottom = Math.max(0, ...[...tile.querySelectorAll('[data-tile-header]')].map((el) => el.getBoundingClientRect().bottom))
  for (let node = target.parentElement; node && node !== tile; node = node.parentElement) {
    if (node.scrollHeight <= node.clientHeight) continue
    const box = node.getBoundingClientRect()
    const row = target.getBoundingClientRect()
    const top = Math.max(box.top, headerBottom)
    if (row.top < top) node.scrollTop -= top - row.top
    else if (row.bottom > box.bottom) node.scrollTop += Math.min(row.bottom - box.bottom, row.top - box.top)
  }
  return true
}
