/**
 * The word a task's home will hold for a new status, asked synchronously by
 * `taskService` when a status changes — so a folder task's `statusLabel` moves
 * with its status instead of going blank until the push and the next pull.
 *
 * A seam rather than an import: `taskService` sits under the adapter registry
 * and must not load it. The registry installs one resolver per adapter that
 * has a local home ({@link RemoteLocalHome.statusWord}); with none installed
 * the answer is "cannot tell", and the caller keeps its old behaviour.
 */

import type { TaskStatus } from '../../../shared/taskStatus'

export type StatusWordResolver = (remoteId: string, status: TaskStatus, current: string | null) => string | undefined

const resolvers = new Map<string, StatusWordResolver>()

export function installStatusWordResolver(adapterId: string, resolver: StatusWordResolver): void {
  resolvers.set(adapterId, resolver)
}

/** The home's word for `status`, or undefined when the task has no such home or it cannot tell yet. */
export function homeStatusWord(
  task: { remoteAdapter: string | null; remoteId: string | null; statusLabel: string | null },
  status: TaskStatus
): string | undefined {
  if (!task.remoteAdapter || !task.remoteId) return undefined
  return resolvers.get(task.remoteAdapter)?.(task.remoteId, status, task.statusLabel)
}
