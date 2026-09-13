import { getProfileScopeUserId } from '../auth/scope'
import { clearEndpointCache, discoverCinnaEndpoints } from '../auth/cinna-oauth'
import { userRepo } from '../db/users'
import { compareVersionStrings, parseSemver } from '../../shared/kit/contractVersion'
import type { CinnaCliUpdate } from '../../shared/cinnaCli'
import { localCliSource, toolchain } from './toolchain'
import { localDevService } from './localDevService'
import { toolDetectionService } from '../services/localAgents/toolDetectionService'

/** Updates follow the connected instance's supported release, as setup does. */
export async function checkCinnaCliUpdate(): Promise<CinnaCliUpdate> {
  const userId = getProfileScopeUserId()
  const user = userRepo.get(userId)
  const installed = await toolchain.installedCli()
  let targetVersion: string | null = null
  if (user?.type === 'cinna_user' && user.cinnaServerUrl) {
    clearEndpointCache()
    targetVersion = (await discoverCinnaEndpoints(user.cinnaServerUrl)).local_dev?.cinna_cli_version ?? null
  }
  if (getProfileScopeUserId() !== userId) throw new Error('The active profile changed. Check for updates again.')
  const installedVersion = installed?.version ?? null
  return {
    installedVersion, targetVersion,
    updateAvailable: !localCliSource() && !!parseSemver(installedVersion) && !!parseSemver(targetVersion) &&
      compareVersionStrings(targetVersion, installedVersion) > 0
  }
}

let updating: Promise<void> | null = null

export function updateCinnaCli(): Promise<void> {
  updating ??= (async () => {
    const userId = getProfileScopeUserId()
    const update = await checkCinnaCliUpdate()
    if (!update.updateAvailable || !update.targetVersion) throw new Error('No newer Cinna CLI version is advertised by the connected server.')
    if (getProfileScopeUserId() !== userId) throw new Error('The active profile changed. Check for updates again.')
    await localDevService.updateCli(userId, update.targetVersion)
    await toolDetectionService.refresh()
    if (getProfileScopeUserId() !== userId) throw new Error('The active profile changed. Check the installed CLI version again.')
  })().finally(() => { updating = null })
  return updating
}
