import type { JobRunRefreshMode } from '../../shared/jobs'
import type { TaskHandoffReceipt } from '../../shared/taskHandoff'
/** Read-only projection of stored schema; no availability or remote calls. */
export function jobRunRefreshMode(
  run: { type: string; taskId: string | null; cinnaTaskId: string | null },
  task: { deletedAt: Date | null; remoteAdapter: string | null; remoteId: string | null; executor: string } | null,
  receipt: TaskHandoffReceipt | null
): JobRunRefreshMode {
  if (receipt && ['creating', 'executing', 'accepted_pending', 'uncertain'].includes(receipt.state)) return 'handoff_review'
  if (task && !task.deletedAt && task.executor === 'remote' && task.remoteAdapter && task.remoteId) return 'bound_task'
  if (!run.taskId && run.type === 'cinna_task' && run.cinnaTaskId) return 'legacy_adoption'
  return 'none'
}
