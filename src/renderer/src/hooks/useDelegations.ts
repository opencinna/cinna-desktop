import { useQuery, type UseQueryResult } from '@tanstack/react-query'
import type { TaskDelegationsDto } from '../../../shared/delegations'

export const TASK_DELEGATIONS_KEY = (taskId: string): readonly unknown[] => ['delegations', 'task', taskId]

/** New outgoing work can appear even when the previous list was empty or settled. */
export function useTaskDelegations(taskId: string): UseQueryResult<TaskDelegationsDto> {
  return useQuery({
    queryKey: TASK_DELEGATIONS_KEY(taskId),
    queryFn: () => window.api.delegations.forTask(taskId),
    refetchInterval: 5_000,
    retry: 1
  })
}
