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
 * A cloud agent's chat (D6.6) is the dashboard chat core keeps for the
 * (backing dashboard, agent): `POST /dashboards/{core}/chat` gives its core
 * session, and the local chat is an ordinary chat bound to the remote agent's
 * row whose `a2a_sessions` row is seeded with that session id as the A2A task
 * id (core's A2A handler resumes a session by `message.taskId`). The latest
 * local chat is resumed only while it still continues the session core
 * answered; `fresh` asks core for a new one (`new: true`) and makes a new chat.
 *
 * Every outcome is data. Core module: no Electron.
 */

import { agentSessionRepo } from '../../db/agents'
import { dashboardRepo } from '../../db/dashboards'
import { findCloudAgent } from './remote/cloudComponent'
import { createLogger } from '../../logger/logger'
import { chatService } from '../chatService'
import { dashboardService } from './dashboardService'
import { coreDashboardsClient, type CoreOutcome, type CoreSession } from './remote/coreDashboardsClient'
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
  /** A remote (cloud) agent row of this profile: its core agent id and name; null for anything else. */
  remoteAgent: (userId: string, agentId: string) => { remoteTargetId: string; name: string } | null
  /** The core dashboard backing the dashboard's cloud tiles, or null before its first one. */
  coreDashboardId: (userId: string, dashboardId: string) => string | null
  /** `POST /dashboards/{core}/chat {agent_id, new}`. */
  openCoreChat: (userId: string, coreDashboardId: string, remoteAgentId: string, fresh: boolean) => Promise<CoreOutcome<{ session: CoreSession | null }>>
  /** The core session the chat's A2A row continues (its task id), or null. */
  seededSession: (chatId: string, agentId: string) => string | null
  /** A new chat as {@link create}, its A2A row seeded with the core session. */
  createRemote: (userId: string, dashboardId: string, agentId: string, title: string, coreSessionId: string) => { id: string }
}

/** A new panel chat's title: "Sales overview · Sales Desk". */
export function panelChatTitle(dashboard: string, agent: string | null): string {
  return agent ? `${dashboard} · ${agent}` : dashboard
}

const refuse = (code: DashboardsErrorCode, message: string): PanelChatOutcome => ({ ok: false, code, message })

export function createPanelChatService(deps: PanelChatDeps) {
  async function openCloud(
    userId: string,
    dashboard: { id: string; name: string },
    agentId: string,
    agent: { remoteTargetId: string; name: string },
    fresh: boolean
  ): Promise<PanelChatOutcome> {
    const coreDashboardId = deps.coreDashboardId(userId, dashboard.id)
    if (!coreDashboardId) return refuse('not_found', 'This dashboard has no tile from that agent.')
    let answer: CoreOutcome<{ session: CoreSession | null }>
    try {
      answer = await deps.openCoreChat(userId, coreDashboardId, agent.remoteTargetId, fresh)
    } catch {
      return refuse('unreachable', 'The chat could not be reached.')
    }
    if (!answer.ok) {
      logger.info('core refused a dashboard chat', { dashboardId: dashboard.id, agentId, code: answer.code })
      return refuse(answer.code, answer.message)
    }
    const sessionId = answer.value.session && typeof answer.value.session.id === 'string' ? answer.value.session.id : null
    if (!sessionId) return refuse('not_found', 'The chat could not be started.')
    if (!fresh) {
      const latest = deps.latest(userId, dashboard.id, agentId)
      if (latest && deps.seededSession(latest.id, agentId) === sessionId) return { ok: true, chatId: latest.id }
    }
    try {
      const chat = deps.createRemote(userId, dashboard.id, agentId, panelChatTitle(dashboard.name, agent.name), sessionId)
      logger.info('dashboard panel chat created for a cloud agent', { dashboardId: dashboard.id, agentId, chatId: chat.id })
      return { ok: true, chatId: chat.id }
    } catch (err) {
      logger.warn('could not create a dashboard panel chat', { dashboardId: dashboard.id, agentId, error: err instanceof Error ? err.message : String(err) })
      return refuse('not_found', 'The chat could not be started.')
    }
  }

  return {
    async open(userId: string, input: unknown): Promise<PanelChatOutcome> {
      const value = input && typeof input === 'object' ? (input as Record<string, unknown>) : {}
      const { dashboardId, agentId } = value
      if (typeof dashboardId !== 'string' || !dashboardId || typeof agentId !== 'string' || !agentId) return refuse('invalid_input', 'Nothing to open.')
      if (value.fresh !== undefined && typeof value.fresh !== 'boolean') return refuse('invalid_input', 'Nothing to open.')
      const dashboard = deps.dashboard(userId, dashboardId)
      if (!dashboard) return refuse('not_found', 'That dashboard is gone.')
      if (!deps.isComponentAgent(agentId)) {
        const remote = deps.remoteAgent(userId, agentId)
        if (remote) return openCloud(userId, dashboard, agentId, remote, value.fresh === true)
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
  },
  remoteAgent: (userId, agentId) => {
    const agent = findCloudAgent(userId, agentId)
    return agent ? { remoteTargetId: agent.remoteTargetId, name: agent.name } : null
  },
  coreDashboardId: (userId, dashboardId) => dashboardRepo.get(userId, dashboardId)?.coreDashboardId ?? null,
  openCoreChat: (userId, coreDashboardId, remoteAgentId, fresh) => coreDashboardsClient.openChat(userId, coreDashboardId, remoteAgentId, fresh),
  seededSession: (chatId, agentId) => agentSessionRepo.getByChatAndAgent(chatId, agentId)?.taskId ?? null,
  createRemote: (userId, dashboardId, agentId, title, coreSessionId) => {
    const chat = chatService.create(userId, { originDashboardId: dashboardId, initialTitle: title })
    chatService.update(userId, chat.id, { router: 'direct', agentId })
    // The A2A driver sends this as `message.taskId`, which core resumes the dashboard chat session by.
    agentSessionRepo.upsert({ chatId: chat.id, agentId, contextId: null, taskId: coreSessionId, taskState: null })
    return chat
  }
}

export const panelChatService = createPanelChatService(defaultDeps)
