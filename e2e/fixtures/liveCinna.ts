import { test } from '@playwright/test'

/**
 * Driving a **real** cinna-core from the E2E suite.
 *
 * Everything else in `e2e/` runs against fakes or against nothing. This file is
 * the seam for the one kind of test that cannot: the desktop, cinna-core and
 * cinna-cli are three programs that have to agree on a contract — a discovery
 * block, a setup-token mint, a JSON line protocol, a set of exit codes — and no
 * amount of testing any one of them proves the three of them fit together.
 *
 * ## Configuration
 *
 * `.env`, read by `e2e/playwright.config.ts` before any spec loads:
 *
 * ```
 * CINNA_E2E_SERVER_URL=http://localhost:8000
 * CINNA_E2E_EMAIL=…
 * CINNA_E2E_PASSWORD=…
 * ```
 *
 * All three empty is the normal state and the specs skip. This is deliberately
 * *not* wired to a docker-compose the suite starts itself: the stack under test
 * is the developer's own running one, and a suite that boots its own would be
 * testing a stack nobody is developing against.
 *
 * ## Standing in for the browser
 *
 * The desktop's OAuth is a loopback flow: it opens the user's browser at the
 * instance's `authorization_endpoint` and waits for a redirect back to
 * `http://127.0.0.1:<port>/oauth/callback`. A test cannot click "Approve" in a
 * browser, so {@link approveDesktopAuth} performs exactly that human step over
 * the API and nothing else:
 *
 * 1. sign in as the configured user (`POST /api/v1/login/access-token`)
 * 2. follow the authorize URL *without* redirecting, to read the consent
 *    request nonce cinna-core minted for this attempt
 * 3. approve it (`POST /api/v1/desktop-auth/consent`)
 * 4. request the loopback URL cinna-core hands back, which is what the browser
 *    would have been redirected to
 *
 * Every other part of the flow is the real thing: PKCE, the authorization code,
 * the token exchange, `userinfo`, the profile row. What is replaced is the
 * consent *click*, which is the only part a human has to be present for.
 *
 * The one thing this does **not** exercise is `shell.openExternal` itself — the
 * spec stubs it in the main process to capture the URL rather than opening the
 * developer's browser mid-test. That is the intended trade: an unstubbed run
 * would open a real browser window on the machine running the suite.
 */

export interface LiveCinnaConfig {
  /** Origin serving `/.well-known/cinna-desktop`. The backend, not the SPA. */
  serverUrl: string
  email: string
  password: string
}

/** The discovery document, as much of it as the suite reads. */
export interface Discovery {
  authorization_endpoint: string
  token_endpoint: string
  userinfo_endpoint: string
  desktop_auth_enabled?: boolean
  local_dev?: {
    setup_token_endpoint: string
    cinna_cli_version: string
    mutagen_version: string
  }
}

/** The `.env` triple, or null when the suite is not configured for a live run. */
export function liveCinnaConfig(): LiveCinnaConfig | null {
  const serverUrl = (process.env.CINNA_E2E_SERVER_URL ?? '').trim().replace(/\/$/, '')
  const email = (process.env.CINNA_E2E_EMAIL ?? '').trim()
  const password = process.env.CINNA_E2E_PASSWORD ?? ''
  if (!serverUrl || !email || !password) return null
  return { serverUrl, email, password }
}

/**
 * The config, or `test.skip` with the reason.
 *
 * Call from `beforeEach`, the way `requireLiveKey` is used — a spec that needs
 * a live server must be skipped, never failed, on a machine that has none.
 */
export function requireLiveCinna(): LiveCinnaConfig {
  const config = liveCinnaConfig()
  test.skip(
    config === null,
    'no live cinna-core configured — set CINNA_E2E_SERVER_URL / _EMAIL / _PASSWORD in .env'
  )
  return config as LiveCinnaConfig
}

async function fetchWithTimeout(url: string, init: RequestInit = {}, ms = 10_000): Promise<Response> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), ms)
  try {
    return await fetch(url, { ...init, signal: controller.signal })
  } finally {
    clearTimeout(timer)
  }
}

export type Preflight =
  | { ok: true; discovery: Discovery }
  | { ok: false; reason: string }

/**
 * Check that the configured stack can actually serve this test, and say
 * precisely what is wrong when it cannot.
 *
 * The specific failure worth naming is the third one. cinna-core builds its
 * discovery endpoints from `BACKEND_BASE_URL`, which on a development box is
 * often a tunnel — so a server that answers perfectly well on
 * `http://localhost:8000` can hand the desktop an `authorization_endpoint` on a
 * host that is down. The desktop would then fail at the browser step with a
 * network error that looks like a bug in the desktop and is not one. Preflight
 * checks the endpoint the desktop will actually be sent to, and names it.
 */
export async function preflight(config: LiveCinnaConfig): Promise<Preflight> {
  let discovery: Discovery
  try {
    const response = await fetchWithTimeout(`${config.serverUrl}/.well-known/cinna-desktop`)
    if (!response.ok) {
      return { ok: false, reason: `${config.serverUrl} answered HTTP ${response.status} for /.well-known/cinna-desktop` }
    }
    discovery = (await response.json()) as Discovery
  } catch (err) {
    return {
      ok: false,
      reason: `${config.serverUrl} is not serving /.well-known/cinna-desktop (${String(err)}). It must be the backend origin, not the SPA dev server.`
    }
  }

  if (!discovery.authorization_endpoint) {
    return { ok: false, reason: 'the discovery document has no authorization_endpoint' }
  }

  const authorizeOrigin = new URL(discovery.authorization_endpoint).origin
  try {
    // Any answer at all proves the host is up; the status does not matter,
    // because `/authorize` without its query parameters is expected to be a 4xx.
    await fetchWithTimeout(discovery.authorization_endpoint, { method: 'GET' }, 8_000)
  } catch (err) {
    return {
      ok: false,
      reason:
        `the instance advertises its authorization_endpoint at ${authorizeOrigin}, which is not reachable from here (${String(err)}). ` +
        `Set cinna-core's BACKEND_BASE_URL to the same origin as CINNA_E2E_SERVER_URL for local integration runs, or bring that host up.`
    }
  }

  return { ok: true, discovery }
}

/** Sign in as the configured user and return a bearer token. */
export async function signIn(config: LiveCinnaConfig): Promise<string> {
  const response = await fetchWithTimeout(`${config.serverUrl}/api/v1/login/access-token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ username: config.email, password: config.password }).toString()
  })
  if (!response.ok) {
    throw new Error(
      `could not sign in as ${config.email}: HTTP ${response.status} ${await response.text().catch(() => '')}`
    )
  }
  const body = (await response.json()) as { access_token?: string }
  if (!body.access_token) throw new Error('login returned no access_token')
  return body.access_token
}

/**
 * Do what the user's browser would do with the URL the desktop just opened.
 *
 * `authorizeUrl` is the exact string the app passed to `shell.openExternal`,
 * captured by the spec. Resolves once the loopback callback has been requested,
 * at which point the desktop's own `waitForOAuthCallback` has the code and the
 * rest of the flow is the app's.
 */
export async function approveDesktopAuth(
  config: LiveCinnaConfig,
  authorizeUrl: string
): Promise<void> {
  const token = await signIn(config)

  // Manual redirect: the 307 Location is the SPA consent page, and the nonce in
  // its query is the handle to the pending request. Following it would land on
  // a React app the test has no business driving.
  const authorize = await fetchWithTimeout(authorizeUrl, { redirect: 'manual' })
  const location = authorize.headers.get('location')
  if (!location) {
    throw new Error(
      `authorize did not redirect (HTTP ${authorize.status}): ${await authorize.text().catch(() => '')}`
    )
  }
  const nonce = new URL(location, config.serverUrl).searchParams.get('request')
  if (!nonce) throw new Error(`no consent request nonce in the redirect: ${location}`)

  // The consent route is the authorize route's sibling, on whatever origin the
  // instance advertises — not necessarily `serverUrl`, since a split-host
  // deployment puts the API somewhere else entirely.
  const authorizePath = new URL(authorizeUrl)
  if (!authorizePath.pathname.endsWith('/authorize')) {
    throw new Error(`unexpected authorization_endpoint shape: ${authorizePath.pathname}`)
  }
  authorizePath.pathname = authorizePath.pathname.replace(/\/authorize$/, '/consent')
  authorizePath.search = ''
  const consentUrl = authorizePath.toString()
  const consent = await fetchWithTimeout(consentUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ request_nonce: nonce, action: 'approve' })
  })
  if (!consent.ok) {
    throw new Error(
      `consent failed: HTTP ${consent.status} ${await consent.text().catch(() => '')}`
    )
  }
  const { redirect_to: redirectTo } = (await consent.json()) as { redirect_to?: string }
  if (!redirectTo) throw new Error('consent returned no redirect_to')

  // The loopback hop. This is the request the browser would have made, and the
  // one the desktop's callback server is sitting on.
  await fetchWithTimeout(redirectTo, { redirect: 'manual' }, 15_000)
}

/**
 * The ids of the account CLI tokens this instance currently holds for the
 * configured user.
 *
 * The pair {@link listAccountTokenIds} / {@link revokeAccountTokens} exists so
 * the run can clean up after itself *precisely*. A run really mints an account
 * CLI token — a live credential on a real server — and a suite that leaves one
 * behind on every invocation is a suite that quietly fills someone's account
 * with junk.
 *
 * Revoking by **difference** rather than by machine name is the point:
 * cinna-cli names a token after the machine, so a real Cinna Desktop install on
 * the same laptop has a token with the same name, and a name-based cleanup
 * would revoke the developer's own working setup.
 */
export async function listAccountTokenIds(config: LiveCinnaConfig): Promise<string[]> {
  try {
    const token = await signIn(config)
    const response = await fetchWithTimeout(`${config.serverUrl}/api/v1/cli/account/tokens`, {
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' }
    })
    if (!response.ok) return []
    const body = (await response.json()) as { data?: { id: string }[] }
    return (body.data ?? []).map((row) => row.id)
  } catch {
    // Cleanup must never be the reason a run fails, in either direction.
    return []
  }
}

/** Revoke exactly the tokens in `ids`. Best effort, and silent about it. */
export async function revokeAccountTokens(
  config: LiveCinnaConfig,
  ids: readonly string[]
): Promise<void> {
  if (ids.length === 0) return
  try {
    const token = await signIn(config)
    for (const id of ids) {
      await fetchWithTimeout(`${config.serverUrl}/api/v1/cli/account/tokens/${id}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' }
      })
    }
  } catch {
    // Best effort: an un-revoked test token is untidy, not unsafe, and failing
    // a passing run over it would be worse.
  }
}
