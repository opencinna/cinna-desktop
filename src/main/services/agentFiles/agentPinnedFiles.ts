import { getProfileScopeUserId, getSettingsScopeUserId } from '../../auth/scope'
import { agentPinnedFileRepo } from '../../db/agents'
import { isGuardedLocation } from '../localAgents/homePath'
import { localAgentService } from '../localAgents/localAgentService'
import { createPinnedFileService } from './pinnedFileService'

/**
 * The production wiring of {@link createPinnedFileService}. Folder agents live
 * in the settings scope; the pins belong to the active profile. Core only — no
 * window is needed to list or change a pin.
 */
export const agentPinnedFileService = createPinnedFileService({
  locateAgent: (agentId) => localAgentService.locate(getSettingsScopeUserId(), agentId).agentDir,
  getUserId: getProfileScopeUserId,
  store: agentPinnedFileRepo,
  isGuardedLocation: (path) => isGuardedLocation(path),
  platform: process.platform
})
