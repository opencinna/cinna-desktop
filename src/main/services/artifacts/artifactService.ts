import { getProfileScopeUserId, getSettingsScopeUserId } from '../../auth/scope'
import { discoverCinnaEndpoints } from '../../auth/cinna-oauth'
import { userRepo } from '../../db/users'
import { publishedArtifactRepo } from '../../db/publishedArtifacts'
import { messageRepo } from '../../db/messages'
import { publishEvent } from '../../host/events'
import { cinnaFetch, cinnaSend } from '../cinna-http'
import { localAgentService } from '../localAgents/localAgentService'
import { createPathCanonicalizer } from '../agentFiles/canonicalPath'
import { createArtifactService } from './publishService'
import { approvalInboxHook, createArtifactApprovals } from './artifactApprovals'
import { installTaskRunnerHooks } from '../taskRunnerBridge'
import { installArtifactsSkillGate } from './artifactsSkill'

const paths = createPathCanonicalizer({ platform: process.platform })

/**
 * The production wiring of {@link createArtifactService}: the active profile's
 * Cinna account, folder agents from the settings scope (where they live), the
 * discovery document as `cinna-oauth` caches it, and events to every window.
 */
export const artifactService = createArtifactService({
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
  fetchJson: (profileId, path) => cinnaFetch<unknown>(profileId, path),
  send: (profileId, path, opts) => cinnaSend(profileId, path, opts),
  locateAgent: (agentId) => localAgentService.locate(getSettingsScopeUserId(), agentId).agentDir,
  agentName: (agentId) => localAgentService.get(getSettingsScopeUserId(), agentId).name,
  realpath: (path) => paths.realpath(path),
  repo: publishedArtifactRepo,
  publishEvent: (channel, payload) => publishEvent(channel, payload, 'all'),
  latestMessageId: (chatId) => messageRepo.lastId(chatId)
})

/** Pending approvals of agents' `artifacts_publish` calls, and the Inbox's way back to them. */
export const artifactApprovals = createArtifactApprovals({
  publishEvent: (channel, payload) => publishEvent(channel, payload, 'all')
})
installTaskRunnerHooks(approvalInboxHook(artifactApprovals), 'artifacts')

// Agents are told about artifacts (the `cinna-artifacts` skill) only while the
// active profile's instance keeps them — the same answer that offers the tool.
installArtifactsSkillGate(() => artifactService.supportedNow().supported)
