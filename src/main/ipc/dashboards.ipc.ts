import { userActivation } from '../auth/activation'
import { getProfileScopeUserId } from '../auth/scope'
import { dashboardFrameServer } from '../host/desktop/htmlPreview'
import { dashboardFrameOwners, ownDashboardFrame } from '../host/desktop/dashboardFrameOwners'
import { dashboardService } from '../services/dashboards/dashboardService'
import { dashboardRefreshService } from '../services/dashboards/dashboardRefreshService'
import { panelChatService } from '../services/dashboards/panelChat'
import { tileHighlights } from '../services/dashboards/tileHighlights'
import { cloudFrames } from '../services/dashboards/remote/cloudFrames'
import type {
  CloudComponentsOutcome,
  ComponentInfo,
  ComponentPlacement,
  DashboardCallOutcome,
  DashboardDto,
  DashboardFrameOutcome,
  DashboardsOutcome,
  PanelChatOutcome,
  ResolveReferenceOutcome,
  TileDto,
  TileResultDto,
  TileView
} from '../../shared/dashboards'
import { ipcHandle } from './_wrap'

/**
 * Dashboards. Thin controllers: activation, the active profile, delegate.
 * Every payload is untrusted and re-validated by the service; the renderer
 * names dashboards, tiles, agents and components, never a path. Every
 * answer, refusals included, is data.
 */
export function registerDashboardHandlers(): void {
  ipcHandle('dashboards:list', (): DashboardDto[] => {
    userActivation.requireActivated()
    return dashboardService.list(getProfileScopeUserId())
  })

  ipcHandle('dashboards:create', (_event, name: unknown): DashboardsOutcome<{ dashboard: DashboardDto }> => {
    userActivation.requireActivated()
    return dashboardService.create(getProfileScopeUserId(), name)
  })

  ipcHandle('dashboards:rename', (_event, input?: { dashboardId?: unknown; name?: unknown }): DashboardsOutcome<{ dashboard: DashboardDto }> => {
    userActivation.requireActivated()
    return dashboardService.rename(getProfileScopeUserId(), input?.dashboardId, input?.name)
  })

  ipcHandle('dashboards:delete', (_event, dashboardId: unknown): DashboardsOutcome<object> => {
    userActivation.requireActivated()
    return dashboardService.delete(getProfileScopeUserId(), dashboardId)
  })

  ipcHandle('dashboards:reorder', (_event, orderedIds: unknown): DashboardsOutcome<{ dashboards: DashboardDto[] }> => {
    userActivation.requireActivated()
    return dashboardService.reorder(getProfileScopeUserId(), orderedIds)
  })

  ipcHandle('dashboards:tiles', (_event, dashboardId: unknown): DashboardsOutcome<{ dashboard: DashboardDto; tiles: TileView[] }> => {
    userActivation.requireActivated()
    return dashboardService.tiles(getProfileScopeUserId(), dashboardId)
  })

  /** A folder agent's component, or a cloud agent's (D6: async, a block on the backing core dashboard). */
  ipcHandle('dashboards:add-tile', (_event, input: unknown): DashboardsOutcome<{ tile: TileDto; dashboard: DashboardDto }> | Promise<DashboardsOutcome<{ tile: TileDto; dashboard: DashboardDto }>> => {
    userActivation.requireActivated()
    const userId = getProfileScopeUserId()
    const agentId = input && typeof input === 'object' ? (input as Record<string, unknown>).agentId : undefined
    return dashboardService.cloudAgent(userId, agentId) ? dashboardService.addCloudTile(userId, input) : dashboardService.addTile(userId, input)
  })

  ipcHandle('dashboards:update-tile', (_event, input: unknown): DashboardsOutcome<{ tile: TileDto }> => {
    userActivation.requireActivated()
    return dashboardService.updateTile(getProfileScopeUserId(), input)
  })

  ipcHandle('dashboards:move-tile', (_event, input?: { tileId?: unknown; toIndex?: unknown }): DashboardsOutcome<object> => {
    userActivation.requireActivated()
    return dashboardService.moveTile(getProfileScopeUserId(), input?.tileId, input?.toIndex)
  })

  ipcHandle('dashboards:remove-tile', (_event, tileId: unknown): DashboardsOutcome<object> => {
    userActivation.requireActivated()
    return dashboardService.removeTile(getProfileScopeUserId(), tileId)
  })

  ipcHandle('dashboards:components', (_event, agentId?: unknown): ComponentInfo[] => {
    userActivation.requireActivated()
    return dashboardService.components(agentId)
  })

  /** A cloud agent's components from its Cinna server (never wakes anything), with this profile's tiles of them; refusals are data. */
  ipcHandle('dashboards:cloud-components', (_event, agentId: unknown): Promise<CloudComponentsOutcome> => {
    userActivation.requireActivated()
    return dashboardService.cloudComponents(getProfileScopeUserId(), agentId)
  })

  ipcHandle('dashboards:placements', (_event, agentId: unknown): ComponentPlacement[] => {
    userActivation.requireActivated()
    return dashboardService.placements(getProfileScopeUserId(), agentId)
  })

  ipcHandle('dashboards:tile-result', (_event, tileId: unknown): DashboardsOutcome<{ result: TileResultDto }> => {
    userActivation.requireActivated()
    return dashboardRefreshService.tileResult(getProfileScopeUserId(), tileId)
  })

  ipcHandle('dashboards:ensure-fresh', (_event, input?: { tileId?: unknown; reason?: unknown }): Promise<DashboardsOutcome<{ result: TileResultDto }>> => {
    userActivation.requireActivated()
    // `after_turn`, `interval`, `launch`, `params` and `schedule` are main's own reasons; the renderer may not use them to force a recompute.
    if (input?.reason !== 'visible' && input?.reason !== 'manual') {
      return Promise.resolve({ ok: false, code: 'invalid_input', message: 'That refresh reason is not accepted here.' })
    }
    return dashboardRefreshService.ensureFresh(getProfileScopeUserId(), input?.tileId, input?.reason)
  })

  ipcHandle('dashboards:preview', (_event, input?: { agentId?: unknown; component?: unknown; skill?: unknown; params?: unknown }): Promise<DashboardsOutcome<{ result: TileResultDto }>> => {
    userActivation.requireActivated()
    return dashboardRefreshService.preview(getProfileScopeUserId(), input?.agentId, input?.component, input?.skill, input?.params)
  })

  /** `tools/call` from a component's page: one of its own endpoints, run once, never cached; refusals and failures are data. */
  ipcHandle('dashboards:call', (_event, input: unknown): Promise<DashboardCallOutcome> => {
    userActivation.requireActivated()
    return dashboardRefreshService.call(getProfileScopeUserId(), input)
  })

  /** A tile's params from a native filter or `cinna.setParams`: validated, kept, recomputed (reason `params`, main's own). */
  ipcHandle('dashboards:set-params', (_event, input: unknown): Promise<DashboardsOutcome<{ tile: TileDto }>> => {
    userActivation.requireActivated()
    return dashboardRefreshService.setParams(getProfileScopeUserId(), input)
  })

  /** A component reference in a message, resolved to a component here or in an own cloud agent, or a reason, as data. Runs nothing. */
  ipcHandle('dashboards:resolve-reference', (_event, input: unknown): Promise<ResolveReferenceOutcome> => {
    userActivation.requireActivated()
    return dashboardService.resolveReference(getProfileScopeUserId(), input)
  })

  /** The panel's chat for (dashboard, agent): the latest one, or a new one when there is none or `fresh` (README D12). */
  ipcHandle('dashboards:panel-chat', (_event, input: unknown): Promise<PanelChatOutcome> => {
    userActivation.requireActivated()
    return panelChatService.open(getProfileScopeUserId(), input)
  })

  ipcHandle('dashboards:lease', (_event, tileIds: unknown): DashboardsOutcome<object> => {
    userActivation.requireActivated()
    return dashboardRefreshService.renewLease(getProfileScopeUserId(), tileIds)
  })

  ipcHandle('dashboards:drop-lease', (_event, tileIds?: unknown): DashboardsOutcome<object> => {
    userActivation.requireActivated()
    return dashboardRefreshService.dropLease(getProfileScopeUserId(), tileIds)
  })

  /**
   * A frame for a tile, or for a component's preview: a URL on this profile's
   * dash host. A cloud tile, or a preview of a remote agent's component, is
   * minted on core and relayed through main (D6.3); core's refusals are data.
   */
  ipcHandle('dashboards:open-frame', async (event, target: unknown): Promise<DashboardFrameOutcome> => {
    userActivation.requireActivated()
    const outcome = await openFrame(target)
    // A reload, crash or closed window never runs the frame's own release: its renderer's end does.
    if (outcome.ok && event?.sender) ownDashboardFrame(event.sender, outcome.token)
    return outcome
  })

  async function openFrame(target: unknown): Promise<DashboardFrameOutcome> {
    const userId = getProfileScopeUserId()
    const input = target && typeof target === 'object' ? (target as Record<string, unknown>) : {}
    const cloud = typeof input.tileId === 'string'
      ? await cloudFrames.openTile(userId, input.tileId)
      : await cloudFrames.openPreview(userId, input.agentId, input.component, input.skill)
    if (cloud) {
      if (!cloud.ok) return cloud
      const { token, url } = dashboardFrameServer.registerRemote(cloud.frame, userId)
      cloudFrames.registered(token, cloud.tileId)
      return { ok: true, token, url }
    }
    let found: ReturnType<typeof dashboardService.resolveComponent> = null
    if (typeof input.tileId === 'string') {
      const resolved = dashboardService.resolveTile(userId, input.tileId)
      if (!resolved) return { ok: false, code: 'not_found', message: 'That tile is gone.' }
      found = resolved.agent && resolved.scanned ? { agent: resolved.agent, scanned: resolved.scanned } : null
    } else {
      found = dashboardService.resolveComponent(input.agentId, input.component, input.skill)
    }
    if (!found) return { ok: false, code: 'not_found', message: 'That component is no longer in the agent’s folder.' }
    const spec = found.scanned.spec
    if (!spec) return { ok: false, code: 'component_invalid', message: 'This component has problems to fix before it can be shown.' }
    if (spec.view !== 'html') return { ok: false, code: 'invalid_input', message: 'This component has no page.' }
    const { token, url } = dashboardFrameServer.register(
      { agentId: found.agent.id, component: found.scanned.info.name, skill: found.scanned.info.skill },
      spec.entry,
      userId
    )
    return { ok: true, token, url }
  }

  /** The ids an agent highlighted on one of the active profile's tiles and still holds; [] when none or not its tile. */
  ipcHandle('dashboards:highlight', (_event, tileId: unknown): string[] => {
    userActivation.requireActivated()
    if (!dashboardService.resolveTile(getProfileScopeUserId(), tileId)) return []
    return tileHighlights.get(tileId as string)
  })

  /** The owner selected something on the tile: the agent's highlight is over. No push; the renderer already shows it. */
  ipcHandle('dashboards:clear-highlight', (_event, tileId: unknown): boolean => {
    userActivation.requireActivated()
    if (!dashboardService.resolveTile(getProfileScopeUserId(), tileId)) return false
    tileHighlights.clear(tileId as string)
    return true
  })

  /**
   * The tile's page sent `cinna/highlight-ready` (`ready` true), or a page that
   * had loaded again (false): `dashboards_tiles` reports it can highlight only
   * while the page now loaded listens.
   */
  ipcHandle('dashboards:highlight-ready', (_event, tileId: unknown, ready?: unknown): boolean | Promise<boolean> => {
    userActivation.requireActivated()
    const userId = getProfileScopeUserId()
    // A cloud tile's readiness is core's page state (D6.5), as on core's web host.
    if (typeof tileId === 'string' && cloudFrames.isCloudTile(userId, tileId)) return cloudFrames.highlightReady(userId, tileId, ready !== false)
    const resolved = dashboardService.resolveTile(userId, tileId)
    if (!resolved) return false
    if (ready === false) {
      tileHighlights.unmarkReady(resolved.tile.id)
      return true
    }
    if (resolved.scanned?.spec?.view !== 'html') return false
    tileHighlights.markReady(resolved.tile.id)
    return true
  })

  ipcHandle('dashboards:release-frame', (_event, token: unknown): boolean => {
    userActivation.requireActivated()
    dashboardFrameOwners.forget(token)
    cloudFrames.released(token)
    return dashboardFrameServer.release(token)
  })
}
