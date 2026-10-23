/**
 * Improvement Request: send one cloud conversation with a bundle agent to the
 * bundle's publisher, with the user's note. cinna-core decides everything that
 * matters — who receives it, what is captured, the limits — and this service
 * only decides *which* session of a desktop chat is meant, and asks.
 *
 * **Which sessions.** A Cinna agent's session id is the A2A `task_id` the
 * stream gave us, kept in `a2a_sessions` per (chat, agent). Every way a cloud
 * agent talks in a desktop chat writes it there under the chat's own id: the
 * direct chat, a human-routed chat, and a coordinator's nested call
 * (`A2AAsMcpProvider` → `runNestedAgentTurn` with the same `chatId`). A Cinna
 * *task* handed to a cloud agent is not: its sessions belong to the core task
 * and are never cached here (`cinnaTaskAdapter`), so they are not offered.
 *
 * Only a consumer install of a bundle ({@link isBundleAgent}) authenticated
 * with the account's own Cinna token qualifies: that is the agent a publisher
 * can improve, and the token is what makes core see the user as the session's
 * owner. A hand-added A2A agent with a typed token is never one.
 *
 * Core-side: no Electron, no window. Every answer, refusals included, is data.
 */
import { agentRepo, agentSessionRepo, type AgentRow } from '../db/agents'
import { chatOnDemandAgentRepo } from '../db/chatOnDemandAgent'
import { visibleChat } from '../auth/chatScope'
import { capabilitiesFor } from '../agents/drivers/capabilities'
import { isBundleAgent } from '../../shared/agentPresentation'
import {
  IMPROVEMENT_COMMENT_MAX,
  type ImprovementContext,
  type ImprovementOutcome,
  type ImprovementRequestCreated,
  type ImprovementTarget
} from '../../shared/improvementRequests'
import { cinnaSend, type CinnaSendResult } from './cinna-http'
import { CinnaApiError } from '../errors'
import { CinnaReauthRequired } from '../auth/cinna-oauth'
import { CinnaSessionChanged } from '../auth/cinna-session'
import { broadcastReauthRequired } from '../auth/reauth-notify'
import { createLogger } from '../logger/logger'

const logger = createLogger('improvement-requests')

/** core's ineligibility reasons, in its own words (`improvement_request_service.py`). */
const REASON_TEXT: Record<string, string> = {
  not_owner: 'Only the owner of this session can share it.',
  not_eligible: 'This session cannot be shared — it was not started from your own account.',
  empty_session: 'This session has no messages yet, so there is nothing to share.',
  agent_missing: 'The agent this session ran on no longer exists.',
  rate_limited: 'You have reached the limit for improvement requests on this session or for today. Try again later.'
}

type Located = { agent: AgentRow; sessionId: string; updatedAt: Date | null }

function eligibleAgent(agent: AgentRow): boolean {
  return isBundleAgent(agent) && capabilitiesFor(agent).auth === 'cinna'
}

/** The chat's sendable sessions, the bound agent's first. Empty for a chat the profile cannot see. */
function locate(userId: string, chatId: string): { bound: string | null; found: Located[] } {
  const chat = typeof chatId === 'string' ? visibleChat(userId, chatId) : undefined
  if (!chat) return { bound: null, found: [] }
  // Only agents still in the chat: the bound one and the attached ones — the
  // same set a coordinator's nested calls and an autonomous task's delegations
  // draw from. A session row outlives an agent removed from the chat.
  const attached = new Set(chatOnDemandAgentRepo.listAgentIds(chatId))
  if (chat.agentId) attached.add(chat.agentId)
  const found: Located[] = []
  for (const row of agentSessionRepo.listByChat(chatId)) {
    if (!row.taskId || !attached.has(row.agentId)) continue
    // Synced agents live in the profile's scope; nothing else can be one.
    const agent = agentRepo.getOwned(userId, row.agentId)
    if (!agent || !eligibleAgent(agent)) continue
    found.push({ agent, sessionId: row.taskId, updatedAt: row.updatedAt ?? null })
  }
  const bound = chat.agentId ?? null
  found.sort((a, b) => Number(b.agent.id === bound) - Number(a.agent.id === bound))
  return { bound, found }
}

function sessionFor(userId: string, chatId: unknown, agentId: unknown): Located | null {
  if (typeof chatId !== 'string' || typeof agentId !== 'string') return null
  return locate(userId, chatId).found.find((entry) => entry.agent.id === agentId) ?? null
}

const NO_TARGET = { ok: false, code: 'no_target', message: 'This agent has no cloud conversation in this chat to send.' } as const

/** A transport failure as a refusal; a lost session also raises the app-wide sign-in prompt. */
function failure(err: unknown, channel: string): { ok: false; code: 'reauth_required' | 'no_account' | 'failed'; message: string } {
  if (err instanceof CinnaReauthRequired || (err instanceof CinnaApiError && err.code === 'reauth_required')) {
    broadcastReauthRequired(channel)
    return { ok: false, code: 'reauth_required', message: 'Your Cinna session has expired. Sign in again, then try once more.' }
  }
  if (err instanceof CinnaApiError && (err.code === 'not_cinna_user' || err.code === 'missing_server_url')) {
    return { ok: false, code: 'no_account', message: 'This profile is not linked to a Cinna account.' }
  }
  if (err instanceof CinnaSessionChanged) {
    return { ok: false, code: 'failed', message: 'The Cinna account changed. Try again.' }
  }
  logger.warn('improvement request call failed', { channel, error: err instanceof Error ? err.message : String(err) })
  return { ok: false, code: 'failed', message: 'Cinna could not be reached. Check your connection and try again.' }
}

/** core's own sentence for a refusal (`{detail: "<message>"}`), or a fallback naming the status. */
function refusal(answer: CinnaSendResult): { ok: false; code: 'refused'; message: string } {
  const body = answer.body as { detail?: unknown } | null
  const detail = body && typeof body.detail === 'string' && body.detail.trim() ? body.detail.trim() : null
  return { ok: false, code: 'refused', message: detail ?? `Cinna refused the request (${answer.status}).` }
}

const str = (v: unknown): string | null => (typeof v === 'string' && v ? v : null)
const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0)

function toContext(raw: unknown): ImprovementContext {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  const eligible = r.eligible === true
  const reason = eligible ? null : str(r.reason) ?? 'not_eligible'
  return {
    eligible,
    reason,
    reasonText: reason ? REASON_TEXT[reason] ?? 'This session cannot be sent as an improvement request.' : null,
    isSharedExternally: r.is_shared_externally === true,
    recipientDisplay: str(r.recipient_display),
    targetAgentName: str(r.target_agent_name),
    bundleId: str(r.bundle_id),
    installedVersion: str(r.installed_version),
    messageCount: num(r.message_count),
    existingRequestCount: num(r.existing_request_count)
  }
}

export const improvementRequestService = {
  /** The agents of this chat whose cloud session can be sent; no network. */
  listTargets(userId: string, chatId: unknown): ImprovementTarget[] {
    if (typeof chatId !== 'string') return []
    const { bound, found } = locate(userId, chatId)
    return found.map(({ agent, updatedAt }) => ({
      agentId: agent.id,
      agentName: agent.name,
      lastActivityAt: updatedAt ? updatedAt.getTime() : null,
      bound: agent.id === bound
    }))
  },

  /** core's pre-flight for one target: recipient, message count, and whether it can be sent. */
  async context(userId: string, chatId: unknown, agentId: unknown): Promise<ImprovementOutcome<{ context: ImprovementContext }>> {
    const located = sessionFor(userId, chatId, agentId)
    if (!located) return NO_TARGET
    try {
      const answer = await cinnaSend(userId, `/api/v1/sessions/${encodeURIComponent(located.sessionId)}/improvement-context`, { method: 'GET' })
      if (!answer.ok) return refusal(answer)
      return { ok: true, context: toContext(answer.body) }
    } catch (err) {
      return failure(err, 'improvement:context')
    }
  },

  /**
   * Send it. The comment is required here (core makes it optional; the desktop
   * asks for one), trimmed, and at most {@link IMPROVEMENT_COMMENT_MAX}.
   * A 403 is core's "not the session's owner", not a lost sign-in — only a 401
   * is (`cinnaSend`). Memory is sent only on an explicit `true`: consent is
   * never assumed from a missing field (the dialog's checkbox starts ticked).
   */
  async create(
    userId: string,
    chatId: unknown,
    agentId: unknown,
    input: { comment?: unknown; includeMemory?: unknown }
  ): Promise<ImprovementOutcome<{ request: ImprovementRequestCreated }>> {
    const comment = typeof input?.comment === 'string' ? input.comment.trim() : ''
    if (!comment) return { ok: false, code: 'invalid_comment', message: 'Describe what should be improved.' }
    if (comment.length > IMPROVEMENT_COMMENT_MAX) {
      return { ok: false, code: 'invalid_comment', message: `Keep the message under ${IMPROVEMENT_COMMENT_MAX.toLocaleString('en-US')} characters.` }
    }
    const located = sessionFor(userId, chatId, agentId)
    if (!located) return NO_TARGET
    try {
      const answer = await cinnaSend(userId, '/api/v1/improvement-requests', {
        method: 'POST',
        json: { session_id: located.sessionId, comment, include_memory: input?.includeMemory === true }
      })
      if (!answer.ok) return refusal(answer)
      const body = (answer.body && typeof answer.body === 'object' ? answer.body : {}) as Record<string, unknown>
      logger.info('improvement request sent', { agentId: located.agent.id, requestId: str(body.id) })
      return { ok: true, request: { id: str(body.id) ?? '' } }
    } catch (err) {
      return failure(err, 'improvement:create')
    }
  }
}
