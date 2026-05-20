import { userActivation } from '../auth/activation'
import { getProfileScopeUserId } from '../auth/scope'
import { cinnaApiService } from '../services/cinnaApiService'
import { ipcHandle } from './_wrap'

export function registerCinnaHandlers(): void {
  ipcHandle('cinna:list-agents', async () => {
    userActivation.requireActivated()
    return cinnaApiService.listAgents(getProfileScopeUserId())
  })

  ipcHandle('cinna:get-task-view', async (_event, taskId: string) => {
    userActivation.requireActivated()
    return cinnaApiService.getTaskView(getProfileScopeUserId(), taskId)
  })
}
