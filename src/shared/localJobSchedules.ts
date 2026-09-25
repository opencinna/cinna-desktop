import type { LocalScheduleItem } from './localSchedules'
import type { ScheduleEditorMetadata } from './scheduleTemplates'

/** Only desktop-owned Jobs can opt in to this device's scheduler. */
export function canScheduleJob(type: string): boolean { return type === 'local' }

export interface LocalJobScheduleSnapshot {
  profileUserId: string
  jobId: string
  jobTitle: string
  jobPrompt: string
  jobSummary: string
  jobScript?: import('./taskScript').TaskScript | null
  jobRevision: string
  items: LocalScheduleItem[]
}
export interface JobScheduleSaveInput {
  profileUserId: string
  jobId: string
  jobRevision: string
  id?: string
  revision?: string | null
  name: string
  cron: string
  timezone: string
  enabled: boolean
  editorMetadata?: ScheduleEditorMetadata | null
}
export interface JobScheduleMutationInput {
  profileUserId: string
  jobId: string
  id: string
  revision: string | null
}
export interface JobScheduleEnableInput extends JobScheduleMutationInput { jobRevision: string }
