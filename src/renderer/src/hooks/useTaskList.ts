import { useQuery } from '@tanstack/react-query'
import type { TaskListQuery, TaskListSnapshot } from '../../../shared/tasks'

/**
 * What a surface lists: one task's children (read through the remote refresh
 * `tasks.children` does), or a filtered local list.
 */
export type TaskListSelection =
  | { parentTaskId: string }
  | Omit<TaskListQuery, 'parentTaskId'>

const ROOTS: TaskListSelection = { rootOnly: true }

/**
 * The whole filter is in the key, so two surfaces with different filters never
 * share a cache entry. The `'roots'` and parent-id prefixes are the ones the
 * rest of the renderer (and its tests) already refetch by.
 */
export function taskListKey(selection: TaskListSelection): readonly unknown[] {
  if ('parentTaskId' in selection && selection.parentTaskId) return ['tasks', selection.parentTaskId]
  return ['tasks', 'rootOnly' in selection && selection.rootOnly ? 'roots' : 'list', selection]
}

/** Root work remains discoverable even without a job or an open question. */
export function useTaskList(requested: TaskListSelection = ROOTS) {
  // An empty parent id names no task. Read as a filter it would be dropped and
  // list every task in the profile as that task's children, so it is the roots.
  const selection = 'parentTaskId' in requested && !requested.parentTaskId ? ROOTS : requested
  return useQuery({
    queryKey: taskListKey(selection),
    queryFn: async (): Promise<TaskListSnapshot> => 'parentTaskId' in selection && selection.parentTaskId
      ? window.api.tasks.children(selection.parentTaskId)
      : { tasks: await window.api.tasks.list(selection as TaskListQuery), refreshed: true },
    refetchInterval: 5_000,
    retry: 1
  })
}
