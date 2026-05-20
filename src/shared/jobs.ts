/**
 * Shared DTOs for the Jobs feature. Lives in `src/shared` so both main and
 * renderer can import them without crossing the preload typing boundary.
 */

export type JobType = 'local' | 'cinna_task'
export type JobRunStatus = 'pending' | 'running' | 'succeeded' | 'failed' | 'cancelled'

export interface JobData {
  id: string
  userId: string
  type: JobType
  title: string
  description: string | null
  prompt: string
  agentId: string | null
  modeId: string | null
  cinnaAgentId: string | null
  cinnaTeamId: string | null
  cinnaAssignedNodeId: string | null
  cinnaPriority: string | null
  colorPreset: string | null
  iconName: string | null
  deletedAt: Date | null
  createdAt: Date
  updatedAt: Date
  /**
   * Count of this job's runs currently in a non-terminal state (`pending` or
   * `running`). Returned by the `job:list` IPC so the sidebar can render a
   * spinner on rows whose runs are still working. Defaults to 0.
   */
  inProgressRunsCount: number
}

export interface JobRunData {
  id: string
  jobId: string
  userId: string
  type: JobType
  localChatId: string | null
  cinnaTaskId: string | null
  cinnaShortCode: string | null
  status: JobRunStatus
  errorMessage: string | null
  startedAt: Date | null
  finishedAt: Date | null
  createdAt: Date
  /**
   * True when this is a local run whose chat exists but is hidden from the
   * main Chats list (i.e. user hasn't clicked "Move to Chats" yet). False
   * for promoted chats, deleted chats (`localChatId` is null), and
   * cinna_task runs.
   */
  chatHidden: boolean
}

export interface JobDetailData extends JobData {
  mcpProviderIds: string[]
  recentRuns: JobRunData[]
}

export interface JobCreateInputDto {
  type: JobType
  title: string
  description?: string | null
  prompt: string
  agentId?: string | null
  modeId?: string | null
  cinnaAgentId?: string | null
  cinnaTeamId?: string | null
  cinnaAssignedNodeId?: string | null
  cinnaPriority?: string | null
  colorPreset?: string | null
  iconName?: string | null
}

export interface JobPatchDto {
  type?: JobType
  title?: string
  description?: string | null
  prompt?: string
  agentId?: string | null
  modeId?: string | null
  cinnaAgentId?: string | null
  cinnaTeamId?: string | null
  cinnaAssignedNodeId?: string | null
  cinnaPriority?: string | null
  colorPreset?: string | null
  iconName?: string | null
}
