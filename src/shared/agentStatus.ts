/** Refresh intent crosses IPC; the status source owns its execution policy. */
export type StatusRefreshIntent = 'read' | 'manual' | 'batch' | 'after_turn'

export function isStatusRefreshIntent(value: unknown): value is StatusRefreshIntent {
  return value === 'read' || value === 'manual' || value === 'batch' || value === 'after_turn'
}

export const FOLDER_STATUS_REFRESH_DESCRIPTION = 'Run this agent’s status refresh command and re-read STATUS.md'
export const CINNA_STATUS_REFRESH_DESCRIPTION = 'Force refresh from running environment (rate-limited to 1/30s)'

export type AgentStatusSeverity = 'ok' | 'warning' | 'error' | 'info' | 'unknown'

export interface AgentStatusSnapshot {
  agentId: string
  /** Main-owned description of the explicit per-agent refresh action. */
  refreshDescription: string
  remoteAgentId: string
  name: string
  environmentId: string | null
  severity: AgentStatusSeverity | null
  summary: string | null
  reportedAt: string | null
  reportedAtSource: 'frontmatter' | 'file_mtime' | null
  fetchedAt: string | null
  raw: string | null
  body: string | null
  hasStructuredMetadata: boolean
  prevSeverity: string | null
  severityChangedAt: string | null
}
