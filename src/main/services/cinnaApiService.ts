import { net } from 'electron'
import { userRepo } from '../db/users'
import { getCinnaAccessToken } from '../auth/cinna-tokens'
import { CinnaReauthRequired } from '../auth/cinna-oauth'
import { CinnaApiError } from '../errors'
import { createLogger } from '../logger/logger'
import type {
  CinnaTaskAttachmentDto,
  CinnaTaskCommentDto,
  CinnaTaskViewDto
} from '../../shared/cinnaTaskView'

export type { CinnaTaskAttachmentDto, CinnaTaskCommentDto, CinnaTaskViewDto }

const logger = createLogger('cinna-api')

export interface CinnaAgentDto {
  id: string
  name: string
  description: string | null
}

export interface CinnaTaskCreateRequest {
  original_message: string
  title: string
  selected_agent_id: string
  priority?: string
  auto_execute?: boolean
}

interface PaginatedResponse<T> {
  data: T[]
  count: number
}

function unwrapPaginated<T>(data: unknown, path: string): T[] {
  if (data && typeof data === 'object' && Array.isArray((data as PaginatedResponse<T>).data)) {
    return (data as PaginatedResponse<T>).data
  }
  throw new CinnaApiError('invalid_response', `Expected paginated {data} from ${path}`)
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
    const body = await cinnaFetch<unknown>(userId, '/api/v1/agents/')
    const items = unwrapPaginated<Record<string, unknown>>(body, '/api/v1/agents/')
    return items.map((r): CinnaAgentDto => ({
      id: String(r.id ?? ''),
      name: String(r.name ?? r.id ?? 'Unnamed'),
      description: typeof r.description === 'string' ? r.description : null
    }))
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
   * Fetch the full cinna task detail (`InputTaskDetailPublic`) which already
   * embeds `comments` and `attachments` — single roundtrip instead of three.
   * Comments contain inline attachments (matched by `comment_id` on the
   * server side); standalone (task-level) attachments are surfaced in the
   * top-level `attachments` array.
   *
   * Parsing is tolerant of missing/optional fields. Author display is taken
   * from the server-resolved `author_name` / `author_role` (see
   * `TaskCommentService._to_public`); when those are absent (legacy rows or
   * `system` comments) we fall back to "System" or "Unknown".
   */
  async getTaskView(userId: string, taskId: string): Promise<CinnaTaskViewDto> {
    logger.info('fetching cinna task view', { taskId })
    const data = await cinnaFetch<Record<string, unknown>>(
      userId,
      `/api/v1/tasks/${encodeURIComponent(taskId)}/detail`
    )

    const task: CinnaTaskDetail = {
      id: String(data.id ?? taskId),
      short_code: typeof data.short_code === 'string' ? data.short_code : null,
      status: String(data.status ?? 'new'),
      title: String(data.title ?? '')
    }

    const commentsRaw = Array.isArray(data.comments) ? data.comments : []
    const comments = commentsRaw
      .map(parseComment)
      .filter((c): c is CinnaTaskCommentDto => c !== null)

    const attachmentsRaw = Array.isArray(data.attachments) ? data.attachments : []
    const attachments = parseAttachmentList(attachmentsRaw)

    logger.info('cinna task view loaded', {
      taskId,
      commentCount: comments.length,
      attachmentCount: attachments.length
    })
    return { task, comments, attachments }
  },

  /**
   * Resolve the configured Cinna server URL so the renderer can build deep
   * links (e.g. /tasks/{short_code}) without re-implementing the lookup.
   */
  getServerUrl(userId: string): string {
    return resolveBaseUrl(userId)
  }
}

// ---------- Lenient parsing helpers ----------

function asString(v: unknown): string | null {
  if (typeof v === 'string' && v.length > 0) return v
  if (typeof v === 'number') return String(v)
  return null
}

function asNumber(v: unknown): number | null {
  if (typeof v === 'number' && Number.isFinite(v)) return v
  if (typeof v === 'string') {
    const n = Number(v)
    return Number.isFinite(n) ? n : null
  }
  return null
}

function pick<T extends string>(
  row: Record<string, unknown>,
  ...keys: T[]
): unknown {
  for (const k of keys) {
    if (row[k] !== undefined && row[k] !== null) return row[k]
  }
  return null
}

/**
 * Parse a `TaskAttachmentPublic` row from cinna-core. Real field names:
 *   id, file_name, file_size, content_type, created_at, comment_id?
 */
function parseAttachment(raw: unknown): CinnaTaskAttachmentDto | null {
  if (!raw || typeof raw !== 'object') return null
  const row = raw as Record<string, unknown>
  const id = asString(pick(row, 'id'))
  if (!id) return null
  return {
    id,
    filename:
      asString(pick(row, 'file_name', 'filename', 'name', 'original_filename')) ??
      'unnamed',
    size: asNumber(pick(row, 'file_size', 'size', 'size_bytes')),
    mimeType: asString(pick(row, 'content_type', 'mime_type', 'mimeType', 'contentType')),
    url: asString(pick(row, 'download_url', 'url'))
  }
}

function parseAttachmentList(raw: unknown): CinnaTaskAttachmentDto[] {
  if (!Array.isArray(raw)) return []
  return raw
    .map(parseAttachment)
    .filter((a): a is CinnaTaskAttachmentDto => a !== null)
}

/**
 * Parse a `TaskCommentPublic` row. Server resolves authorship into the flat
 * `author_name` + `author_role` fields (see TaskCommentService._to_public);
 * we surface both. `inline_attachments` (server's name) carries per-comment
 * files — also accept `attachments` as a fallback.
 */
function parseComment(raw: unknown): CinnaTaskCommentDto | null {
  if (!raw || typeof raw !== 'object') return null
  const row = raw as Record<string, unknown>
  const id = asString(pick(row, 'id'))
  if (!id) return null

  const commentType = (asString(pick(row, 'comment_type', 'commentType')) ?? 'message') as
    CinnaTaskCommentDto['commentType']

  const attachments = parseAttachmentList(
    pick(row, 'inline_attachments', 'attachments', 'files')
  )

  return {
    id,
    commentType,
    authorName: asString(pick(row, 'author_name', 'authorName')),
    authorRole: asString(pick(row, 'author_role', 'authorRole')),
    authorId: asString(
      pick(row, 'author_user_id', 'author_agent_id', 'authorId', 'author_id')
    ),
    content: asString(pick(row, 'content', 'text', 'body')) ?? '',
    createdAt: asString(pick(row, 'created_at', 'createdAt', 'timestamp')),
    attachments
  }
}
