import { runtimeHost } from '../host/runtimeHost'
/**
 * Shared authenticated HTTP client for the active profile's Cinna server.
 *
 * One canonical place that resolves the profile's server URL + Bearer JWT,
 * issues the request via the host HTTP client (`net.fetch` on desktop), measures latency, and maps
 * transport/HTTP failures onto typed {@link CinnaApiError} codes the renderer
 * can switch on. Both `catalogService` (`/api/v1/catalog/*`) and `agentService`
 * (native install update endpoints) consume this so auth, error mapping, and
 * observability stay identical across every Cinna call.
 *
 * Error contract (every HTTP failure also carries `status`, and `detail` is the
 * server's own sentence — see {@link CinnaApiError.status}):
 *   - 401/403            → `CinnaApiError('reauth_required')`, `detail` = the status
 *                          (a 403 on a role-gated route is not a dead session)
 *   - other non-2xx      → `CinnaApiError('request_failed', '<status>: <detail>')`
 *   - network failure    → `CinnaApiError('request_failed', <message>)`
 *   - non-JSON 2xx body  → `CinnaApiError('invalid_response', <message>)`
 *   - no/!cinna profile  → `CinnaApiError('not_cinna_user' | 'missing_server_url')`
 *   - token refresh fail → re-mapped from {@link CinnaReauthRequired} to
 *                          `CinnaApiError('reauth_required')`
 */
import { userRepo } from '../db/users'
import { getCinnaAccessToken } from '../auth/cinna-tokens'
import { CinnaReauthRequired } from '../auth/cinna-oauth'
import { CinnaSessionChanged, cinnaSessionGeneration } from '../auth/cinna-session'
import { CinnaApiError } from '../errors'
import { createLogger } from '../logger/logger'

const logger = createLogger('cinna-http')

export interface FetchOptions {
  sensitive?: boolean
  signal?: AbortSignal
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
export function extractErrorDetail(text: string): string {
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
  opts.signal?.throwIfAborted()
  const baseUrl = resolveBaseUrl(userId)
  const generation = cinnaSessionGeneration(userId)
  const authHeader = await resolveAuthHeader(userId)
  opts.signal?.throwIfAborted()
  if (cinnaSessionGeneration(userId) !== generation || resolveBaseUrl(userId) !== baseUrl) throw new CinnaSessionChanged()
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
    response = await runtimeHost.http.fetch(url, { method, headers, body, ...(opts.sensitive ? { cache: 'no-store' as const } : {}), ...(opts.signal ? { signal: opts.signal } : {}) })
  } catch (err) {
    const msg = opts.sensitive ? 'Credential request failed' : err instanceof Error ? err.message : String(err)
    logger.error('network error', { userId, url, method, error: msg, durationMs: Date.now() - started })
    throw new CinnaApiError('request_failed', msg)
  }
  if (!response.ok) {
    const text = await response.text().catch(() => '')
    logger.warn('request failed', {
      userId,
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
        String(response.status),
        response.status
      )
    }
    const detail = opts.sensitive ? 'Credential request failed' : extractErrorDetail(text) || response.statusText
    // The status travels here as well as on `cinnaApiService`'s transport.
    // `CinnaApiError.status` is documented as an invariant of the *class* —
    // "undefined only for a failure that never became a response" — and a
    // second transport that quietly omitted it would make that sentence false
    // for half the traffic, for the next person who writes a classifier over it.
    throw new CinnaApiError(
      'request_failed',
      `Cinna API ${response.status}: ${detail}`,
      detail,
      response.status
    )
  }
  try {
    return (await response.json()) as T
  } catch (err) {
    const msg = opts.sensitive ? 'Credential request failed' : err instanceof Error ? err.message : String(err)
    logger.error('invalid response', { userId, url, method, error: msg })
    throw new CinnaApiError('invalid_response', msg)
  }
}

/** {@link cinnaFetchBytes}' answer: the body and its headers, or a body over the cap. */
export type CinnaBytesResult =
  | { ok: true; bytes: Buffer; headers: Headers }
  | { ok: false; reason: 'too_large' }

/**
 * A binary GET under the profile's own API — a catalog skill archive — with
 * the same auth and error mapping as {@link cinnaFetch}, and a cap: a body
 * declared or found to be over `maxBytes` is never read whole, and answers
 * `too_large`. Only a path under the profile's server is accepted, never an
 * absolute URL, so the token goes nowhere else.
 */
export async function cinnaFetchBytes(
  userId: string,
  path: string,
  opts: { maxBytes: number; signal?: AbortSignal }
): Promise<CinnaBytesResult> {
  if (!path.startsWith('/')) throw new CinnaApiError('request_failed', 'Only a path on the profile’s own server is fetched.')
  opts.signal?.throwIfAborted()
  const baseUrl = resolveBaseUrl(userId)
  const generation = cinnaSessionGeneration(userId)
  const authHeader = await resolveAuthHeader(userId)
  opts.signal?.throwIfAborted()
  if (cinnaSessionGeneration(userId) !== generation || resolveBaseUrl(userId) !== baseUrl) throw new CinnaSessionChanged()
  const url = `${baseUrl}${path}`
  const started = Date.now()
  let response: Response
  try {
    response = await runtimeHost.http.fetch(url, {
      method: 'GET',
      headers: { Authorization: authHeader, Accept: 'application/gzip, application/octet-stream' },
      cache: 'no-store',
      ...(opts.signal ? { signal: opts.signal } : {})
    })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    logger.error('network error', { userId, url, method: 'GET', error: msg, durationMs: Date.now() - started })
    throw new CinnaApiError('request_failed', msg)
  }
  if (!response.ok) {
    const text = await response.text().catch(() => '')
    logger.warn('request failed', { userId, url, method: 'GET', status: response.status, durationMs: Date.now() - started })
    if (response.status === 401 || response.status === 403) {
      throw new CinnaApiError('reauth_required', `Cinna ${response.status}`, String(response.status), response.status)
    }
    const detail = extractErrorDetail(text) || response.statusText
    throw new CinnaApiError('request_failed', `Cinna API ${response.status}: ${detail}`, detail, response.status)
  }
  const declared = Number(response.headers.get('content-length') ?? '')
  if (Number.isFinite(declared) && declared > opts.maxBytes) {
    await response.body?.cancel().catch(() => undefined)
    return { ok: false, reason: 'too_large' }
  }
  const chunks: Buffer[] = []
  let total = 0
  if (response.body) {
    const reader = response.body.getReader()
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      total += value.byteLength
      if (total > opts.maxBytes) {
        await reader.cancel().catch(() => undefined)
        return { ok: false, reason: 'too_large' }
      }
      chunks.push(Buffer.from(value))
    }
  }
  return { ok: true, bytes: Buffer.concat(chunks), headers: response.headers }
}

/** {@link cinnaSend}'s answer: the status and the parsed JSON body (null when there was none). */
export interface CinnaSendResult {
  status: number
  ok: boolean
  body: unknown
  /** The answer's `Retry-After` header, as sent; null when absent. */
  retryAfter?: string | null
}

/**
 * A write under the profile's own API whose refusals the caller reads as
 * data: any HTTP answer, 4xx included, comes back as `{status, body}` with the
 * body parsed when it is JSON — core's coded refusals (`{detail: {code,
 * message, …}}`) are what the caller branches on, and {@link cinnaFetch}
 * reduces them to a sentence (and a 403 to "re-auth"). Only a 401 throws
 * `CinnaApiError('reauth_required')`, since that one is the session.
 *
 * `body` is JSON (`json`) or raw bytes with their content type (`bytes`), for
 * a multipart upload. Only a path under the profile's server is accepted,
 * never an absolute URL, so the token goes nowhere else. `signal` aborts it
 * (an abort surfaces as `request_failed`, like any unanswered request).
 *
 * @throws CinnaApiError `request_failed` when no answer came back, and the
 *   profile errors of {@link cinnaFetch}.
 */
export async function cinnaSend(
  userId: string,
  path: string,
  opts: { method: 'POST' | 'PUT' | 'PATCH' | 'DELETE'; json?: unknown; bytes?: { data: Uint8Array; contentType: string }; signal?: AbortSignal }
): Promise<CinnaSendResult> {
  if (!path.startsWith('/')) throw new CinnaApiError('request_failed', 'Only a path on the profile’s own server is used.')
  opts.signal?.throwIfAborted()
  const baseUrl = resolveBaseUrl(userId)
  const generation = cinnaSessionGeneration(userId)
  const authHeader = await resolveAuthHeader(userId)
  opts.signal?.throwIfAborted()
  if (cinnaSessionGeneration(userId) !== generation || resolveBaseUrl(userId) !== baseUrl) throw new CinnaSessionChanged()
  const url = `${baseUrl}${path}`
  const headers: Record<string, string> = { Authorization: authHeader, Accept: 'application/json' }
  let body: BodyInit | undefined
  if (opts.bytes) {
    headers['Content-Type'] = opts.bytes.contentType
    body = opts.bytes.data as unknown as BodyInit
  } else if (opts.json !== undefined) {
    headers['Content-Type'] = 'application/json'
    body = JSON.stringify(opts.json)
  }
  const started = Date.now()
  let response: Response
  try {
    response = await runtimeHost.http.fetch(url, { method: opts.method, headers, body, cache: 'no-store', ...(opts.signal ? { signal: opts.signal } : {}) })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    logger.error('network error', { userId, url, method: opts.method, error: msg, durationMs: Date.now() - started })
    throw new CinnaApiError('request_failed', msg)
  }
  const text = await response.text().catch(() => '')
  if (!response.ok) {
    logger.warn('request refused', { userId, url, method: opts.method, status: response.status, durationMs: Date.now() - started })
  }
  if (response.status === 401) {
    throw new CinnaApiError('reauth_required', `Cinna ${response.status}`, String(response.status), response.status)
  }
  let parsed: unknown = null
  if (text.trim() !== '') {
    try {
      parsed = JSON.parse(text)
    } catch {
      parsed = null
    }
  }
  return { status: response.status, ok: response.ok, body: parsed, retryAfter: response.headers?.get('retry-after') ?? null }
}
