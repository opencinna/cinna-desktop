import { useEffect } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { useJob, useJobList } from './useJobs'
import { useAuthStore } from '../stores/auth.store'
import { useAppForeground } from './useAppForeground'
import type { JobData } from '../../../shared/jobs'

/**
 * Opening a job's page reads its latest run's result, as opening that run's
 * chat does. MainArea passes a job ID only while its page is visible; the page
 * must have loaded. Main marks only the result named here, so one that lands
 * after this render stays unread.
 */
export function useReadJobResult(visibleJobId: string | null): void {
  const foreground = useAppForeground()
  const { data: jobs } = useJobList()
  const detail = useJob(visibleJobId)
  const queryClient = useQueryClient()
  const userId = useAuthStore((s) => s.currentUser?.id)
  const result = jobs?.find((job) => job.id === visibleJobId)?.lastRunResult
  // The page's own query must show the same run, as the chat rule requires: a
  // list poll can learn of a new result before the open page does.
  const unreadRunId = result?.unread && detail.isSuccess && detail.data?.id === visibleJobId &&
    detail.data.lastRunResult?.runId === result.runId ? result.runId : null
  useEffect(() => {
    if (!foreground || !visibleJobId || !unreadRunId) return
    void window.api.jobs.markResultRead(visibleJobId, unreadRunId).then(() => {
      if (useAuthStore.getState().currentUser?.id !== userId) return
      void queryClient.cancelQueries({ queryKey: ['jobs'], exact: true })
      queryClient.setQueryData<JobData[]>(['jobs'], (items) =>
        items?.map((item) => item.id === visibleJobId && item.lastRunResult?.runId === unreadRunId
          ? { ...item, lastRunResult: { ...item.lastRunResult, unread: false } } : item))
      // The run's chat may have been moved to Chats, where its row shows it too.
      void queryClient.invalidateQueries({ queryKey: ['chats'], exact: true })
    }).catch(() => { /* Leave it unread so opening the job again retries. */ })
  }, [foreground, visibleJobId, unreadRunId, queryClient, userId])
}
