/**
 * What an agent highlighted on a tile (`dashboards_update_tile`), and which
 * tiles' pages draw a highlight (`cinna/highlight-ready`). Both in memory,
 * by tile id, until the app quits: a highlight is a pointer for the person
 * looking now, not data. A page's readiness ends when it loads again, and
 * comes back when the new page says it is ready.
 *
 * A highlight ends when the owner selects something on the tile
 * (`dashboards:clear-highlight`) or the agent replaces it (`[]` clears).
 *
 * Core module: no Electron.
 */

export function createTileHighlights() {
  const held = new Map<string, string[]>()
  const ready = new Set<string>()
  return {
    /** The ids held for a tile; [] when none. */
    get(tileId: string): string[] {
      return [...(held.get(tileId) ?? [])]
    },
    /** Replaces the tile's highlight; [] clears it. */
    set(tileId: string, ids: readonly string[]): void {
      if (ids.length === 0) held.delete(tileId)
      else held.set(tileId, [...ids])
    },
    clear(tileId: string): void {
      held.delete(tileId)
    },
    /** The tile's page listens for highlights. */
    markReady(tileId: string): void {
      ready.add(tileId)
    },
    /** The tile's page reloaded: it is ready again only once it says so. */
    unmarkReady(tileId: string): void {
      ready.delete(tileId)
    },
    isReady(tileId: string): boolean {
      return ready.has(tileId)
    },
    /** Test hook. */
    reset(): void {
      held.clear()
      ready.clear()
    }
  }
}

export type TileHighlights = ReturnType<typeof createTileHighlights>

export const tileHighlights = createTileHighlights()
