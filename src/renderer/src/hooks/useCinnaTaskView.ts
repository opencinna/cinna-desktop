import { useQuery, useQueryClient } from '@tanstack/react-query'
import type { CinnaTaskViewDto } from '../../../shared/cinnaTaskView'

const ACTIVE_REFETCH_MS = 5_000
const BADGE_STALE_MS = 60_000

interface UseCinnaTaskViewOptions {
  /**
   * Set `false` to suppress the background refetch loop — used by the run-row
   * count badges so each visible cinna task row doesn't trigger a `/detail`
   * fetch every 5s. The detail view still polls on its own subscription;
   * both share the same query key + cache.
   */
  polling?: boolean
}

/**
 * Fetch comments + attachments for a cinna task.
 *
 * - When `polling` is true (default), refetches every 5s while the task is
 *   non-terminal — used by `CinnaTaskRunView` so new comments stream in
 *   without manual refresh.
 * - When `polling` is false, fetches once and lets `staleTime` keep the
 *   cache fresh — used for row-level badges. Opening the detail view
 *   warms the same cache (and vice versa).
 *
 * Disabled when `taskId` is falsy.
 */
export function useCinnaTaskView(
  taskId: string | null | undefined,
  options: UseCinnaTaskViewOptions = {}
) {
  const polling = options.polling ?? true
  return useQuery<CinnaTaskViewDto>({
    queryKey: ['cinna', 'task-view', taskId],
    queryFn: () => window.api.cinna.getTaskView(taskId as string),
    enabled: !!taskId,
    staleTime: polling ? 0 : BADGE_STALE_MS,
    refetchInterval: polling
      ? (query) => {
          const data = query.state.data
          if (!data) return ACTIVE_REFETCH_MS
          const status = data.task.status
          const terminal =
            status === 'completed' ||
            status === 'succeeded' ||
            status === 'error' ||
            status === 'failed' ||
            status === 'cancelled' ||
            status === 'archived'
          return terminal ? false : ACTIVE_REFETCH_MS
        }
      : false
  })
}

export function useInvalidateCinnaTaskView(): (taskId: string) => void {
  const qc = useQueryClient()
  return (taskId: string) => {
    qc.invalidateQueries({ queryKey: ['cinna', 'task-view', taskId] })
  }
}
