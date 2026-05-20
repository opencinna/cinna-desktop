import { userActivation } from '../auth/activation'
import { getProfileScopeUserId } from '../auth/scope'
import { cinnaApiService } from '../services/cinnaApiService'
import { ipcHandle } from './_wrap'

export function registerCinnaHandlers(): void {
  ipcHandle('cinna:list-agents', async () => {
    userActivation.requireActivated()
    return cinnaApiService.listAgents(getProfileScopeUserId())
  })

  ipcHandle('cinna:list-teams', async () => {
    userActivation.requireActivated()
    return cinnaApiService.listTeams(getProfileScopeUserId())
  })
}
