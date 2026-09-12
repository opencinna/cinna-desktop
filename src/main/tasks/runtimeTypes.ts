import type { TaskRuntimeInfo } from '../../shared/taskRuntime'

export type TaskRuntimeOwner = { kind: 'coordinator' } | { kind: 'agent'; agentId: string; name: string; note: string }
/** Local recovery checkpoint. Never synced, and never sent wholesale to renderer. */
export interface TaskRuntimeCheckpoint extends TaskRuntimeInfo {
  attemptId: string
  lastRunId: string | null
  /** Answerable requests retained across sequential sibling continuations. */
  pendingRequestIds: string[]
  chatId: string
  settingsUserId: string
  owner: TaskRuntimeOwner
  prompt: string
  promptOrigin: 'user' | 'runner'
  gateRequestId: string | null
  gateToolCallId: string | null
  coordinator: { providerId: string; modelId: string; modeId: string | null }
  /** A checkpoint in running state is interrupted on restart, never replayed. */
  activeStartedAt: number | null
  inputTokens: number
  outputTokens: number
}
