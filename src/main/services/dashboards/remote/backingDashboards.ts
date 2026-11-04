/**
 * The core dashboard behind a desktop dashboard's cloud tiles (D6.1): one per
 * desktop dashboard and profile, made with the first cloud tile, recorded on
 * the dashboard row with the server it was made on.
 *
 * - `ensure` makes it (`origin: desktop`, hidden on the web) or checks the one
 *   recorded: on another server it is `wrong_server`; one core says is gone is
 *   made again once. A name that drifted while core was unreachable is set again.
 * - The rest keep core in step with what the owner did here, **fire and
 *   forget**: a local change never waits on the network and never fails
 *   because core is unreachable. The dashboard's name, the block's title and
 *   its `config.refresh` follow the desktop; removing a tile deletes its block;
 *   deleting the dashboard deletes the backing one. Nothing is sent to a server
 *   other than the one the backing dashboard is on. Logs carry no URL.
 *
 * Core replaces a block's whole `config` on update (and re-checks it, which
 * wakes the environment), so a refresh change is sent with the block's
 * current `config` read first: the params the owner or the agent set stay.
 * A params change this device learns of between that read and the write
 * (its own filter, core's event for the agent's) is written again at once.
 * A refresh change core refuses or never gets (its environment is down, core
 * is unreachable) stays pending and is sent again after the tile's next
 * refresh core runs, at most {@link MAX_REFRESH_RESENDS} times. One refresh
 * change per tile is in flight at a time.
 *
 * Core module: no Electron.
 */

import { dashboardRepo, type DashboardRow, type DashboardTileRow } from '../../../db/dashboards'
import { createLogger } from '../../../logger/logger'
import { coreDashboardsClient, type CoreBlockConfig, type CoreOutcome, type CoreRefreshOverrides } from './coreDashboardsClient'
import { profileServerUrl, sameCoreServer, serverHost } from './cloudComponent'
import type { DashboardsErrorCode, TileRefreshOverride } from '../../../../shared/dashboards'

const logger = createLogger('dashboards-cloud')

type Refusal = { ok: false; code: DashboardsErrorCode; message: string }

/** How often a refused Edit tile refresh change is sent again before it is given up (logged). */
export const MAX_REFRESH_RESENDS = 3

function paramsOf(json: string | null | undefined): Record<string, unknown> {
  try {
    const value = json ? JSON.parse(json) : {}
    return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {}
  } catch {
    return {}
  }
}

export type BackingClient = Pick<
  typeof coreDashboardsClient,
  'createDashboard' | 'getDashboard' | 'renameDashboard' | 'deleteDashboard' | 'updateBlock' | 'deleteBlock'
>

export interface BackingDashboardsDeps {
  client: BackingClient
  /** The profile's Cinna server URL now, or null when it has none. */
  serverUrl: (userId: string) => string | null
}

/** Edit tile's override → core's `config.refresh`. `manual` and `onAppStart` stay on the desktop; "interval off" is core's `"manual"`. */
export function refreshToCore(override: TileRefreshOverride | null | undefined): CoreRefreshOverrides {
  const out: CoreRefreshOverrides = {}
  if (!override) return out
  if (override.maxAge) out.max_age = override.maxAge
  if (override.whileOpenEvery !== undefined) out.while_open_every = override.whileOpenEvery === null ? 'manual' : override.whileOpenEvery
  if (override.afterTurn !== undefined) out.after_turn = override.afterTurn
  return out
}

/** The D6.10 sentence for a transport refusal, or core's own. */
export function transportMessage(outcome: Extract<CoreOutcome<unknown>, { ok: false }>, server: string | null): string {
  if (outcome.code === 'unreachable') return `Can’t reach ${serverHost(server)}.`
  if (outcome.code === 'reauth_required') return `Sign in to ${serverHost(server)} again.`
  return outcome.message || `Cinna answered ${outcome.status ?? 'with an error'}.`
}

export function createBackingDashboards(deps: BackingDashboardsDeps = { client: coreDashboardsClient, serverUrl: profileServerUrl }) {
  const { client } = deps
  /** One `ensure` at a time per dashboard, so two adds never make two backing dashboards. */
  const ensuring = new Map<string, Promise<{ ok: true; coreDashboardId: string } | Refusal>>()
  /** Fire-and-forget syncs still going, for tests. */
  const pending = new Set<Promise<void>>()
  /** Tiles whose Edit tile refresh change has not reached core: tile id → sends so far. */
  const pendingRefresh = new Map<string, number>()
  /** The refresh change in flight per tile; the next one waits for it. */
  const refreshRuns = new Map<string, Promise<void>>()

  function background(what: string, work: () => Promise<CoreOutcome<unknown> | void>): Promise<void> {
    const run = (async () => {
      try {
        const outcome = await work()
        if (outcome && !outcome.ok) logger.info(`could not ${what} on Cinna`, { code: outcome.code, status: outcome.status })
      } catch (err) {
        logger.warn(`could not ${what} on Cinna`, { error: err instanceof Error ? err.name : 'error' })
      }
    })()
    pending.add(run)
    void run.finally(() => pending.delete(run))
    return run
  }

  /** The backing dashboard's id when it is on the profile's server now; null otherwise (nothing to sync, or not here). */
  function syncTarget(userId: string, dashboard: Pick<DashboardRow, 'coreDashboardId' | 'coreServer'>): string | null {
    if (!dashboard.coreDashboardId) return null
    const server = deps.serverUrl(userId)
    return sameCoreServer(dashboard.coreServer, server) ? dashboard.coreDashboardId : null
  }

  async function create(userId: string, dashboard: DashboardRow, server: string): Promise<{ ok: true; coreDashboardId: string } | Refusal> {
    const made = await client.createDashboard(userId, dashboard.name)
    if (!made.ok) {
      // Core's cap on desktop-owned dashboards per user (50; its 409 sentence names no desktop action).
      if (made.code === 'limit_reached') {
        return { ok: false, code: 'limit_reached', message: `${serverHost(server)} holds no more dashboards with cloud tiles for you. Delete a dashboard that has cloud tiles, or add this to one of them.` }
      }
      return { ok: false, code: made.code, message: transportMessage(made, server) }
    }
    if (!dashboardRepo.setCoreDashboard(userId, dashboard.id, made.value.id, server)) {
      // The dashboard went while core made its twin.
      void background('delete a backing dashboard', () => client.deleteDashboard(userId, made.value.id))
      return { ok: false, code: 'not_found', message: 'That dashboard is gone.' }
    }
    return { ok: true, coreDashboardId: made.value.id }
  }

  async function ensureNow(userId: string, dashboardId: string): Promise<{ ok: true; coreDashboardId: string } | Refusal> {
    const dashboard = dashboardRepo.get(userId, dashboardId)
    if (!dashboard) return { ok: false, code: 'not_found', message: 'That dashboard is gone.' }
    const server = deps.serverUrl(userId)
    if (!server) return { ok: false, code: 'reauth_required', message: `Sign in to ${serverHost(null)} again.` }
    if (!dashboard.coreDashboardId) return create(userId, dashboard, server)
    if (!sameCoreServer(dashboard.coreServer, server)) {
      return { ok: false, code: 'wrong_server', message: 'This dashboard’s cloud tiles are on another Cinna server. Add this to another dashboard.' }
    }
    const found = await client.getDashboard(userId, dashboard.coreDashboardId)
    if (found.ok) {
      // A rename that did not reach core while it was unreachable.
      if (found.value.name !== dashboard.name) void background('rename a backing dashboard', () => client.renameDashboard(userId, dashboard.coreDashboardId!, dashboard.name))
      return { ok: true, coreDashboardId: dashboard.coreDashboardId }
    }
    if (found.code === 'not_found') return create(userId, dashboard, server)
    return { ok: false, code: found.code, message: transportMessage(found, server) }
  }

  return {
    /** The core dashboard to add a block to, made when there is none. */
    ensure(userId: string, dashboardId: string): Promise<{ ok: true; coreDashboardId: string } | Refusal> {
      const running = ensuring.get(dashboardId)
      if (running) return running
      const run = ensureNow(userId, dashboardId).finally(() => ensuring.delete(dashboardId))
      ensuring.set(dashboardId, run)
      return run
    },

    renamed(userId: string, dashboard: DashboardRow, name: string): Promise<void> {
      const target = syncTarget(userId, dashboard)
      if (!target) return Promise.resolve()
      return background('rename a backing dashboard', () => client.renameDashboard(userId, target, name))
    },

    deleted(userId: string, dashboard: DashboardRow): Promise<void> {
      const target = syncTarget(userId, dashboard)
      if (!target) return Promise.resolve()
      return background('delete a backing dashboard', () => client.deleteDashboard(userId, target))
    },

    tileRemoved(userId: string, dashboard: DashboardRow, tile: DashboardTileRow): Promise<void> {
      pendingRefresh.delete(tile.id)
      const target = syncTarget(userId, dashboard)
      if (!target || !tile.coreBlockId) return Promise.resolve()
      return background('delete a block', () => client.deleteBlock(userId, target, tile.coreBlockId!))
    },

    /**
     * Core's 20-block cap was hit while this dashboard has fewer cloud tiles:
     * blocks no tile here references (deletes that never reached core) are
     * deleted now, awaited. Answers how many went.
     */
    async deleteOrphanBlocks(userId: string, dashboardId: string, coreDashboardId: string): Promise<number> {
      const read = await client.getDashboard(userId, coreDashboardId)
      if (!read.ok) return 0
      const kept = new Set(dashboardRepo.tiles(userId, dashboardId).map((row) => row.coreBlockId).filter((id): id is string => !!id))
      let deleted = 0
      for (const block of read.value.blocks) {
        if (block.view_type !== 'agent_component' || kept.has(block.id)) continue
        const gone = await client.deleteBlock(userId, coreDashboardId, block.id)
        if (gone.ok || gone.code === 'not_found') deleted++
      }
      return deleted
    },

    /** The block's title follows the tile's (null: the component's own). */
    titleChanged(userId: string, dashboard: DashboardRow, tile: DashboardTileRow): Promise<void> {
      const target = syncTarget(userId, dashboard)
      if (!target || !tile.coreBlockId) return Promise.resolve()
      return background('retitle a block', () => client.updateBlock(userId, target, tile.coreBlockId!, { title: tile.title }))
    },

    /**
     * The block's `config.refresh` follows Edit tile, with the rest of its
     * config as core holds it now. Refused or unanswered → pending (see the
     * module comment); a params change learnt of meanwhile is written again.
     */
    refreshChanged(userId: string, dashboard: DashboardRow, tile: DashboardTileRow, override: TileRefreshOverride | null): Promise<void> {
      const target = syncTarget(userId, dashboard)
      const blockId = tile.coreBlockId
      if (!target || !blockId) return Promise.resolve()
      const previous = refreshRuns.get(tile.id) ?? Promise.resolve()
      const run = previous.then(() =>
        background('change a block’s refresh', async () => {
          const paramsBefore = dashboardRepo.tile(userId, tile.id)?.paramsJson ?? tile.paramsJson
          const read = await client.getDashboard(userId, target)
          if (!read.ok) {
            pendingRefresh.set(tile.id, (pendingRefresh.get(tile.id) ?? 0) + 1)
            return read
          }
          const block = read.value.blocks.find((entry) => entry.id === blockId)
          if (!block) {
            pendingRefresh.delete(tile.id)
            return { ok: false, code: 'not_found', message: 'no such block', status: 404 }
          }
          const current: CoreBlockConfig = block.config ?? { component: tile.component, skill: tile.skill ?? null, params: {} }
          const refresh = refreshToCore(override)
          const written = await client.updateBlock(userId, target, blockId, { config: { ...current, refresh } })
          if (!written.ok) {
            if (written.code === 'not_found') pendingRefresh.delete(tile.id)
            else pendingRefresh.set(tile.id, (pendingRefresh.get(tile.id) ?? 0) + 1)
            return written
          }
          pendingRefresh.delete(tile.id)
          // A params change landed between the read and the write: the write put the old ones back on core.
          const paramsAfter = dashboardRepo.tile(userId, tile.id)?.paramsJson
          if (paramsAfter !== undefined && paramsAfter !== paramsBefore) {
            return client.updateBlock(userId, target, blockId, { config: { ...current, params: paramsOf(paramsAfter), refresh } })
          }
          return written
        })
      )
      const settled = run.finally(() => {
        if (refreshRuns.get(tile.id) === settled) refreshRuns.delete(tile.id)
      })
      refreshRuns.set(tile.id, settled)
      return settled
    },

    /** The tile's environment ran a refresh: a refresh change it refused before is sent again (bounded). */
    resendRefresh(userId: string, dashboard: DashboardRow, tile: DashboardTileRow, override: TileRefreshOverride | null): Promise<void> {
      const sent = pendingRefresh.get(tile.id)
      if (sent === undefined || refreshRuns.has(tile.id)) return Promise.resolve()
      if (sent >= MAX_REFRESH_RESENDS) {
        pendingRefresh.delete(tile.id)
        logger.info('gave up sending a tile’s refresh change to Cinna', { tries: sent })
        return Promise.resolve()
      }
      return this.refreshChanged(userId, dashboard, tile, override)
    },

    /** Whether a tile's refresh change has yet to reach core. */
    hasPendingRefresh(tileId: string): boolean {
      return pendingRefresh.has(tileId)
    },

    /** For tests: every sync still going has settled. */
    async settled(): Promise<void> {
      while (pending.size > 0 || refreshRuns.size > 0) await Promise.allSettled([...pending, ...refreshRuns.values()])
    }
  }
}

export type BackingDashboards = ReturnType<typeof createBackingDashboards>

export const backingDashboards = createBackingDashboards()
