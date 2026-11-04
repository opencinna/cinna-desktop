import { visibleChat } from '../../auth/chatScope'
import { dashboardRepo } from '../../db/dashboards'
import { publishEvent } from '../../host/events'
import { DASHBOARDS_TILE_HIGHLIGHT_CHANNEL, type DashboardsTileHighlightPayload } from '../../../shared/dashboards'
import { dashboardContextTracker } from './dashboardContext'
import { dashboardRefreshService } from './dashboardRefreshService'
import { dashboardService } from './dashboardService'
import { DashboardTileToolProvider, type DashboardTileToolSession } from './dashboardTileTools'
import { tileHighlights } from './tileHighlights'

/**
 * The agent's `dashboards_tiles` and `dashboards_update_tile`, wired to the
 * app's services. `conductorBridge` decides who is offered them; every call
 * reads the chat, the dashboard and the tiles again.
 */
export function dashboardTileToolProviderFor(session: DashboardTileToolSession): DashboardTileToolProvider {
  return new DashboardTileToolProvider(session, {
    chat: (profileUserId, chatId) => visibleChat(profileUserId, chatId) ?? null,
    dashboard: (profileUserId, dashboardId) => dashboardRepo.get(profileUserId, dashboardId),
    tiles: (profileUserId, dashboardId) => dashboardService.resolvedTiles(profileUserId, dashboardId),
    setParams: (profileUserId, input) => dashboardRefreshService.setParams(profileUserId, input),
    retryAfterSeconds: (tileId) => dashboardRefreshService.retryAfterSeconds(tileId),
    lastContext: (chatId) => dashboardContextTracker.lastContext(chatId),
    highlights: tileHighlights,
    publishHighlight: (tileId, ids) => publishEvent(DASHBOARDS_TILE_HIGHLIGHT_CHANNEL, { tileId, ids } satisfies DashboardsTileHighlightPayload)
  })
}
