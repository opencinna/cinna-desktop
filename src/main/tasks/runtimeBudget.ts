import type { TaskBudget } from '../../shared/tasks'
import type { TaskRuntimeInfo } from '../../shared/taskRuntime'

export function runtimeBudget(input?: TaskBudget | null): TaskRuntimeInfo['budget'] {
  if (input !== undefined && input !== null && (typeof input !== 'object' || Array.isArray(input) ||
    Object.keys(input).some((key) => !['maxRounds', 'maxMinutes', 'maxTokens'].includes(key)))) {
    throw new Error('The task budget contains an unsupported field.')
  }
  const maxRounds = input?.maxRounds ?? 20
  const maxMinutes = input?.maxMinutes ?? 60
  const maxTokens = input?.maxTokens
  if (!Number.isSafeInteger(maxRounds) || maxRounds < 1 || maxRounds > 1000) throw new Error('The round limit must be an integer from 1 to 1000.')
  if (!Number.isFinite(maxMinutes) || maxMinutes <= 0 || maxMinutes > 1440) throw new Error('The time limit must be greater than zero and at most 1440 minutes.')
  if (maxTokens !== undefined && (!Number.isSafeInteger(maxTokens) || maxTokens < 1)) throw new Error('The token limit must be a positive integer.')
  return { maxRounds, maxMinutes, ...(maxTokens !== undefined ? { maxTokens } : {}) }
}
