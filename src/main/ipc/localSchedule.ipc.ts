import { ipcHandle } from './_wrap'
import { userActivation } from '../auth/activation'
import { getProfileScopeUserId, getSettingsScopeUserId } from '../auth/scope'
import { localScheduleService } from '../services/localScheduleService'
import type { LocalScheduleReview } from '../../shared/localSchedules'

function scope() {
  userActivation.requireActivated()
  return { profileUserId: getProfileScopeUserId(), settingsUserId: getSettingsScopeUserId() }
}
export function registerLocalScheduleHandlers(): void {
  ipcHandle('local-schedule:list', (_event, agentId: string) => localScheduleService.list(scope(), agentId))
  ipcHandle('local-schedule:enable', (_event, review: LocalScheduleReview) => localScheduleService.enable(scope(), review))
  ipcHandle('local-schedule:disable', (_event, id: string) => localScheduleService.disable(scope(), id))
}
