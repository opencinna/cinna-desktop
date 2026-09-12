/** Local per-profile/device opt-in; these records never travel through sync. */
export interface LocalScheduleDefinition {
  manifestId: string
  agentId: string
  agentName: string
  name: string
  cron: string
  timezone: string
  prompt: string
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
}
export interface LocalScheduleItem {
  profileUserId: string
  name: string
  cron: string
  timezone: string
  prompt: string
  /** Review token over the actual definition, never execution authority. */
  revision: string | null
  problem: string | null
  binding: {
    id: string
    enabled: boolean
    reason: string | null
    jobId: string
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
