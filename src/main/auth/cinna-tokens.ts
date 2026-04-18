import { userRepo } from '../db/users'
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
  userRepo.setCinnaTokens(userId, {
    clientId: tokens.clientId,
    accessTokenEnc: encryptApiKey(tokens.accessToken),
    refreshTokenEnc: encryptApiKey(tokens.refreshToken),
    expiresAt: Date.now() + tokens.expiresIn * 1000
  })
}

/**
 * Get a valid Cinna access token for a user.
 * Automatically refreshes if within 60s of expiry.
 * Uses promise deduplication to prevent concurrent refresh races.
 *
 * @throws {CinnaReauthRequired} if tokens are revoked or replay detected
 */
export async function getCinnaAccessToken(userId: string): Promise<string> {
  const state = userRepo.getCinnaTokenState(userId)

  if (!state?.accessTokenEnc || !state.refreshTokenEnc) {
    throw new CinnaReauthRequired('No Cinna tokens stored')
  }

  const expiresAt = state.expiresAt ?? 0
  const needsRefresh = Date.now() > expiresAt - 60_000

  if (!needsRefresh) {
    return decryptApiKey(state.accessTokenEnc)
  }

  // Deduplicate concurrent refresh attempts
  if (refreshInProgress) {
    return refreshInProgress
  }

  refreshInProgress = (async () => {
    try {
      const currentRefreshToken = decryptApiKey(state.refreshTokenEnc!)
      const serverUrl = state.serverUrl
      const clientId = state.clientId

      if (!serverUrl || !clientId) {
        throw new CinnaReauthRequired('Missing Cinna server URL or client ID')
      }

      const newTokens = await refreshCinnaTokens(serverUrl, clientId, currentRefreshToken)

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
  userRepo.clearCinnaTokens(userId)
}
