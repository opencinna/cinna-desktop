import { userRepo } from '../db/users'
import { userActivation } from '../auth/activation'
import { getProfileScopeUserId } from '../auth/scope'
import { getCinnaAccessToken } from '../auth/cinna-tokens'
import { CinnaReauthRequired } from '../auth/cinna-oauth'
import { runtimeHost } from '../host/runtimeHost'
import { publishEvent } from '../host/events'
import { cinnaFetch } from '../services/cinna-http'
import { createCoreRelayAccess, RELAY_ACCESS_TTL_MS } from './coreRelayAccess'
import { createCoreRelayEngine, relaySignInAgain } from './engines/coreRelay'

const DISCOVERY_PATH = '/.well-known/cinna-desktop'
const DISCOVERY_TIMEOUT_MS = 10_000

export const RELAY_NOT_AVAILABLE_MESSAGE =
  'Transcription through the Cinna server is not available: this profile is not signed in to a server that offers it.'

/** The discovery document, read fresh each time (the OAuth path caches its copy for the whole session). */
async function readDiscovery(serverUrl: string): Promise<unknown> {
  const response = await runtimeHost.http.fetch(`${serverUrl}${DISCOVERY_PATH}`, {
    headers: { Accept: 'application/json' },
    cache: 'no-store',
    signal: AbortSignal.timeout(DISCOVERY_TIMEOUT_MS)
  })
  if (!response.ok) throw new Error(`HTTP ${response.status}`)
  return response.json()
}

/** The production wiring of {@link createCoreRelayAccess}: the active profile's Cinna account and server. */
export const coreRelayAccess = createCoreRelayAccess({
  profileId: () => (userActivation.isActivated() ? getProfileScopeUserId() : null),
  account: (profileId) => {
    const user = userRepo.get(profileId)
    if (!user || user.type !== 'cinna_user' || !user.cinnaServerUrl) return null
    const tokens = userRepo.getCinnaTokenState(profileId)
    return {
      serverUrl: user.cinnaServerUrl.replace(/\/$/, ''),
      signedIn: Boolean(tokens?.accessTokenEnc && tokens?.refreshTokenEnc)
    }
  },
  discover: readDiscovery,
  fetchUsage: (profileId) => cinnaFetch<unknown>(profileId, '/api/v1/speech/usage'),
  publishEvent: (channel, payload) => publishEvent(channel, payload, 'all'),
  now: () => Date.now(),
  ttlMs: RELAY_ACCESS_TTL_MS
})

/** The relay engine: the URL from the last discovery, a fresh access token per session. */
export const coreRelayEngine = createCoreRelayEngine({
  resolveTarget: async () => {
    const endpoint = coreRelayAccess.endpoint()
    if (!endpoint) return { ok: false, code: 'unavailable', message: RELAY_NOT_AVAILABLE_MESSAGE }
    try {
      const token = await getCinnaAccessToken(endpoint.profileId)
      return { ok: true, url: endpoint.url, token, serverName: endpoint.serverName }
    } catch (err) {
      if (err instanceof CinnaReauthRequired) return { ok: false, code: 'failed', message: relaySignInAgain(endpoint.serverName) }
      throw err
    }
  },
  onDisabled: () => { void coreRelayAccess.refresh() }
})
