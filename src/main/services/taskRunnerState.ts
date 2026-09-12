/** A task reservation spans queued work, owner transitions and durable waits. */
export interface TaskRunnerReservation {
  userId: string
  taskId: string
  id: string
  working: boolean
  cancel(): void
}
export const taskRunnersByChat = new Map<string, TaskRunnerReservation>()
