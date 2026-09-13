export type ChatRunResultStatus = 'completed' | 'needs_input' | 'failed' | 'canceled'

export interface ChatRunResult {
  runId: string
  status: ChatRunResultStatus
  unread: boolean
}
