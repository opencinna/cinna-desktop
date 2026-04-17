import { eq } from 'drizzle-orm'
import { getDb } from '../db/client'
import { users } from '../db/schema'
import { encryptApiKey, decryptApiKey } from '../security/keystore'
import { refreshCinnaTokens, CinnaReauthRequired } from './cinna-oauth'

// Mutex to prevent concurrent refresh races
let refreshInProgress: Promise<string> | null = null

/**
 * Store Cinna OAuth tokens (encrypted) for a user.
 * Always updates the refresh token to support rotation.
 */
export function storeCinnaTokens(
  userId: string,
  tokens: {
    clientId: string
    accessToken: string
    refreshToken: string
    expiresIn: number
  }
): void {
  const db = getDb()
  db.update(users)
    .set({
      cinnaClientId: tokens.clientId,
      cinnaAccessTokenEnc: encryptApiKey(tokens.accessToken),
      cinnaRefreshTokenEnc: encryptApiKey(tokens.refreshToken),
      cinnaTokenExpiresAt: Date.now() + tokens.expiresIn * 1000
    })
    .where(eq(users.id, userId))
    .run()
}

/**
 * Get a valid Cinna access token for a user.
 * Automatically refreshes if within 60s of expiry.
 * Uses promise deduplication to prevent concurrent refresh races.
 *
 * @throws {CinnaReauthRequired} if tokens are revoked or replay detected
 */
export async function getCinnaAccessToken(userId: string): Promise<string> {
  const db = getDb()
  const user = db.select().from(users).where(eq(users.id, userId)).get()

  if (!user?.cinnaAccessTokenEnc || !user.cinnaRefreshTokenEnc) {
    throw new CinnaReauthRequired('No Cinna tokens stored')
  }

  const expiresAt = user.cinnaTokenExpiresAt ?? 0
  const needsRefresh = Date.now() > expiresAt - 60_000

  if (!needsRefresh) {
    return decryptApiKey(user.cinnaAccessTokenEnc)
  }

  // Deduplicate concurrent refresh attempts
  if (refreshInProgress) {
    return refreshInProgress
  }

  refreshInProgress = (async () => {
    try {
      const currentRefreshToken = decryptApiKey(user.cinnaRefreshTokenEnc!)
      const serverUrl = user.cinnaServerUrl
      const clientId = user.cinnaClientId

      if (!serverUrl || !clientId) {
        throw new CinnaReauthRequired('Missing Cinna server URL or client ID')
      }

      const newTokens = await refreshCinnaTokens(serverUrl, clientId, currentRefreshToken)

      // Store rotated tokens
      storeCinnaTokens(userId, {
        clientId,
        accessToken: newTokens.accessToken,
        refreshToken: newTokens.refreshToken,
        expiresIn: newTokens.expiresIn
      })

      return newTokens.accessToken
    } catch (e) {
      if (e instanceof CinnaReauthRequired) {
        // Replay detected or token revoked — clear all tokens
        clearCinnaTokens(userId)
      }
      throw e
    } finally {
      refreshInProgress = null
    }
  })()

  return refreshInProgress
}

/**
 * Clear all Cinna tokens and client ID for a user.
 */
export function clearCinnaTokens(userId: string): void {
  const db = getDb()
  db.update(users)
    .set({
      cinnaClientId: null,
      cinnaAccessTokenEnc: null,
      cinnaRefreshTokenEnc: null,
      cinnaTokenExpiresAt: null
    })
    .where(eq(users.id, userId))
    .run()
}

/**
 * Check if a user has Cinna tokens stored.
 */
export function hasCinnaTokens(userId: string): boolean {
  const db = getDb()
  const user = db.select().from(users).where(eq(users.id, userId)).get()
  return !!(user?.cinnaAccessTokenEnc && user?.cinnaRefreshTokenEnc)
}
