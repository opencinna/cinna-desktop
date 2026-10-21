import type { TaskStatus } from '../../shared/taskStatus'

/**
 * Tasks whose status the agent working on them set itself during its turn
 * (`tasks_report` on the chat's own task: done, blocked, failed or in progress).
 *
 * A turn's end settles a hand-opened chat's task from how the turn ended
 * (`inboxService.endTurn`), which would turn an agent's `blocked` or `error`
 * into `completed` a moment later. The mark tells it the task already says
 * how the work ended.
 *
 * Keyed by the run that made the report: only the end of that same run reads
 * it, so a mark a turn end never consumed (it returned before reading it) can
 * never skip a later turn's settlement. A turn start in the chat drops any
 * such leftover. In memory: a restart mid-turn loses it, and that turn's end
 * then settles the task as before.
 */
const reported = new Map<string, { chatId: string; runId: string; status: TaskStatus }>()

/** `status` is the one the report set (`completed`, `error`, `blocked`, `in_progress`). */
export function noteAgentStatusReport(taskId: string, chatId: string, runId: string, status: TaskStatus): void {
  reported.set(taskId, { chatId, runId, status })
}

/**
 * The status the agent reported for this task during the run now ending;
 * undefined when it reported none in that run. Clears the mark whichever run
 * it belonged to.
 */
export function takeAgentStatusReport(taskId: string, runId: string | undefined): TaskStatus | undefined {
  const mark = reported.get(taskId)
  if (!mark) return undefined
  reported.delete(taskId)
  return runId !== undefined && mark.runId === runId ? mark.status : undefined
}

/** A new turn in this chat: no earlier run's mark may outlive it. */
export function forgetAgentStatusReports(chatId: string): void {
  for (const [taskId, mark] of reported) if (mark.chatId === chatId) reported.delete(taskId)
}

/**
 * Whether the agent reported this task's status during the latest run in this
 * chat — the job-run path, which knows the chat but not the run id. A turn
 * start in the chat drops older marks, so a mark for this chat is this turn's.
 * Clears the mark when it answers true.
 */
export function takeAgentStatusReportInChat(taskId: string, chatId: string): boolean {
  const mark = reported.get(taskId)
  if (!mark || mark.chatId !== chatId) return false
  reported.delete(taskId)
  return true
}
