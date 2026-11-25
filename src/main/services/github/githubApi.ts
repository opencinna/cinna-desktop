/**
 * The GitHub HTTP calls the OpenCinna sign-in makes: the device flow, the secret-less refresh, the
 * signed-in user and the installations the user can see. Base URLs are read at call time, so the
 * E2E fixture points them at fakes (`CINNA_GITHUB_WEB_URL`, `CINNA_GITHUB_API_URL`).
 *
 * Core module: no Electron. Nothing here logs; a thrown {@link GithubTransientError} means GitHub
 * could not be reached, did not answer within {@link GITHUB_HTTP_TIMEOUT_MS}, or answered 5xx /
 * unreadable, never a refusal.
 */
import { OPENCINNA_APP, type GithubCoverage } from '../../../shared/github'

export type GithubFetch = (url: string, init?: RequestInit) => Promise<Response>

export const githubWebUrl = (): string => (process.env.CINNA_GITHUB_WEB_URL || 'https://github.com').replace(/\/+$/, '')
export const githubApiUrl = (): string => (process.env.CINNA_GITHUB_API_URL || 'https://api.github.com').replace(/\/+$/, '')

export class GithubTransientError extends Error {
  constructor(readonly status: number | null, message = 'GitHub could not be reached') { super(message) }
}

const DEVICE_GRANT = 'urn:ietf:params:oauth:grant-type:device_code'
/** A token GitHub hands out is printable ASCII without `"` or `\` (the wrapper reads answers with sed). */
const TOKEN_SHAPE = /^[\x21\x23-\x5b\x5d-\x7e]{1,512}$/
const LOGIN_SHAPE = /^[A-Za-z0-9-]{1,39}$/
const MAX_PAGES = 50
/**
 * Every GitHub call gives up after this (the answer is then transient: `unavailable`). The `gh`
 * wrapper waits 40 s for `/token`, so a hung refresh answers "try again" before curl times out,
 * rather than reading as a sandbox that blocks the network.
 */
export const GITHUB_HTTP_TIMEOUT_MS = 20_000

async function postForm(fetch: GithubFetch, path: string, params: Record<string, string>): Promise<Record<string, unknown>> {
  let response: Response
  try {
    response = await fetch(`${githubWebUrl()}${path}`, {
      method: 'POST',
      headers: { Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(params).toString(),
      signal: AbortSignal.timeout(GITHUB_HTTP_TIMEOUT_MS)
    })
  } catch {
    throw new GithubTransientError(null)
  }
  if (response.status >= 500) throw new GithubTransientError(response.status)
  let body: unknown
  try { body = await response.json() } catch { throw new GithubTransientError(response.status, 'GitHub sent an unreadable answer') }
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new GithubTransientError(response.status, 'GitHub sent an unreadable answer')
  return body as Record<string, unknown>
}

async function getJson(fetch: GithubFetch, url: string, token: string): Promise<{ body: unknown; next: string | null }> {
  let response: Response
  try {
    response = await fetch(url, {
      headers: { Accept: 'application/vnd.github+json', Authorization: `Bearer ${token}`, 'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'Cinna-Desktop' },
      signal: AbortSignal.timeout(GITHUB_HTTP_TIMEOUT_MS)
    })
  } catch {
    throw new GithubTransientError(null)
  }
  if (!response.ok) throw new GithubTransientError(response.status, `GitHub answered ${response.status}`)
  let body: unknown
  try { body = await response.json() } catch { throw new GithubTransientError(response.status, 'GitHub sent an unreadable answer') }
  return { body, next: nextLink(response.headers.get('link')) }
}

/** `Link: <…>; rel="next"`, only when it stays on the API origin. */
export function nextLink(header: string | null): string | null {
  if (!header) return null
  for (const part of header.split(',')) {
    const match = /<([^>]+)>\s*;\s*rel="?next"?/.exec(part.trim())
    if (!match) continue
    try {
      const url = new URL(match[1])
      return url.origin === new URL(githubApiUrl()).origin ? url.toString() : null
    } catch { return null }
  }
  return null
}

export interface DeviceCode { deviceCode: string; userCode: string; verificationUri: string; expiresIn: number; interval: number }

export async function requestDeviceCode(fetch: GithubFetch): Promise<DeviceCode> {
  const body = await postForm(fetch, '/login/device/code', { client_id: OPENCINNA_APP.clientId })
  const { device_code: deviceCode, user_code: userCode, verification_uri: verificationUri, expires_in: expiresIn, interval } = body
  if (typeof deviceCode !== 'string' || !deviceCode || typeof userCode !== 'string' || !/^[A-Z0-9-]{4,32}$/i.test(userCode) || typeof verificationUri !== 'string') {
    throw new GithubTransientError(null, typeof body.error === 'string' ? `GitHub refused to start a sign-in (${safeCode(body.error)})` : 'GitHub sent an unreadable answer')
  }
  return { deviceCode, userCode, verificationUri, expiresIn: typeof expiresIn === 'number' && expiresIn > 0 ? expiresIn : 900, interval: typeof interval === 'number' && interval > 0 ? interval : 5 }
}

/** One poll; GitHub answers 200 with `error` while the user has not approved. */
export function pollDeviceToken(fetch: GithubFetch, deviceCode: string): Promise<Record<string, unknown>> {
  return postForm(fetch, '/login/oauth/access_token', { client_id: OPENCINNA_APP.clientId, device_code: deviceCode, grant_type: DEVICE_GRANT })
}

/** A device-flow token may be refreshed without the client secret. */
export function refreshAccessToken(fetch: GithubFetch, refreshToken: string): Promise<Record<string, unknown>> {
  return postForm(fetch, '/login/oauth/access_token', { client_id: OPENCINNA_APP.clientId, grant_type: 'refresh_token', refresh_token: refreshToken })
}

export interface TokenPair { accessToken: string; expiresAt: number | null; refreshToken: string | null; refreshExpiresAt: number | null }

/** The pair in a token answer (epoch ms), or null when it holds none or one of an unexpected shape. */
export function parseTokenPair(body: Record<string, unknown>, now: number): TokenPair | null {
  const { access_token: access, expires_in: expiresIn, refresh_token: refresh, refresh_token_expires_in: refreshIn } = body
  if (typeof access !== 'string' || !TOKEN_SHAPE.test(access)) return null
  if (refresh !== undefined && refresh !== null && (typeof refresh !== 'string' || !TOKEN_SHAPE.test(refresh))) return null
  return {
    accessToken: access,
    expiresAt: typeof expiresIn === 'number' && expiresIn > 0 ? now + expiresIn * 1000 : null,
    refreshToken: typeof refresh === 'string' ? refresh : null,
    refreshExpiresAt: typeof refresh === 'string' && typeof refreshIn === 'number' && refreshIn > 0 ? now + refreshIn * 1000 : null
  }
}

/** An OAuth error code as it may be logged or shown: short and plain. */
export function safeCode(value: unknown): string {
  return typeof value === 'string' && /^[a-z0-9_]{1,64}$/.test(value) ? value : 'unknown'
}

/** User-controlled text the wrapper prints: no `"`, `\` or control characters. */
export function plainText(value: unknown): string {
  return typeof value === 'string' ? value.replace(/["\\\u0000-\u001f\u007f]/g, '').trim().slice(0, 200) : ''
}

export interface GithubUser { login: string; id: number; name: string }

export async function getUser(fetch: GithubFetch, token: string): Promise<GithubUser> {
  const { body } = await getJson(fetch, `${githubApiUrl()}/user`, token)
  const b = (body ?? {}) as Record<string, unknown>
  if (typeof b.login !== 'string' || !LOGIN_SHAPE.test(b.login) || typeof b.id !== 'number' || !Number.isSafeInteger(b.id) || b.id <= 0) {
    throw new GithubTransientError(null, 'GitHub sent an unreadable account')
  }
  return { login: b.login, id: b.id, name: plainText(b.name) || b.login }
}

async function pages<T>(fetch: GithubFetch, first: string, token: string, pick: (body: unknown) => T[]): Promise<T[]> {
  const out: T[] = []
  let url: string | null = first
  for (let i = 0; url && i < MAX_PAGES; i++) {
    const page: { body: unknown; next: string | null } = await getJson(fetch, url, token)
    out.push(...pick(page.body))
    url = page.next
  }
  return out
}

function ownerTypeOf(value: unknown): 'User' | 'Organization' { return value === 'Organization' ? 'Organization' : 'User' }

/** Every installation of the app the user can see, with the repositories of a `selected` one. */
export async function listCoverage(fetch: GithubFetch, token: string): Promise<GithubCoverage[]> {
  const installs = await pages(fetch, `${githubApiUrl()}/user/installations?per_page=100`, token, body => {
    const list = (body as { installations?: unknown } | null)?.installations
    return Array.isArray(list) ? list : []
  })
  const out: GithubCoverage[] = []
  for (const raw of installs) {
    const i = raw as Record<string, unknown>
    const account = (i.account ?? {}) as Record<string, unknown>
    if (typeof i.id !== 'number' || typeof account.login !== 'string') continue
    const selection = i.repository_selection === 'selected' ? 'selected' : 'all'
    const repos = selection === 'all' ? [] : await pages(fetch, `${githubApiUrl()}/user/installations/${i.id}/repositories?per_page=100`, token, body => {
      const list = (body as { repositories?: unknown } | null)?.repositories
      return Array.isArray(list) ? list.flatMap(r => typeof (r as { full_name?: unknown })?.full_name === 'string' ? [(r as { full_name: string }).full_name] : []) : []
    })
    out.push({ installationId: i.id, owner: account.login, ownerType: ownerTypeOf(account.type), ownerId: typeof account.id === 'number' ? account.id : 0, selection, repos })
  }
  return out
}
