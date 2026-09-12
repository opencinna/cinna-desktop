import type { JobRow } from '../../db/jobs'
import type { JobExecuteResult } from '../../../shared/jobs'
export interface JobExecutionScope { profileUserId: string; settingsUserId: string }
export interface RendererTurnPreparation {
  chatId: string; runId: string; taskId: string; prompt: string; agentId: string | null; modeId: string | null
}
export interface RemoteJobAcceptance {
  runId: string; taskId: string; cinnaTaskId: string; cinnaShortCode: string | null
}
/** Implementations own admission, preparation and dispatch, including their rollback boundaries. */
export interface JobExecutor {
  execute(scope: JobExecutionScope, job: JobRow): Promise<JobExecuteResult>
  prepareRendererTurn?(scope: JobExecutionScope, job: JobRow): RendererTurnPreparation
  executeRemote?(scope: JobExecutionScope, job: JobRow): Promise<RemoteJobAcceptance>
}
