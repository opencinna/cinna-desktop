import type { TaskRuntimeInfo } from '../../shared/taskRuntime'
import type { TaskScript } from '../../shared/taskScript'

export interface ScriptTarget { agentId: string; name: string; identity: string }
export type ScriptStepState = 'pending' | 'queued' | 'running' | 'waiting' | 'completed' | 'interrupted' | 'failed' | 'canceled'
export interface ScriptStepCheckpoint {
  taskId: string
  chatId: string
  state: ScriptStepState
  text: string | null
  prompt: string | null
  promptOrigin: 'user' | 'runner'
  lastRunId: string | null
  pendingRequestIds: string[]
}
/** One local root checkpoint; update a fresh snapshot atomically between awaits. */
export interface ScriptRuntimeCheckpoint extends TaskRuntimeInfo {
  jobRunId: string
  goal: string
  attemptId: string
  chatId: string
  settingsUserId: string
  definition: TaskScript
  targets: Record<string, ScriptTarget>
  steps: Record<string, ScriptStepCheckpoint>
  activeStartedAt: number | null
}
