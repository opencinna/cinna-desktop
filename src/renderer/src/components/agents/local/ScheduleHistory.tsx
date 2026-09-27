import { useState } from 'react'
import { useInfiniteQuery } from '@tanstack/react-query'
import type { LocalScheduleItem, LocalScheduleOccurrence } from '../../../../../shared/localSchedules'
import { useOpenTask } from '../../../hooks/useTasks'
import { unwrapIpcError } from '../../../utils/ipcError'
import { scheduleButtonClass } from './ScheduleEditor'
import { scheduleTime } from './scheduleClock'

export const scheduleStatusLabels: Record<LocalScheduleOccurrence['status'], string> = {
  prepared: 'Queued', dispatched: 'In progress', completed: 'Completed', failed: 'Failed', cancelled: 'Cancelled', interrupted: 'Needs review', skipped_overlap: 'Skipped: previous run unfinished'
}
export { scheduleTime }

export function ScheduleHistory({ item, onChanged, target = 'agent' }: { item: LocalScheduleItem; onChanged(): void; target?: 'agent' | 'job' }) {
  const api = target === 'job' ? window.api.jobSchedules : window.api.localSchedules
  const openTask = useOpenTask()
  const [stopping, setStopping] = useState<string | null>(null)
  const [resolve, setResolve] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const query = useInfiniteQuery({
    queryKey: [target === 'job' ? 'job-schedule-history' : 'local-schedule-history', item.profileUserId, item.binding!.id],
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) => api.history({ profileUserId: item.profileUserId, bindingId: item.binding!.id, cursor: pageParam }),
    getNextPageParam: (page) => page.nextCursor ?? undefined,
    refetchInterval: 5000
  })
  const stop = async (occurrence: LocalScheduleOccurrence) => {
    if (stopping) return
    setStopping(occurrence.id); setError(null)
    try {
      await api.stop({ profileUserId: item.profileUserId, bindingId: item.binding!.id, occurrenceId: occurrence.id })
      setResolve(null); void query.refetch(); onChanged()
    } catch (cause) { setError(unwrapIpcError(cause, 'This execution could not be stopped.')) }
    finally { setStopping(null) }
  }
  const entries = query.data?.pages.flatMap((page) => page.items) ?? []
  return <section aria-label={`Execution history for ${item.name}`} className="mt-3 space-y-3 border-t border-[var(--color-border)] pt-3">
    <p className="text-[12px] text-[var(--color-text-secondary)]">Execution times are shown in {item.timezone}.</p>
    {query.isPending && <p className="text-[13px]">Loading executions…</p>}
    {!query.isPending && !query.error && entries.length === 0 && <p className="text-[13px] text-[var(--color-text-secondary)]">No scheduled runs yet.</p>}
    {entries.map((entry) => <article key={entry.id} aria-label={`Execution ${entry.id}`} className="space-y-2 rounded-md border border-[var(--color-border)] p-3 text-[13px]">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="font-medium">{entry.resultKind === 'quiet_ok' ? 'Quiet success' : scheduleStatusLabels[entry.status]}{entry.triggerKind === 'catch_up' ? ' · Catch-up' : ''}</p>
        <div className="flex gap-2">
          {entry.taskId && <button type="button" className={scheduleButtonClass} onClick={() => openTask(entry.taskId!)}>Open task</button>}
          {!entry.taskId && (entry.status === 'prepared' || entry.status === 'dispatched') && <button type="button" disabled={!!stopping} className={scheduleButtonClass} onClick={() => void stop(entry)}>{stopping === entry.id ? 'Stopping…' : 'Stop'}</button>}
          {!entry.taskId && entry.status === 'interrupted' && <button type="button" disabled={!!stopping} className={scheduleButtonClass} onClick={() => setResolve(entry.id)}>Resolve interruption</button>}
        </div>
      </div>
      <dl className="grid gap-x-3 gap-y-1 text-[12px] sm:grid-cols-[max-content_1fr]">
        <dt className="text-[var(--color-text-secondary)]">Scheduled for</dt><dd>{scheduleTime(entry.scheduledFor ?? entry.utcMinute * 60000, item.timezone)}</dd>
        <dt className="text-[var(--color-text-secondary)]">Actually started</dt><dd>{scheduleTime(entry.startedAt, item.timezone)}</dd>
        {entry.finishedAt != null && <><dt className="text-[var(--color-text-secondary)]">Finished</dt><dd>{scheduleTime(entry.finishedAt, item.timezone)}</dd></>}
        {entry.triggerKind === 'catch_up' && entry.coveredThrough != null && <><dt className="text-[var(--color-text-secondary)]">Missed times covered through</dt><dd>{scheduleTime(entry.coveredThrough, item.timezone)}</dd></>}
      </dl>
      {entry.reason && <p className="break-words text-[12px] text-[var(--color-text-secondary)]">{entry.reason}</p>}
      {entry.commandOutcome && <details>
        <summary className="cursor-pointer font-medium text-[var(--color-accent)]">Command output · {entry.commandOutcome.exitCode == null ? 'No exit code' : `Exit ${entry.commandOutcome.exitCode}`}</summary>
        <div className="mt-2 space-y-2">
          <p className="text-[12px]">{entry.commandOutcome.timedOut ? 'The command timed out.' : entry.commandOutcome.aborted ? 'The command was stopped.' : entry.commandOutcome.spawnError || 'Command finished.'}</p>
          <p className="text-[12px] font-medium">stdout{entry.commandOutcome.stdoutTruncated ? ' (truncated)' : ''}</p>
          <pre className="max-h-48 overflow-auto whitespace-pre-wrap break-words rounded bg-[var(--color-bg)] p-2 text-[12px]">{entry.commandOutcome.stdout || '(empty)'}</pre>
          <p className="text-[12px] font-medium">stderr{entry.commandOutcome.stderrTruncated ? ' (truncated)' : ''}</p>
          <pre className="max-h-48 overflow-auto whitespace-pre-wrap break-words rounded bg-[var(--color-bg)] p-2 text-[12px]">{entry.commandOutcome.stderr || '(empty)'}</pre>
        </div>
      </details>}
      {resolve === entry.id && <div className="space-y-2 rounded border border-[var(--color-border)] p-3">
        <p>The command’s outcome is uncertain. Mark this interrupted check as handled to allow future runs. This does not repeat the command.</p>
        <div className="flex gap-2"><button type="button" disabled={!!stopping} className={scheduleButtonClass} onClick={() => setResolve(null)}>Cancel</button><button type="button" disabled={!!stopping} className={scheduleButtonClass} onClick={() => void stop(entry)}>{stopping ? 'Resolving…' : 'Mark handled'}</button></div>
      </div>}
    </article>)}
    {query.hasNextPage && <button type="button" className={scheduleButtonClass} disabled={query.isFetchingNextPage} onClick={() => void query.fetchNextPage()}>{query.isFetchingNextPage ? 'Loading…' : 'Load older executions'}</button>}
    {(query.error || error) && <p role="alert" className="text-[13px] text-[var(--color-danger)]">{error ?? unwrapIpcError(query.error, 'Execution history could not be loaded.')}</p>}
  </section>
}
