/**
 * Shared authenticated HTTP client for the active profile's Cinna server.
 *
 * One canonical place that resolves the profile's server URL + Bearer JWT,
 * issues the request via Electron `net.fetch`, measures latency, and maps
 * transport/HTTP failures onto typed {@link CinnaApiError} codes the renderer
 * can switch on. Both `catalogService` (`/api/v1/catalog/*`) and `agentService`
 * (native install update endpoints) consume this so auth, error mapping, and
 * observability stay identical across every Cinna call.
 *
 * Error contract:
 *   - 401/403            → `CinnaApiError('reauth_required')`, `detail` = the status
 *                          (a 403 on a role-gated route is not a dead session)
 *   - other non-2xx      → `CinnaApiError('request_failed', '<status>: <detail>')`
 *   - network failure    → `CinnaApiError('request_failed', <message>)`
 *   - non-JSON 2xx body  → `CinnaApiError('invalid_response', <message>)`
 *   - no/!cinna profile  → `CinnaApiError('not_cinna_user' | 'missing_server_url')`
 *   - token refresh fail → re-mapped from {@link CinnaReauthRequired} to
 *                          `CinnaApiError('reauth_required')`
 */
import { net } from 'electron'
import { userRepo } from '../db/users'
import { getCinnaAccessToken } from '../auth/cinna-tokens'
import { CinnaReauthRequired } from '../auth/cinna-oauth'
import { CinnaApiError } from '../errors'
import { createLogger } from '../logger/logger'

const logger = createLogger('cinna-http')

export interface FetchOptions {
  method?: string
  body?: unknown
}

/** Resolve the active profile's Cinna server base URL (trailing slash stripped). */
export function resolveBaseUrl(userId: string): string {
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

/**
 * Best-effort extraction of a human-readable error message from a cinna-server
 * response body. FastAPI surfaces failures as `{ detail: "<message>" }`, our
 * own handlers sometimes use `{ message: "..." }`; everything else falls back
 * to the raw body slice so we never accidentally suppress server-supplied
 * context.
 */
function extractErrorDetail(text: string): string {
  const trimmed = text.trim()
  if (!trimmed) return ''
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    try {
      const parsed = JSON.parse(trimmed) as Record<string, unknown>
      const detail = parsed.detail
      if (typeof detail === 'string' && detail) return detail
      const message = parsed.message
      if (typeof message === 'string' && message) return message
    } catch {
      // JSON-shaped but not valid JSON; fall through to raw text.
    }
  }
  return trimmed.slice(0, 200)
}

/**
 * Resolve `path` against the profile's server.
 *
 * A leading `/` is the ordinary case and the only one most callers use. An
 * **absolute URL** is accepted for the endpoints an instance publishes in its
 * discovery document: on a split-host deployment the API lives on a different
 * origin than the one the user typed, so `${base}${path}` would 404. Those
 * endpoints are exactly as trusted as the server itself — the OAuth
 * `token_endpoint` and `userinfo_endpoint` are already followed the same way —
 * but the bearer is only ever sent over TLS (or to loopback, for a developer
 * running a server locally), which is the one guarantee worth restating here.
 */
function resolveUrl(baseUrl: string, path: string): string {
  if (!/^https?:\/\//i.test(path)) return `${baseUrl}${path}`
  const url = new URL(path)
  const loopback = url.hostname === 'localhost' || url.hostname === '127.0.0.1'
  if (url.protocol !== 'https:' && !loopback) {
    throw new CinnaApiError(
      'request_failed',
      'Refusing to send account credentials over an unencrypted connection.'
    )
  }
  return url.toString()
}

export async function cinnaFetch<T>(
  userId: string,
  path: string,
  opts: FetchOptions = {}
): Promise<T> {
  const baseUrl = resolveBaseUrl(userId)
  const authHeader = await resolveAuthHeader(userId)
  const url = resolveUrl(baseUrl, path)
  const method = opts.method ?? 'GET'

  const headers: Record<string, string> = {
    Authorization: authHeader,
    Accept: 'application/json'
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
      // The status travels in `detail` because 401 and 403 are the same code
      // here but not the same situation: a 403 on the setup-token mint means
      // "your account lacks the agent-developer role", which is a supported
      // state the local-dev reconciler explains rather than a session to
      // re-authenticate. Callers that only care about "the session is gone"
      // keep switching on the code and never look at this.
      throw new CinnaApiError(
        'reauth_required',
        `Cinna ${response.status}`,
        String(response.status)
      )
    }
    const detail = extractErrorDetail(text) || response.statusText
    throw new CinnaApiError('request_failed', `Cinna API ${response.status}: ${detail}`)
  }
  try {
    return (await response.json()) as T
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    logger.error('invalid response', { url, method, error: msg })
    throw new CinnaApiError('invalid_response', msg)
  }
}
