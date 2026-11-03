import { randomUUID } from 'node:crypto'
import { and, asc, desc, eq, inArray, sql } from 'drizzle-orm'
import { getDb } from './client'
import { chats, dashboardTileResults, dashboardTiles, dashboards } from './schema'

export type DashboardRow = typeof dashboards.$inferSelect
export type DashboardTileRow = typeof dashboardTiles.$inferSelect
export type DashboardTileResultRow = typeof dashboardTileResults.$inferSelect

/** Param sets a tile keeps a result for; the least recently written goes first. */
export const KEPT_PARAM_SETS = 3

export interface NewTile {
  agentManifestId: string
  component: string
  /** The skill that ships the component, or null for the agent's own. */
  skill: string | null
  title: string | null
  size: string
  paramsJson: string
  refreshOverrideJson: string | null
}

export interface TileResultWrite {
  /** The new good result, or undefined to keep the one stored. */
  resultJson?: string | null
  fetchedAt?: number | null
  error: string | null
  durationMs: number | null
  tooLarge?: boolean
}

/**
 * Dashboards, their tiles and the tiles' last results, per profile. Every
 * read and write of a tile is scoped through its dashboard's profile, so a
 * tile id from another profile reads as absent. Limits and validation are
 * `dashboardService`'s; this file only stores.
 */
export const dashboardRepo = {
  list(profileUserId: string): Array<DashboardRow & { tileCount: number }> {
    const rows = getDb()
      .select()
      .from(dashboards)
      .where(eq(dashboards.profileUserId, profileUserId))
      .orderBy(asc(dashboards.sortOrder), asc(dashboards.createdAt))
      .all()
    if (rows.length === 0) return []
    const counts = new Map(
      getDb()
        .select({ dashboardId: dashboardTiles.dashboardId, n: sql<number>`count(*)` })
        .from(dashboardTiles)
        .where(inArray(dashboardTiles.dashboardId, rows.map((row) => row.id)))
        .groupBy(dashboardTiles.dashboardId)
        .all()
        .map((row) => [row.dashboardId, Number(row.n)])
    )
    return rows.map((row) => ({ ...row, tileCount: counts.get(row.id) ?? 0 }))
  },

  count(profileUserId: string): number {
    const row = getDb().select({ n: sql<number>`count(*)` }).from(dashboards).where(eq(dashboards.profileUserId, profileUserId)).get()
    return Number(row?.n ?? 0)
  },

  get(profileUserId: string, dashboardId: string): DashboardRow | null {
    return (
      getDb()
        .select()
        .from(dashboards)
        .where(and(eq(dashboards.profileUserId, profileUserId), eq(dashboards.id, dashboardId)))
        .get() ?? null
    )
  },

  create(profileUserId: string, name: string): DashboardRow {
    const now = new Date()
    const last = getDb()
      .select({ sortOrder: dashboards.sortOrder })
      .from(dashboards)
      .where(eq(dashboards.profileUserId, profileUserId))
      .orderBy(desc(dashboards.sortOrder))
      .get()
    const row: DashboardRow = {
      id: randomUUID(),
      profileUserId,
      name,
      sortOrder: (last?.sortOrder ?? -1) + 1,
      createdAt: now,
      updatedAt: now
    }
    getDb().insert(dashboards).values(row).run()
    return row
  },

  rename(profileUserId: string, dashboardId: string, name: string): boolean {
    const result = getDb()
      .update(dashboards)
      .set({ name, updatedAt: new Date() })
      .where(and(eq(dashboards.profileUserId, profileUserId), eq(dashboards.id, dashboardId)))
      .run()
    return result.changes > 0
  },

  /** The dashboard, its tiles and their results (by cascade); its panel chats lose their origin. */
  delete(profileUserId: string, dashboardId: string): boolean {
    if (!this.get(profileUserId, dashboardId)) return false
    const tileIds = getDb().select({ id: dashboardTiles.id }).from(dashboardTiles).where(eq(dashboardTiles.dashboardId, dashboardId)).all().map((row) => row.id)
    // Explicit as well as by cascade: foreign keys may be off on a handle.
    if (tileIds.length > 0) getDb().delete(dashboardTileResults).where(inArray(dashboardTileResults.tileId, tileIds)).run()
    getDb().delete(dashboardTiles).where(eq(dashboardTiles.dashboardId, dashboardId)).run()
    getDb().delete(dashboards).where(and(eq(dashboards.profileUserId, profileUserId), eq(dashboards.id, dashboardId))).run()
    // Its panel chats survive as ordinary chats; whichever profile owns them.
    getDb().update(chats).set({ originDashboardId: null }).where(eq(chats.originDashboardId, dashboardId)).run()
    return true
  },

  /** `orderedIds` first, in that order; any other of the profile's dashboards after them. */
  reorder(profileUserId: string, orderedIds: string[]): void {
    const rows = this.list(profileUserId)
    const known = new Set(rows.map((row) => row.id))
    const order = [...orderedIds.filter((id) => known.has(id)), ...rows.map((row) => row.id).filter((id) => !orderedIds.includes(id))]
    getDb().transaction((tx) => {
      order.forEach((id, index) => {
        tx.update(dashboards).set({ sortOrder: index }).where(and(eq(dashboards.profileUserId, profileUserId), eq(dashboards.id, id))).run()
      })
    })
  },

  tiles(profileUserId: string, dashboardId: string): DashboardTileRow[] {
    if (!this.get(profileUserId, dashboardId)) return []
    return getDb()
      .select()
      .from(dashboardTiles)
      .where(eq(dashboardTiles.dashboardId, dashboardId))
      .orderBy(asc(dashboardTiles.position), asc(dashboardTiles.createdAt))
      .all()
  },

  tileCount(dashboardId: string): number {
    const row = getDb().select({ n: sql<number>`count(*)` }).from(dashboardTiles).where(eq(dashboardTiles.dashboardId, dashboardId)).get()
    return Number(row?.n ?? 0)
  },

  /** A tile of one of this profile's dashboards, or null. */
  tile(profileUserId: string, tileId: string): DashboardTileRow | null {
    const row = getDb()
      .select({ tile: dashboardTiles })
      .from(dashboardTiles)
      .innerJoin(dashboards, eq(dashboards.id, dashboardTiles.dashboardId))
      .where(and(eq(dashboardTiles.id, tileId), eq(dashboards.profileUserId, profileUserId)))
      .get()
    return row?.tile ?? null
  },

  addTile(profileUserId: string, dashboardId: string, tile: NewTile): DashboardTileRow | null {
    if (!this.get(profileUserId, dashboardId)) return null
    const now = new Date()
    const last = getDb()
      .select({ position: dashboardTiles.position })
      .from(dashboardTiles)
      .where(eq(dashboardTiles.dashboardId, dashboardId))
      .orderBy(desc(dashboardTiles.position))
      .get()
    const row: DashboardTileRow = {
      id: randomUUID(),
      dashboardId,
      ...tile,
      position: (last?.position ?? -1) + 1,
      createdAt: now,
      updatedAt: now
    }
    getDb().insert(dashboardTiles).values(row).run()
    getDb().update(dashboards).set({ updatedAt: now }).where(eq(dashboards.id, dashboardId)).run()
    return row
  },

  updateTile(
    profileUserId: string,
    tileId: string,
    patch: Partial<Pick<DashboardTileRow, 'title' | 'size' | 'paramsJson' | 'refreshOverrideJson'>>
  ): DashboardTileRow | null {
    const existing = this.tile(profileUserId, tileId)
    if (!existing) return null
    getDb().update(dashboardTiles).set({ ...patch, updatedAt: new Date() }).where(eq(dashboardTiles.id, tileId)).run()
    return this.tile(profileUserId, tileId)
  },

  /** Move a tile to `toIndex` among its dashboard's tiles; the others close up around it. */
  moveTile(profileUserId: string, tileId: string, toIndex: number): boolean {
    const tile = this.tile(profileUserId, tileId)
    if (!tile) return false
    const others = this.tiles(profileUserId, tile.dashboardId).filter((row) => row.id !== tileId)
    const at = Math.max(0, Math.min(others.length, Math.floor(toIndex)))
    const order = [...others.slice(0, at), tile, ...others.slice(at)]
    getDb().transaction((tx) => {
      order.forEach((row, index) => {
        tx.update(dashboardTiles).set({ position: index }).where(eq(dashboardTiles.id, row.id)).run()
      })
    })
    return true
  },

  removeTile(profileUserId: string, tileId: string): boolean {
    const tile = this.tile(profileUserId, tileId)
    if (!tile) return false
    getDb().delete(dashboardTileResults).where(eq(dashboardTileResults.tileId, tileId)).run()
    getDb().delete(dashboardTiles).where(eq(dashboardTiles.id, tileId)).run()
    return true
  },

  /** Every tile of this profile that shows a component of the agent with `agentManifestId`. */
  tilesForAgent(profileUserId: string, agentManifestId: string): Array<{ tile: DashboardTileRow; dashboardName: string }> {
    // Only the dashboard's name beside the tile: no two selected columns share a name.
    return getDb()
      .select({ tile: dashboardTiles, dashboardName: dashboards.name })
      .from(dashboardTiles)
      .innerJoin(dashboards, eq(dashboards.id, dashboardTiles.dashboardId))
      .where(and(eq(dashboards.profileUserId, profileUserId), eq(dashboardTiles.agentManifestId, agentManifestId)))
      .orderBy(asc(dashboards.sortOrder), asc(dashboardTiles.position))
      .all()
  },

  result(tileId: string, paramsHash: string): DashboardTileResultRow | null {
    return (
      getDb()
        .select()
        .from(dashboardTileResults)
        .where(and(eq(dashboardTileResults.tileId, tileId), eq(dashboardTileResults.paramsHash, paramsHash)))
        .get() ?? null
    )
  },

  /**
   * Record a run's outcome. A success replaces the result; a failure keeps it
   * and sets `error` beside it. Then only the {@link KEPT_PARAM_SETS} most
   * recently written param sets of the tile are kept.
   */
  saveResult(tileId: string, paramsHash: string, write: TileResultWrite, now = Date.now()): DashboardTileResultRow {
    const existing = this.result(tileId, paramsHash)
    const next: DashboardTileResultRow = {
      tileId,
      paramsHash,
      resultJson: write.resultJson === undefined ? (existing?.resultJson ?? null) : write.resultJson,
      fetchedAt: write.fetchedAt === undefined ? (existing?.fetchedAt ?? null) : write.fetchedAt,
      error: write.error,
      durationMs: write.durationMs,
      tooLarge: write.tooLarge ?? (write.resultJson === undefined ? (existing?.tooLarge ?? false) : false),
      updatedAt: now
    }
    if (existing) {
      getDb()
        .update(dashboardTileResults)
        .set(next)
        .where(and(eq(dashboardTileResults.tileId, tileId), eq(dashboardTileResults.paramsHash, paramsHash)))
        .run()
    } else {
      getDb().insert(dashboardTileResults).values(next).run()
    }
    const stale = getDb()
      .select({ paramsHash: dashboardTileResults.paramsHash })
      .from(dashboardTileResults)
      .where(eq(dashboardTileResults.tileId, tileId))
      .orderBy(desc(dashboardTileResults.updatedAt))
      .all()
      .slice(KEPT_PARAM_SETS)
      .map((row) => row.paramsHash)
    if (stale.length > 0) {
      getDb()
        .delete(dashboardTileResults)
        .where(and(eq(dashboardTileResults.tileId, tileId), inArray(dashboardTileResults.paramsHash, stale)))
        .run()
    }
    return next
  }
}
