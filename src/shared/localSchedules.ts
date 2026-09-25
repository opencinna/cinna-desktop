import type { FileStamp } from './localAgents'
import type { ScheduleEditorMetadata } from './scheduleTemplates'
interface ScheduleDefinitionBase {
  manifestId: string
  agentId: string
  agentName: string
  name: string
  cron: string
  timezone: string
}
/** Missing executionType is the original, already-reviewed prompt format. */
export type LocalAgentScheduleDefinition = ScheduleDefinitionBase & (
  { executionType?: 'static_prompt'; prompt: string; command?: never; resolvedCommand?: never; commandRevision?: never } |
  { executionType: 'script_trigger'; command: string; resolvedCommand: string; commandRevision: string; prompt?: never }
)
/** Definition and consent are local to one device/profile; the Job remains execution authority. */
export interface LocalJobScheduleDefinition {
  executionType: 'job'
  jobId: string
  jobTitle: string
  jobRevision: string
  name: string
  cron: string
  timezone: string
  prompt: string
  deletedAt?: number
}
export type LocalScheduleDefinition = LocalAgentScheduleDefinition | LocalJobScheduleDefinition
export interface ScheduleCommandOutcome {
  stdout: string
  stderr: string
  exitCode: number | null
  startedAt: number
  finishedAt: number
  timedOut: boolean
  aborted: boolean
  /**
   * False when the command never ran — e.g. aborted while queued for the
   * agent's turn lock. Absent on outcomes recorded before this flag existed.
   */
  started?: boolean
  spawnError?: string
  /** Exact classification before credential redaction; false when stdout was truncated. */
  stdoutIsExactOk?: boolean
  stdoutTruncated: boolean
  stderrTruncated: boolean
}
export interface LocalScheduleOccurrence {
  id: string
  utcMinute: number
  civilKey: string
  status: 'prepared' | 'dispatched' | 'completed' | 'failed' | 'cancelled' | 'interrupted' | 'skipped_overlap'
  taskId: string | null
  runId: string | null
  chatId: string | null
  reason: string | null
  scheduledFor?: number | null
  observedAt?: number | null
  startedAt?: number | null
  finishedAt?: number | null
  coveredThrough?: number | null
  triggerKind?: 'scheduled' | 'catch_up' | null
  resultKind?: 'quiet_ok' | 'agent_started' | 'execution_error' | null
  commandOutcome?: ScheduleCommandOutcome | null
}
export interface LocalScheduleItem {
  profileUserId: string
  name: string
  cron: string
  timezone: string
  prompt: string
  command?: string
  resolvedCommand?: string
  executionType?: 'static_prompt' | 'script_trigger'
  editorMetadata?: ScheduleEditorMetadata | null
  revision: string | null
  problem: string | null
  binding: {
    id: string
    enabled: boolean
    reason: string | null
    jobId: string | null
    nextDueAt?: number | null
    last: LocalScheduleOccurrence | null
  } | null
}
export interface LocalScheduleReview {
  profileUserId: string
  agentId: string
  name: string
  revision: string
  timezone: string
}
export interface LocalScheduleEditorSnapshot {
  items: LocalScheduleItem[]
  stamp: FileStamp
  warning?: string
}
export interface LocalScheduleSaveInput {
  profileUserId: string
  agentId: string
  expectedStamp: FileStamp
  originalName?: string
  revision?: string | null
  name: string
  executionType: 'static_prompt' | 'script_trigger'
  prompt?: string
  command?: string
  commandRevision?: string
  cron: string
  timezone: string
  enabled: boolean
  editorMetadata?: ScheduleEditorMetadata | null
}
export interface LocalScheduleDeleteInput {
  profileUserId: string
  agentId: string
  expectedStamp: FileStamp
  name: string
  revision: string | null
}
export interface LocalScheduleHistoryInput { profileUserId: string; bindingId: string; cursor?: string }
export interface LocalScheduleHistoryPage { items: LocalScheduleOccurrence[]; nextCursor: string | null }
export interface LocalScheduleStopInput { profileUserId: string; bindingId: string; occurrenceId: string }
