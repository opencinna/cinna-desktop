import { getProfileScopeUserId } from '../../auth/scope'
import { discoverCinnaEndpoints } from '../../auth/cinna-oauth'
import { userRepo } from '../../db/users'
import { cinnaSend } from '../cinna-http'
import { fail } from '../agentFiles/fileSource'
import { createAgentDetailsService, type AgentDetailsServiceDeps } from './agentDetailsService'

type LocalFileReader = AgentDetailsServiceDeps['readLocalFile']

/** No host reader installed (the plain-Node hub, unit tests): a folder agent has no Details here. */
const noLocalFiles: LocalFileReader = async () => fail('unsupported')
let localFiles: LocalFileReader = noLocalFiles

/**
 * The host's way to a folder or vault agent's reserved files — on the desktop,
 * `agentFileService.readReservedFile` behind its gate. Installed once at
 * startup, before any window asks.
 */
export function installAgentDetailsLocalFiles(reader: LocalFileReader): void {
  localFiles = reader
}

/**
 * The production wiring of {@link createAgentDetailsService}: the active
 * profile's Cinna account, the discovery document as `cinna-oauth` caches it,
 * and the host-installed local file reader.
 */
export const agentDetailsService = createAgentDetailsService({
  profileId: getProfileScopeUserId,
  account: (profileId) => {
    const user = userRepo.get(profileId)
    if (!user || user.type !== 'cinna_user' || !user.cinnaServerUrl) return null
    const tokens = userRepo.getCinnaTokenState(profileId)
    return {
      serverUrl: user.cinnaServerUrl.replace(/\/$/, ''),
      signedIn: Boolean(tokens?.accessTokenEnc || tokens?.refreshTokenEnc)
    }
  },
  discover: (serverUrl) => discoverCinnaEndpoints(serverUrl),
  send: (profileId, path, opts) => cinnaSend(profileId, path, opts),
  readLocalFile: (agentId, rel, maxBytes) => localFiles(agentId, rel, maxBytes)
})
