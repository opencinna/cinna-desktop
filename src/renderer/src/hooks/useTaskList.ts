import { useQuery } from '@tanstack/react-query'
import type { TaskListSnapshot } from '../../../shared/tasks'

/** Root work remains discoverable even without a job or an open question. */
export function useTaskList(parentTaskId?: string) {
  return useQuery({
    queryKey: ['tasks', parentTaskId ?? 'roots'],
    queryFn: async (): Promise<TaskListSnapshot> => parentTaskId
      ? window.api.tasks.children(parentTaskId)
      : { tasks: await window.api.tasks.list({ rootOnly: true }), refreshed: true },
    refetchInterval: 5_000,
    retry: 1
  })
}
