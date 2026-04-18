import crypto from 'node:crypto'
import { shell, net } from 'electron'
import os from 'node:os'
import { app } from 'electron'
import { findAvailablePort, waitForOAuthCallback } from '../mcp/oauth-callback'
import { createLogger } from '../logger/logger'

const logger = createLogger('cinna-oauth')

export const CINNA_CLOUD_URL = 'https://opencinna.io'
const DISCOVERY_PATH = '/.well-known/cinna-desktop'

export interface CinnaEndpoints {
  authorization_endpoint: string
  token_endpoint: string
  userinfo_endpoint: string
}

export interface CinnaUserProfile {
  email: string
  displayName: string
  fullName?: string
}

export interface CinnaOAuthResult {
  clientId: string
  accessToken: string
  refreshToken: string
  expiresIn: number
  profile: CinnaUserProfile
}

export class CinnaReauthRequired extends Error {
  constructor(message = 'Cinna re-authentication required') {
    super(message)
    this.name = 'CinnaReauthRequired'
  }
}

// Session-scoped cache for discovered endpoints
const endpointCache = new Map<string, CinnaEndpoints>()

// Active flow abort handle
let activeAbort: (() => void) | undefined

function generateCodeVerifier(): string {
  return crypto.randomBytes(32).toString('base64url')
}

function generateCodeChallenge(verifier: string): string {
  return crypto.createHash('sha256').update(verifier).digest('base64url')
}

function generateState(): string {
  return crypto.randomBytes(16).toString('hex')
}

async function fetchJson(url: string, init?: RequestInit): Promise<unknown> {
  const method = init?.method ?? 'GET'
  logger.debug(`${method} ${url}`)
  let resp: Response
  try {
    resp = await net.fetch(url, init)
  } catch (err) {
    logger.error(`Network error on ${method} ${url}`, { error: String(err) })
    throw err
  }
  if (!resp.ok) {
    const body = await resp.text().catch(() => '')
    logger.error(`HTTP ${resp.status} from ${method} ${url}`, { body: body.slice(0, 2000) })
    throw new Error(`HTTP ${resp.status} from ${url}: ${body}`)
  }
  return resp.json()
}

/**
 * Discover Cinna server OAuth endpoints via .well-known/cinna-desktop.
 * Results are cached per server URL for the session.
 */
export async function discoverCinnaEndpoints(serverUrl: string): Promise<CinnaEndpoints> {
  const cached = endpointCache.get(serverUrl)
  if (cached) {
    logger.debug(`Using cached endpoints for ${serverUrl}`)
    return cached
  }

  const discoveryUrl = `${serverUrl.replace(/\/$/, '')}${DISCOVERY_PATH}`
  logger.info(`Discovering endpoints at ${discoveryUrl}`)
  const data = (await fetchJson(discoveryUrl)) as CinnaEndpoints

  if (!data.authorization_endpoint || !data.token_endpoint || !data.userinfo_endpoint) {
    logger.error('Invalid discovery response: missing required endpoints', data)
    throw new Error('Invalid discovery response: missing required endpoints')
  }

  logger.debug('Discovered endpoints', data)
  endpointCache.set(serverUrl, data)
  return data
}

/**
 * Start the full Cinna OAuth 2.0 Authorization Code + PKCE flow.
 *
 * Opens the user's browser to the combined bootstrap/authorize endpoint
 * which handles login + client registration + authorization in one flow.
 * The callback returns both an auth code and client_id.
 */
export async function startCinnaOAuthFlow(serverUrl: string): Promise<CinnaOAuthResult> {
  logger.info(`Starting OAuth flow against ${serverUrl}`)
  const endpoints = await discoverCinnaEndpoints(serverUrl)

  const port = await findAvailablePort()
  const redirectUri = `http://127.0.0.1:${port}/oauth/callback`
  logger.debug(`Local callback listening on port ${port}`)

  const codeVerifier = generateCodeVerifier()
  const codeChallenge = generateCodeChallenge(codeVerifier)
  const state = generateState()

  const { promise, abort } = waitForOAuthCallback(port)
  activeAbort = abort

  // Suppress unhandled rejection if abort fires before anyone awaits
  promise.catch(() => {})

  const params = new URLSearchParams({
    redirect_uri: redirectUri,
    code_challenge: codeChallenge,
    code_challenge_method: 'S256',
    state,
    device_name: os.hostname(),
    platform: process.platform,
    app_version: app.getVersion()
  })

  const authorizeUrl = `${endpoints.authorization_endpoint}?${params.toString()}`
  logger.info('Opening browser for authorization', { authorizeUrl })
  await shell.openExternal(authorizeUrl)

  let result: Awaited<typeof promise>
  try {
    result = await promise
    logger.debug('Received OAuth callback', { hasCode: !!result.code, state: result.state })
  } catch (err) {
    logger.error('OAuth callback failed or was aborted', { error: String(err) })
    throw err
  } finally {
    activeAbort = undefined
  }

  // Validate state
  if (result.state !== state) {
    logger.error('OAuth state mismatch', { expected: state, got: result.state })
    throw new Error('OAuth state mismatch — possible CSRF attack')
  }

  // Server includes client_id as an extra query parameter in the callback URL
  const clientId = result.params.client_id
  if (!clientId) {
    logger.error('OAuth callback missing client_id parameter', { params: result.params })
    throw new Error('OAuth callback missing client_id parameter')
  }
  logger.debug('Callback validated', { clientId })

  // Exchange authorization code for tokens
  logger.info('Exchanging authorization code for tokens')
  const tokenData = (await fetchJson(endpoints.token_endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code: result.code,
      redirect_uri: redirectUri,
      client_id: clientId,
      code_verifier: codeVerifier
    }).toString()
  })) as { access_token: string; refresh_token: string; expires_in: number }
  logger.debug('Token exchange succeeded', { expiresIn: tokenData.expires_in })

  // Fetch user profile using the new access token
  logger.info('Fetching user profile')
  const profile = await fetchCinnaUserInfo(
    endpoints.userinfo_endpoint,
    tokenData.access_token
  )
  logger.info('OAuth flow complete', { email: profile.email })

  return {
    clientId,
    accessToken: tokenData.access_token,
    refreshToken: tokenData.refresh_token,
    expiresIn: tokenData.expires_in,
    profile
  }
}

/**
 * Fetch user profile from the Cinna userinfo endpoint.
 * The server returns: { email, full_name, username }
 */
async function fetchCinnaUserInfo(
  userinfoEndpoint: string,
  accessToken: string
): Promise<CinnaUserProfile> {
  const data = (await fetchJson(userinfoEndpoint, {
    headers: { Authorization: `Bearer ${accessToken}` }
  })) as { email?: string; full_name?: string; username?: string }

  if (!data.email) {
    logger.error('Userinfo response missing email', data)
    throw new Error('Userinfo response missing email')
  }

  return {
    email: data.email,
    fullName: data.full_name || undefined,
    displayName: data.username || data.full_name || data.email
  }
}

/**
 * Abort an in-progress OAuth flow.
 */
export function abortCinnaOAuthFlow(): void {
  if (activeAbort) {
    logger.info('OAuth flow aborted by user')
    activeAbort()
    activeAbort = undefined
  }
}

/**
 * Refresh Cinna tokens using a refresh token.
 * The server rotates refresh tokens — always store the new one.
 *
 * Throws CinnaReauthRequired if the server indicates replay detection
 * or the refresh token is revoked.
 */
export async function refreshCinnaTokens(
  serverUrl: string,
  clientId: string,
  refreshToken: string
): Promise<{ accessToken: string; refreshToken: string; expiresIn: number }> {
  logger.debug(`Refreshing tokens at ${serverUrl}`)
  const endpoints = await discoverCinnaEndpoints(serverUrl)

  const resp = await net.fetch(endpoints.token_endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      client_id: clientId,
      refresh_token: refreshToken
    }).toString()
  })

  if (!resp.ok) {
    const body = await resp.text().catch(() => '')
    logger.warn(`Token refresh HTTP ${resp.status}`, { body: body.slice(0, 1000) })

    // Replay detection or revoked token — need full re-auth
    if (resp.status === 400 || resp.status === 401) {
      try {
        const err = JSON.parse(body) as { error?: string }
        if (
          err.error === 'invalid_grant' ||
          err.error === 'token_reuse_detected' ||
          err.error === 'unauthorized'
        ) {
          logger.error(`Re-auth required: ${err.error}`)
          throw new CinnaReauthRequired(
            `Token refresh rejected: ${err.error}. Full re-authentication required.`
          )
        }
      } catch (e) {
        if (e instanceof CinnaReauthRequired) throw e
      }
    }

    throw new Error(`Token refresh failed: HTTP ${resp.status} — ${body}`)
  }
  logger.debug('Token refresh succeeded')

  const data = (await resp.json()) as {
    access_token: string
    refresh_token: string
    expires_in: number
  }

  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
    expiresIn: data.expires_in
  }
}

/**
 * Clear the endpoint cache (useful for testing or server changes).
 */
export function clearEndpointCache(): void {
  endpointCache.clear()
}
