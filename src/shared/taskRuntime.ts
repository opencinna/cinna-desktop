import type { TaskBudget } from './tasks'

/** Device-local execution state, separate from the synced task status. */
export type TaskRuntimeState = 'queued' | 'running' | 'waiting' | 'interrupted' | 'completed'
export interface TaskRuntimeInfo {
  state: TaskRuntimeState
  reason: string | null
  ownerTurns: number
  elapsedMs: number
  budget: Required<Pick<TaskBudget, 'maxRounds' | 'maxMinutes'>> & Pick<TaskBudget, 'maxTokens'>
}
export interface AutonomousTaskStart {
  chatId: string
  goal: string
  budget?: TaskBudget
}
