/**
 * The dashboard panel's chat (README D12): one session per agent per
 * dashboard. The latest chat this profile sees that was opened from the
 * dashboard for the agent is resumed; `fresh` ("New chat") always makes a new
 * one. A new chat is made the way the agent page's composer makes one — an
 * empty chat, then bound `direct` to the agent through `chatService.update`,
 * which settles its owner — with `originDashboardId` set at creation. It is
 * titled "<dashboard> · <agent>", so several panel chats tell apart in Chats;
 * the title is a placeholder auto titling still replaces (`initialTitle`).
 *
 * Every outcome is data. Core module: no Electron.
 */

import { dashboardRepo } from '../../db/dashboards'
import { createLogger } from '../../logger/logger'
import { chatService } from '../chatService'
import { dashboardService } from './dashboardService'
import type { DashboardsErrorCode, PanelChatOutcome } from '../../../shared/dashboards'

const logger = createLogger('dashboards')

export interface PanelChatDeps {
  /** The dashboard, when it is this profile's. */
  dashboard: (userId: string, dashboardId: string) => { id: string; name: string } | null
  /** A kit agent on this machine: one whose components dashboards show (`dashboardService` decides). */
  isComponentAgent: (agentId: string) => boolean
  /** Another local agent (a bare folder): known here, but it has no components. */
  isOtherLocalAgent: (agentId: string) => boolean
  latest: (userId: string, dashboardId: string, agentId: string) => { id: string } | null
  /** The kit agent's display name. */
  agentName: (agentId: string) => string | null
  /** A new chat with the origin and the placeholder title, bound `direct` to the agent. */
  create: (userId: string, dashboardId: string, agentId: string, title: string) => { id: string }
}

/** A new panel chat's title: "Sales overview · Sales Desk". */
export function panelChatTitle(dashboard: string, agent: string | null): string {
  return agent ? `${dashboard} · ${agent}` : dashboard
}

const refuse = (code: DashboardsErrorCode, message: string): PanelChatOutcome => ({ ok: false, code, message })

export function createPanelChatService(deps: PanelChatDeps) {
  return {
    open(userId: string, input: unknown): PanelChatOutcome {
      const value = input && typeof input === 'object' ? (input as Record<string, unknown>) : {}
      const { dashboardId, agentId } = value
      if (typeof dashboardId !== 'string' || !dashboardId || typeof agentId !== 'string' || !agentId) return refuse('invalid_input', 'Nothing to open.')
      if (value.fresh !== undefined && typeof value.fresh !== 'boolean') return refuse('invalid_input', 'Nothing to open.')
      const dashboard = deps.dashboard(userId, dashboardId)
      if (!dashboard) return refuse('not_found', 'That dashboard is gone.')
      if (!deps.isComponentAgent(agentId)) {
        return deps.isOtherLocalAgent(agentId)
          ? refuse('not_kit_agent', 'Only a kit agent can chat from a dashboard.')
          : refuse('not_found', 'That agent is not on this computer.')
      }
      if (value.fresh !== true) {
        const latest = deps.latest(userId, dashboardId, agentId)
        if (latest) return { ok: true, chatId: latest.id }
      }
      try {
        const chat = deps.create(userId, dashboardId, agentId, panelChatTitle(dashboard.name, deps.agentName(agentId)))
        logger.info('dashboard panel chat created', { dashboardId, agentId, chatId: chat.id })
        return { ok: true, chatId: chat.id }
      } catch (err) {
        logger.warn('could not create a dashboard panel chat', { dashboardId, agentId, error: err instanceof Error ? err.message : String(err) })
        return refuse('not_found', 'The chat could not be started.')
      }
    }
  }
}

export type PanelChatService = ReturnType<typeof createPanelChatService>

const defaultDeps: PanelChatDeps = {
  dashboard: (userId, dashboardId) => dashboardRepo.get(userId, dashboardId),
  isComponentAgent: (agentId) => dashboardService.isComponentAgent(agentId),
  isOtherLocalAgent: (agentId) => dashboardService.isOtherLocalAgent(agentId),
  latest: (userId, dashboardId, agentId) => chatService.latestFromDashboard(userId, dashboardId, agentId),
  agentName: (agentId) => dashboardService.agentName(agentId),
  create: (userId, dashboardId, agentId, title) => {
    const chat = chatService.create(userId, { originDashboardId: dashboardId, initialTitle: title })
    // The agent page's composer binds its new chat with this same update
    // (`useNewChatFlow`: `router: 'direct'`, `agentId`), which settles the owner.
    chatService.update(userId, chat.id, { router: 'direct', agentId })
    return chat
  }
}

export const panelChatService = createPanelChatService(defaultDeps)
