/** A same-process reservation, shared by local turn admission and remote handoff. */
export const handingOffTasks = new Set<string>()
export const handingOffChats = new Set<string>()

export function taskOperationKey(userId: string, taskId: string): string {
  return JSON.stringify([userId, taskId])
}
