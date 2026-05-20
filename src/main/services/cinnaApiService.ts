import { net } from 'electron'
import { userRepo } from '../db/users'
import { getCinnaAccessToken } from '../auth/cinna-tokens'
import { CinnaReauthRequired } from '../auth/cinna-oauth'
import { CinnaApiError } from '../errors'
import { createLogger } from '../logger/logger'

const logger = createLogger('cinna-api')

export interface CinnaAgentDto {
  id: string
  name: string
  description: string | null
  team_id: string | null
}

export interface CinnaTeamDto {
  id: string
  name: string
  task_prefix: string | null
  nodes: Array<{ id: string; name: string }>
}

export interface CinnaTaskCreateRequest {
  original_message: string
  current_description: string
  title: string
  selected_agent_id: string
  team_id?: string | null
  assigned_node_id?: string | null
  priority?: string
  auto_execute?: boolean
}

export interface CinnaTaskRef {
  id: string
  short_code: string | null
  status: string
}

export interface CinnaTaskDetail extends CinnaTaskRef {
  title: string
}

interface FetchOptions {
  method?: string
  body?: unknown
  headers?: Record<string, string>
}

function resolveBaseUrl(userId: string): string {
  const user = userRepo.get(userId)
  if (!user) throw new CinnaApiError('not_cinna_user', 'User not found')
  if (user.type !== 'cinna_user') {
    throw new CinnaApiError('not_cinna_user', 'Profile is not linked to Cinna')
  }
  if (!user.cinnaServerUrl) {
    throw new CinnaApiError('missing_server_url', 'Cinna server URL is not configured')
  }
  return user.cinnaServerUrl.replace(/\/$/, '')
}

async function resolveAuthHeader(userId: string): Promise<string> {
  try {
    const token = await getCinnaAccessToken(userId)
    return `Bearer ${token}`
  } catch (err) {
    if (err instanceof CinnaReauthRequired) {
      throw new CinnaApiError('reauth_required', err.message)
    }
    throw err
  }
}

async function cinnaFetch<T>(userId: string, path: string, opts: FetchOptions = {}): Promise<T> {
  const baseUrl = resolveBaseUrl(userId)
  const authHeader = await resolveAuthHeader(userId)
  const url = `${baseUrl}${path}`
  const method = opts.method ?? 'GET'

  const headers: Record<string, string> = {
    Authorization: authHeader,
    Accept: 'application/json',
    ...(opts.headers ?? {})
  }

  let body: BodyInit | undefined
  if (opts.body !== undefined) {
    headers['Content-Type'] = 'application/json'
    body = JSON.stringify(opts.body)
  }

  const started = Date.now()
  let response: Response
  try {
    response = await net.fetch(url, { method, headers, body })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    logger.error('network error', { url, method, error: msg, durationMs: Date.now() - started })
    throw new CinnaApiError('request_failed', msg)
  }

  if (!response.ok) {
    const text = await response.text().catch(() => '')
    logger.warn('request failed', {
      url,
      method,
      status: response.status,
      durationMs: Date.now() - started
    })
    if (response.status === 401 || response.status === 403) {
      throw new CinnaApiError('reauth_required', `Cinna ${response.status}`)
    }
    throw new CinnaApiError(
      'request_failed',
      `Cinna API ${response.status}: ${text.slice(0, 200) || response.statusText}`
    )
  }

  try {
    return (await response.json()) as T
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    logger.error('invalid response', { url, method, error: msg })
    throw new CinnaApiError('invalid_response', msg)
  }
}

export const cinnaApiService = {
  async listAgents(userId: string): Promise<CinnaAgentDto[]> {
    const data = await cinnaFetch<unknown>(userId, '/api/v1/agents/')
    if (!Array.isArray(data)) {
      throw new CinnaApiError('invalid_response', 'Expected array from /api/v1/agents/')
    }
    return data.map((raw): CinnaAgentDto => {
      const r = raw as Record<string, unknown>
      return {
        id: String(r.id ?? ''),
        name: String(r.name ?? r.id ?? 'Unnamed'),
        description: typeof r.description === 'string' ? r.description : null,
        team_id: typeof r.team_id === 'string' ? r.team_id : null
      }
    })
  },

  async listTeams(userId: string): Promise<CinnaTeamDto[]> {
    const data = await cinnaFetch<unknown>(userId, '/api/v1/teams/')
    if (!Array.isArray(data)) {
      throw new CinnaApiError('invalid_response', 'Expected array from /api/v1/teams/')
    }
    return data.map((raw): CinnaTeamDto => {
      const r = raw as Record<string, unknown>
      const nodes = Array.isArray(r.nodes)
        ? (r.nodes as Array<Record<string, unknown>>).map((n) => ({
            id: String(n.id ?? ''),
            name: String(n.name ?? n.id ?? 'Unnamed')
          }))
        : []
      return {
        id: String(r.id ?? ''),
        name: String(r.name ?? r.id ?? 'Unnamed team'),
        task_prefix: typeof r.task_prefix === 'string' ? r.task_prefix : null,
        nodes
      }
    })
  },

  async createTask(userId: string, payload: CinnaTaskCreateRequest): Promise<CinnaTaskRef> {
    const data = await cinnaFetch<Record<string, unknown>>(userId, '/api/v1/tasks/', {
      method: 'POST',
      body: payload
    })
    return {
      id: String(data.id ?? ''),
      short_code: typeof data.short_code === 'string' ? data.short_code : null,
      status: String(data.status ?? 'new')
    }
  },

  async getTaskDetail(userId: string, taskId: string): Promise<CinnaTaskDetail> {
    const data = await cinnaFetch<Record<string, unknown>>(
      userId,
      `/api/v1/tasks/${encodeURIComponent(taskId)}/detail`
    )
    return {
      id: String(data.id ?? taskId),
      short_code: typeof data.short_code === 'string' ? data.short_code : null,
      status: String(data.status ?? 'new'),
      title: String(data.title ?? '')
    }
  },

  /**
   * Resolve the configured Cinna server URL so the renderer can build deep
   * links (e.g. /tasks/{short_code}) without re-implementing the lookup.
   */
  getServerUrl(userId: string): string {
    return resolveBaseUrl(userId)
  }
}
