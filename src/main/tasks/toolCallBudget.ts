import { taskRuntimeRepo } from '../db/taskRuntimes'
import { taskRunnersByChat } from '../services/taskRunnerState'
import type { RunInput } from '../agents/drivers/driver'
import type { TaskRuntimeCheckpoint } from './runtimeTypes'

export type ToolCallBudget = NonNullable<RunInput['toolCallBudget']>

interface BudgetHooks {
  /** Persist the incremented checkpoint. Defaults to the bare repo write. */
  save?(value: TaskRuntimeCheckpoint): void
  /** Throws when the run holding this budget is no longer the task's current one. */
  assertCurrent?(): void
}

function checkpoint(userId: string, taskId: string): TaskRuntimeCheckpoint {
  const value = taskRuntimeRepo.get(userId, taskId)
  if (!value) throw new Error('This task has no local execution checkpoint.')
  return value
}

/**
 * An autonomous task's tool-call budget, read from and counted into its
 * durable checkpoint (`budget.maxRounds` against `toolCalls`), so every run of
 * the task — the coordinator turn and any follow-up opened between turns —
 * draws from the same count.
 */
export function taskToolCallBudget(userId: string, taskId: string, hooks: BudgetHooks = {}): ToolCallBudget {
  const save = hooks.save ?? ((value: TaskRuntimeCheckpoint) => taskRuntimeRepo.save(userId, taskId, value))
  return {
    get remaining() {
      const current = checkpoint(userId, taskId)
      return Math.max(0, current.budget.maxRounds - (current.toolCalls ?? 0))
    },
    consume() {
      hooks.assertCurrent?.()
      const current = checkpoint(userId, taskId)
      if ((current.toolCalls ?? 0) >= current.budget.maxRounds) throw new Error('The task reached its tool-call limit.')
      save({ ...current, toolCalls: (current.toolCalls ?? 0) + 1 })
    }
  }
}

/**
 * The budget of the autonomous task whose coordinator conducts this chat, for
 * a run that was opened without one (a follow-up the engine started between
 * turns). Undefined when no task holds the chat or the agent is not the task's
 * current coordinator — the same condition under which the runner budgets a turn.
 */
export function taskToolCallBudgetForChat(chatId: string, profileUserId: string, agentId: string): ToolCallBudget | undefined {
  const reservation = taskRunnersByChat.get(chatId)
  if (!reservation || reservation.userId !== profileUserId) return undefined
  const saved = taskRuntimeRepo.get(reservation.userId, reservation.taskId)
  if (!saved || saved.owner.kind !== 'coordinator' || !saved.coordinator.agentId || saved.coordinator.agentId !== agentId) return undefined
  return taskToolCallBudget(reservation.userId, reservation.taskId)
}
