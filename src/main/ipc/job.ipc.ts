import { userActivation } from '../auth/activation'
import { getProfileScopeUserId } from '../auth/scope'
import { jobService } from '../services/jobService'
import { ipcHandle } from './_wrap'
import type {
  JobCreateInput,
  JobPatch,
  JobFolderCreateInput,
  JobFolderPatch
} from '../db/jobs'

export function registerJobHandlers(): void {
  ipcHandle('job:list', async () => {
    userActivation.requireActivated()
    return jobService.list(getProfileScopeUserId())
  })

  ipcHandle('job:get', async (_event, jobId: string) => {
    userActivation.requireActivated()
    return jobService.getDetail(getProfileScopeUserId(), jobId)
  })

  ipcHandle('job:create', async (_event, input: JobCreateInput) => {
    userActivation.requireActivated()
    return jobService.create(getProfileScopeUserId(), input)
  })

  ipcHandle('job:update', async (_event, jobId: string, patch: JobPatch) => {
    userActivation.requireActivated()
    return jobService.update(getProfileScopeUserId(), jobId, patch)
  })

  ipcHandle('job:delete', async (_event, jobId: string) => {
    userActivation.requireActivated()
    jobService.softDelete(getProfileScopeUserId(), jobId)
    return { success: true }
  })

  ipcHandle(
    'job:set-mcp-providers',
    async (_event, jobId: string, mcpProviderIds: string[]) => {
      userActivation.requireActivated()
      jobService.setMcpProviders(getProfileScopeUserId(), jobId, mcpProviderIds)
      return { success: true }
    }
  )

  ipcHandle('job:set-agents', async (_event, jobId: string, agentIds: string[]) => {
    userActivation.requireActivated()
    jobService.setAgents(getProfileScopeUserId(), jobId, agentIds)
    return { success: true }
  })

  ipcHandle('job:list-runs', async (_event, jobId: string) => {
    userActivation.requireActivated()
    return jobService.listRuns(getProfileScopeUserId(), jobId)
  })

  ipcHandle('job:execute', async (_event, jobId: string) => {
    userActivation.requireActivated()
    return jobService.execute(getProfileScopeUserId(), jobId)
  })

  ipcHandle('job:cancel-run', async (_event, runId: string) => {
    userActivation.requireActivated()
    // MVP: local runs are cancelled at the chat layer (existing chat stream
    // cancel); we only flip pending runs here. Non-terminal running runs
    // continue until the stream's own done/error path closes them.
    return jobService.setRunStatus(getProfileScopeUserId(), runId, 'cancelled')
  })

  ipcHandle('job:delete-run', async (_event, runId: string) => {
    userActivation.requireActivated()
    const result = jobService.deleteRun(getProfileScopeUserId(), runId)
    return { success: true as const, ...result }
  })

  ipcHandle(
    'job:refresh-run',
    async (_event, runId: string, options?: { force?: boolean }) => {
      userActivation.requireActivated()
      return jobService.refreshCinnaRun(getProfileScopeUserId(), runId, options ?? {})
    }
  )

  ipcHandle('job:cinna-server-url', async () => {
    userActivation.requireActivated()
    return jobService.getCinnaServerUrl(getProfileScopeUserId())
  })

  // ---- Folders ------------------------------------------------------------

  ipcHandle('jobFolder:list', async () => {
    userActivation.requireActivated()
    return jobService.listFolders(getProfileScopeUserId())
  })

  ipcHandle('jobFolder:create', async (_event, input: JobFolderCreateInput) => {
    userActivation.requireActivated()
    return jobService.createFolder(getProfileScopeUserId(), input)
  })

  ipcHandle(
    'jobFolder:update',
    async (_event, folderId: string, patch: JobFolderPatch) => {
      userActivation.requireActivated()
      return jobService.updateFolder(getProfileScopeUserId(), folderId, patch)
    }
  )

  ipcHandle('jobFolder:delete', async (_event, folderId: string) => {
    userActivation.requireActivated()
    jobService.deleteFolder(getProfileScopeUserId(), folderId)
    return { success: true }
  })

  ipcHandle('jobFolder:reorder', async (_event, orderedIds: string[]) => {
    userActivation.requireActivated()
    jobService.reorderFolders(getProfileScopeUserId(), orderedIds)
    return { success: true }
  })

  ipcHandle(
    'job:reorder',
    async (_event, targetFolderId: string | null, orderedJobIds: string[]) => {
      userActivation.requireActivated()
      jobService.reorderJobs(getProfileScopeUserId(), targetFolderId, orderedJobIds)
      return { success: true }
    }
  )
}
