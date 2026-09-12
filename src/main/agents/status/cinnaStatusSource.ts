import { net } from 'electron'
import type { AgentRow } from '../../db/agents'
import type { AgentStatusSnapshot, AgentStatusSeverity } from '../../../shared/agentStatus'
import { CINNA_STATUS_REFRESH_DESCRIPTION } from '../../../shared/agentStatus'
import type { AgentStatusSource } from './contract'
import { userRepo } from '../../db/users'
import { getCinnaAccessToken } from '../../auth/cinna-tokens'
import { AgentStatusError } from '../../errors'
import { createLogger } from '../../logger/logger'

const logger = createLogger('cinna-status')

/** Reads existing environment status; no local command is ever involved. */
export function cinnaStatusSource(userId: string, agent: Pick<AgentRow, 'id' | 'name' | 'remoteTargetId'>): AgentStatusSource {
  return { read: (intent) => readCinnaStatus(userId, agent, intent !== 'read') }
}

export interface AgentStatusPublicRaw {
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

export function toSnapshot(
  raw: AgentStatusPublicRaw,
  localId: string,
  name: string
): AgentStatusSnapshot {
  return {
    agentId: localId,
    refreshDescription: CINNA_STATUS_REFRESH_DESCRIPTION,
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

export async function getCinnaContext(
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
export function errorFromStatus(status: number, statusText: string, url: string): AgentStatusError {
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


async function readCinnaStatus(userId: string, agent: Pick<AgentRow, 'id' | 'name' | 'remoteTargetId'>, forceRefresh: boolean): Promise<AgentStatusSnapshot | null> {
  const agentId = agent.id
    const ctx = await getCinnaContext(userId)
    if (!ctx) return null

    if (!agent.remoteTargetId) return null

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

    let item: AgentStatusPublicRaw
    try {
      item = (await response.json()) as AgentStatusPublicRaw
    } catch (err) {
      // The same unguarded `response.json()` `list` carried: a 200 whose body is
      // not JSON — a captive portal or a proxy login page — reaches here past
      // the `!response.ok` check and rejects with a raw `SyntaxError`. It is
      // milder today only because the *renderer* now renders an unrecognised
      // rejection instead of swallowing it, and a distant repair is not a thing
      // this call site should depend on.
      logger.warn('agent status get unreadable response', { url, agentId, error: String(err) })
      throw new AgentStatusError(
        'remote_unreachable',
        'Cinna backend returned an unreadable response',
        String(err)
      )
    }
    logger.info('agent status get response', {
      url,
      agentId,
      status: response.status,
      durationMs,
      severity: item.severity
    })
    return toSnapshot(item, agent.id, agent.name)
}
