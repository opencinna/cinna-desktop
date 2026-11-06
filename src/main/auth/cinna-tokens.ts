import { userRepo } from '../db/users'
import { encryptApiKey, decryptApiKey } from '../security/keystore'
import { refreshCinnaTokens, CinnaReauthRequired } from './cinna-oauth'
import { CinnaSessionChanged, cinnaSessionGeneration, invalidateCinnaSession } from './cinna-session'
import type { CinnaTokenState } from '../db/users'

// Per-user mutex to prevent concurrent refresh races. Keyed by userId so a
// refresh in flight for one account can never be handed back to another (a
// global promise would let account B dedup onto account A's refresh and receive
// A's access token).
const refreshInProgress = new Map<string, { generation: number; state: CinnaTokenState; promise: Promise<string> }>()

function sameSession(a: CinnaTokenState | null | undefined, b: CinnaTokenState): boolean {
  return !!a && a.serverUrl === b.serverUrl && a.clientId === b.clientId &&
    !!a.refreshTokenEnc && !!b.refreshTokenEnc && a.refreshTokenEnc.equals(b.refreshTokenEnc)
}

/**
 * Store Cinna OAuth tokens (encrypted) for a user.
 * Always updates the refresh token to support rotation.
 *
 * The session is invalidated before encrypting; a later store or clear that
 * lands while this one encrypts supersedes it, and this write is dropped.
 */
export async function storeCinnaTokens(
  userId: string,
  tokens: {
    clientId: string
    accessToken: string
    refreshToken: string
    expiresIn: number
  }
): Promise<void> {
  invalidateCinnaSession(userId)
  const generation = cinnaSessionGeneration(userId)
  const sealed = await sealTokens(tokens)
  if (cinnaSessionGeneration(userId) !== generation) throw new CinnaSessionChanged()
  userRepo.setCinnaTokens(userId, sealed)
}

type SealedTokens = Parameters<typeof userRepo.setCinnaTokens>[1]

async function sealTokens(tokens: {
  clientId: string; accessToken: string; refreshToken: string; expiresIn: number
}): Promise<SealedTokens> {
  const [accessTokenEnc, refreshTokenEnc] = await Promise.all([
    encryptApiKey(tokens.accessToken),
    encryptApiKey(tokens.refreshToken)
  ])
  return {
    clientId: tokens.clientId,
    accessTokenEnc,
    refreshTokenEnc,
    expiresAt: Date.now() + tokens.expiresIn * 1000
  }
}

/** Stored identity only: no refresh, expiry check, or network request. */
export async function getStoredCinnaSubject(userId: string): Promise<string> {
  const state = userRepo.getCinnaTokenState(userId)
  if (!state?.accessTokenEnc) throw new CinnaReauthRequired('No Cinna access token stored')
  return decodeAccessTokenSubject(await decryptApiKey(state.accessTokenEnc))
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
  const generation = cinnaSessionGeneration(userId)

  if (!state?.accessTokenEnc || !state.refreshTokenEnc) {
    throw new CinnaReauthRequired('No Cinna tokens stored')
  }

  const expiresAt = state.expiresAt ?? 0
  const needsRefresh = Date.now() > expiresAt - 60_000

  if (!needsRefresh) {
    return decryptApiKey(state.accessTokenEnc)
  }

  // Deduplicate concurrent refresh attempts for THIS account.
  const inFlight = refreshInProgress.get(userId)
  if (inFlight && inFlight.generation === generation && sameSession(state, inFlight.state)) {
    return inFlight.promise
  }

  const isCurrent = (): boolean => cinnaSessionGeneration(userId) === generation &&
    sameSession(userRepo.getCinnaTokenState(userId), state)

  // Defer the body to a microtask so the `refreshInProgress.set` below always
  // wins the ordering. Otherwise a *synchronous* throw inside the body (e.g.
  // `decryptApiKey` on a corrupt blob / unavailable keychain) would run the
  // `finally` delete before the entry was ever set, then leave a permanently
  // rejected promise in the map that poisons every later caller for this user.
  const refresh = Promise.resolve().then(async () => {
    try {
      if (!isCurrent()) throw new CinnaSessionChanged()
      const currentRefreshToken = await decryptApiKey(state.refreshTokenEnc!)
      const serverUrl = state.serverUrl
      const clientId = state.clientId

      if (!serverUrl || !clientId) {
        throw new CinnaReauthRequired('Missing Cinna server URL or client ID')
      }

      const newTokens = await refreshCinnaTokens(serverUrl, clientId, currentRefreshToken)

      // Rotation keeps the same session; only a login/re-link replaces it.
      const sealed = await sealTokens({
        clientId,
        accessToken: newTokens.accessToken,
        refreshToken: newTokens.refreshToken,
        expiresIn: newTokens.expiresIn
      })
      if (!isCurrent()) throw new CinnaSessionChanged()
      userRepo.setCinnaTokens(userId, sealed)

      return newTokens.accessToken
    } catch (e) {
      if (!isCurrent()) throw new CinnaSessionChanged()
      if (e instanceof CinnaReauthRequired && isCurrent()) {
        // Replay detected or token revoked — clear all tokens
        clearCinnaTokens(userId)
      }
      throw e
    } finally {
      if (refreshInProgress.get(userId)?.promise === refresh) refreshInProgress.delete(userId)
    }
  })

  refreshInProgress.set(userId, { generation, state, promise: refresh })
  return refresh
}

/**
 * Clear all Cinna tokens and client ID for a user.
 */
export function clearCinnaTokens(userId: string): void {
  invalidateCinnaSession(userId)
  userRepo.clearCinnaTokens(userId)
}

/**
 * Decode the `sub` claim (the Cinna backend user UUID) from an access token.
 *
 * The signature is intentionally NOT verified: this is our own access token —
 * fetched over TLS and stored via `safeStorage` — and we read `sub` only as an
 * identifier (e.g. the E2E crypto identity), never as a trust/authorization
 * decision. The backend remains the sole authority on token validity.
 *
 * A malformed token or a missing `sub` almost always means the stored session
 * is unusable, so we throw `CinnaReauthRequired` — that's the one error class
 * the sync cycle and the IPC wrapper already route into the quiet global reauth
 * flow, rather than surfacing an opaque `SyntaxError` as a sync toast.
 */
export function decodeAccessTokenSubject(token: string): string {
  try {
    const seg = token.split('.')[1] ?? ''
    const json = Buffer.from(seg, 'base64url').toString('utf8')
    const sub = (JSON.parse(json) as { sub?: string }).sub
    if (!sub) throw new CinnaReauthRequired('access token missing sub claim')
    return String(sub)
  } catch (err) {
    if (err instanceof CinnaReauthRequired) throw err
    throw new CinnaReauthRequired('access token could not be decoded', { cause: err })
  }
}
