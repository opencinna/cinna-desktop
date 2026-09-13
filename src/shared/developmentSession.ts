import type { AgentEngine, ResolvedRuntime } from './engine'
import type { WorkComplexity } from './modelFamilies'

export const DEFAULT_DEVELOPMENT_COMPLEXITY: WorkComplexity = 'complex'

/** Internal builder rows must never enter generic custom-command configuration. */
export function isDevelopmentAgent(row: { source: string; driver?: string | null; driverConfig?: Record<string, unknown> | null } | undefined): boolean {
  return row?.source === 'local' && row.driver === 'acp' && typeof row.driverConfig?.developmentProfileId === 'string'
}

export interface DevelopmentContext {
  profileId: string
  serverUrl: string
  accountName: string
  workspacePath: string
  cliVersion: string
  runtime: ResolvedRuntime
  complexity: WorkComplexity
  documents: { path: string; content: string }[]
  instructions: string
  setupTarget?: 'runtime' | 'local-dev'
  installTool?: 'claude' | 'codex' | null
  blocker: string | null
}

export const DEVELOPMENT_RUNTIME_NAMES: Record<AgentEngine, string> = {
  claude: 'Claude Code', codex: 'Codex', opencode: 'OpenCode'
}
