import { ipcHandle } from './_wrap'
import { userActivation } from '../auth/activation'
import { getProfileScopeUserId, getSettingsScopeUserId } from '../auth/scope'
import { jobScheduleService } from '../services/jobScheduleService'
import type { JobScheduleSaveInput, JobScheduleMutationInput, JobScheduleEnableInput } from '../../shared/localJobSchedules'
import { localScheduleService } from '../services/localScheduleService'
import type { LocalScheduleReview, LocalScheduleSaveInput, LocalScheduleDeleteInput, LocalScheduleHistoryInput, LocalScheduleStopInput } from '../../shared/localSchedules'

function scope() {
  userActivation.requireActivated()
  return { profileUserId: getProfileScopeUserId(), settingsUserId: getSettingsScopeUserId() }
}
export function registerLocalScheduleHandlers(): void {
  ipcHandle('job-schedule:list', (_event, jobId: string) => jobScheduleService.list(scope(), jobId))
  ipcHandle('job-schedule:save', (_event, input: JobScheduleSaveInput) => jobScheduleService.save(scope(), input))
  ipcHandle('job-schedule:enable', (_event, input: JobScheduleEnableInput) => jobScheduleService.enable(scope(), input))
  ipcHandle('job-schedule:disable', (_event, input: JobScheduleMutationInput) => jobScheduleService.disable(scope(), input))
  ipcHandle('job-schedule:delete', (_event, input: JobScheduleMutationInput) => jobScheduleService.delete(scope(), input))
  ipcHandle('job-schedule:history', (_event, input: LocalScheduleHistoryInput) => jobScheduleService.history(scope(), input))
  ipcHandle('job-schedule:stop', (_event, input: LocalScheduleStopInput) => jobScheduleService.stop(scope(), input))
  ipcHandle('local-schedule:editor', (_event, agentId: string) => localScheduleService.editor(scope(), agentId))
  ipcHandle('local-schedule:save', (_event, input: LocalScheduleSaveInput) => localScheduleService.save(scope(), input))
  ipcHandle('local-schedule:delete', (_event, input: LocalScheduleDeleteInput) => localScheduleService.delete(scope(), input))
  ipcHandle('local-schedule:preview', (_event, input: Parameters<typeof localScheduleService.preview>[1]) => localScheduleService.preview(scope(), input))
  ipcHandle('local-schedule:history', (_event, input: LocalScheduleHistoryInput) => localScheduleService.history(scope(), input))
  ipcHandle('local-schedule:stop', (_event, input: LocalScheduleStopInput) => localScheduleService.stop(scope(), input))
  ipcHandle('local-schedule:list', (_event, agentId: string) => localScheduleService.list(scope(), agentId))
  ipcHandle('local-schedule:enable', (_event, review: LocalScheduleReview) => localScheduleService.enable(scope(), review))
  ipcHandle('local-schedule:disable', (_event, id: string) => localScheduleService.disable(scope(), id))
}
