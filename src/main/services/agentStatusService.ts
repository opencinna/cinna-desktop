import { net } from 'electron'
import { agentRepo } from '../db/agents'
import { userRepo } from '../db/users'
import { getCinnaAccessToken } from '../auth/cinna-tokens'
import { CinnaReauthRequired } from '../auth/cinna-oauth'
import { AgentStatusError } from '../errors'
import { createLogger } from '../logger/logger'

const logger = createLogger('agent-status')

export type AgentStatusSeverity = 'ok' | 'warning' | 'error' | 'info' | 'unknown'

export interface AgentStatusSnapshot {
  agentId: string
  remoteAgentId: string
  name: string
  environmentId: string | null
  severity: AgentStatusSeverity | null
  summary: string | null
  reportedAt: string | null
  reportedAtSource: 'frontmatter' | 'file_mtime' | null
  fetchedAt: string | null
  raw: string | null
  body: string | null
  hasStructuredMetadata: boolean
  prevSeverity: string | null
  severityChangedAt: string | null
}

interface AgentStatusPublicRaw {
  agent_id: string
  environment_id: string | null
  severity: AgentStatusSeverity | null
  summary: string | null
  reported_at: string | null
  reported_at_source: 'frontmatter' | 'file_mtime' | null
  fetched_at: string | null
  raw: string | null
  body: string | null
  has_structured_metadata: boolean
  prev_severity: string | null
  severity_changed_at: string | null
}

function toSnapshot(
  raw: AgentStatusPublicRaw,
  localId: string,
  name: string
): AgentStatusSnapshot {
  return {
    agentId: localId,
    remoteAgentId: raw.agent_id,
    name,
    environmentId: raw.environment_id,
    severity: raw.severity,
    summary: raw.summary,
    reportedAt: raw.reported_at,
    reportedAtSource: raw.reported_at_source,
    fetchedAt: raw.fetched_at,
    raw: raw.raw,
    body: raw.body,
    hasStructuredMetadata: raw.has_structured_metadata,
    prevSeverity: raw.prev_severity,
    severityChangedAt: raw.severity_changed_at
  }
}

async function getCinnaContext(
  userId: string
): Promise<{ baseUrl: string; accessToken: string } | null> {
  const user = userRepo.get(userId)
  if (!user || user.type !== 'cinna_user' || !user.cinnaServerUrl) return null
  const accessToken = await getCinnaAccessToken(userId)
  return { baseUrl: user.cinnaServerUrl.replace(/\/$/, ''), accessToken }
}

/**
 * Maps an HTTP failure to a typed {@link AgentStatusError}. Keeps error codes
 * stable across the IPC boundary so the renderer can branch on them.
 */
function errorFromStatus(status: number, statusText: string, url: string): AgentStatusError {
  if (status === 404) return new AgentStatusError('not_found', 'Agent status not found')
  if (status === 403) return new AgentStatusError('forbidden', 'Not authorized to view this agent')
  if (status >= 500)
    return new AgentStatusError(
      'remote_unreachable',
      `Backend returned ${status} ${statusText}`,
      url
    )
  return new AgentStatusError(
    'unknown',
    `Status fetch failed: ${status} ${statusText}`,
    url
  )
}

export const agentStatusService = {
  /**
   * Batch list — cache-only, safe to poll. Filters backend rows down to agents
   * the local DB knows about (by remoteTargetId) and hides sentinel snapshots
   * (severity == null && raw == null) per the integration spec.
   */
  async list(userId: string): Promise<AgentStatusSnapshot[]> {
    const ctx = await getCinnaContext(userId)
    if (!ctx) return []

    const url = `${ctx.baseUrl}/api/v1/agents/status`
    logger.info('agent status list request', { url })
    const t0 = Date.now()

    let response: Response
    try {
      response = await net.fetch(url, {
        headers: {
          Authorization: `Bearer ${ctx.accessToken}`,
          Accept: 'application/json'
        }
      })
    } catch (err) {
      const durationMs = Date.now() - t0
      logger.error('agent status list network error', {
        url,
        durationMs,
        error: String(err)
      })
      throw new AgentStatusError(
        'remote_unreachable',
        'Failed to reach Cinna backend',
        String(err)
      )
    }

    const durationMs = Date.now() - t0
    if (!response.ok) {
      logger.warn('agent status list non-OK response', {
        url,
        status: response.status,
        statusText: response.statusText,
        durationMs
      })
      throw errorFromStatus(response.status, response.statusText, url)
    }

    const data = (await response.json()) as { items?: AgentStatusPublicRaw[] }

    const localAgents = agentRepo.listRemote(userId)
    const byRemoteId = new Map(localAgents.map((a) => [a.remoteTargetId!, a]))

    const snapshots: AgentStatusSnapshot[] = []
    for (const item of data.items ?? []) {
      const local = byRemoteId.get(item.agent_id)
      if (!local) continue
      if (item.severity === null && item.raw === null) continue
      snapshots.push(toSnapshot(item, local.id, local.name))
    }

    logger.info('agent status list response', {
      url,
      status: response.status,
      durationMs,
      totalItems: data.items?.length ?? 0,
      localMatches: snapshots.length
    })
    return snapshots
  },

  /**
   * Per-agent fetch. `forceRefresh=true` asks the backend to re-read STATUS.md
   * from the running env; 429 is swallowed (returns null) so callers fall back
   * to whatever the cache already surfaced.
   */
  async get(
    userId: string,
    agentId: string,
    forceRefresh: boolean
  ): Promise<AgentStatusSnapshot | null> {
    const ctx = await getCinnaContext(userId)
    if (!ctx) return null

    const agent = agentRepo.getOwned(userId, agentId)
    if (!agent || !agent.remoteTargetId) return null

    const url = `${ctx.baseUrl}/api/v1/agents/${agent.remoteTargetId}/status?force_refresh=${forceRefresh ? 'true' : 'false'}`
    logger.info('agent status get request', { url, agentId, forceRefresh })
    const t0 = Date.now()

    let response: Response
    try {
      response = await net.fetch(url, {
        headers: {
          Authorization: `Bearer ${ctx.accessToken}`,
          Accept: 'application/json'
        }
      })
    } catch (err) {
      const durationMs = Date.now() - t0
      logger.error('agent status get network error', {
        url,
        agentId,
        durationMs,
        error: String(err)
      })
      throw new AgentStatusError(
        'remote_unreachable',
        'Failed to reach Cinna backend',
        String(err)
      )
    }

    const durationMs = Date.now() - t0

    if (response.status === 429) {
      logger.info('agent status rate-limited', { agentId, durationMs })
      return null
    }
    if (!response.ok) {
      logger.warn('agent status get non-OK response', {
        url,
        agentId,
        status: response.status,
        statusText: response.statusText,
        durationMs
      })
      throw errorFromStatus(response.status, response.statusText, url)
    }

    const item = (await response.json()) as AgentStatusPublicRaw
    logger.info('agent status get response', {
      url,
      agentId,
      status: response.status,
      durationMs,
      severity: item.severity
    })
    return toSnapshot(item, agent.id, agent.name)
  }
}

export { CinnaReauthRequired }
