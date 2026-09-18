import { useQuery, type UseQueryResult } from '@tanstack/react-query'
import type { HandoverDto } from '../../../shared/handovers'

/**
 * The file handover a task came from, for the one page that shows it.
 *
 * Its own query rather than a field on the task: an ordinary task has no
 * handover, `tasks.origin` is a closed vocabulary that cannot say "handover",
 * and the row is the link (`drafts/file_handovers` §4.1). Keying by **task id**
 * is what lets the page ask without knowing the handover exists.
 */
export const HANDOVER_FOR_TASK_KEY = (taskId: string): readonly unknown[] => [
  'handover',
  'for-task',
  taskId
]

/** The states a handover stops moving in — everything else is still going somewhere. */
const SETTLED: readonly string[] = ['done', 'failed', 'skipped', 'refused']

const POLL_MS = 5_000

/**
 * One handover row, or `null` for a task that was not born of one.
 *
 * Polled while the handover is still moving, on the same five seconds the task
 * itself uses: its state changes in a background scan of the folder, and this
 * page has no other way to hear about it — the same reasoning `useTask` writes
 * down for a `blocked` task. A settled row stops polling.
 */
export function useHandoverForTask(taskId: string | null): UseQueryResult<HandoverDto | null> {
  return useQuery({
    queryKey: HANDOVER_FOR_TASK_KEY(taskId ?? ''),
    queryFn: () => window.api.handovers.forTask(taskId as string),
    enabled: !!taskId,
    refetchInterval: (query) => {
      const data = query.state.data
      // Before the first answer, and for a task with no handover, the poll is
      // pointless: a task does not acquire a handover after the fact.
      if (data === undefined) return POLL_MS
      if (data === null) return false
      return SETTLED.includes(data.state) ? false : POLL_MS
    },
    // One retry, like the task read beside it: the page polls anyway, and
    // three silent retries only delay the row appearing.
    retry: 1
  })
}
