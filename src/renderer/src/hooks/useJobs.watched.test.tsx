import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, renderHook } from '@testing-library/react'
import { createElement, type ReactNode } from 'react'
import { afterEach, expect, it, vi } from 'vitest'
vi.mock('../stores/ui.store', () => ({ useUIStore: vi.fn() }))
vi.mock('./useChatStream', () => ({ useChatStream: vi.fn() }))
const { useJobList, useJobRuns } = await import('./useJobs')

afterEach(() => { cleanup(); vi.useRealTimers() })

it('refreshes active job rows and sidebar counts through remote completion, then stops polling', async () => {
  vi.useFakeTimers()
  const list = vi.fn().mockResolvedValue([{ id: 'job', inProgressRunsCount: 1 }])
  const listRuns = vi.fn().mockResolvedValue([{ id: 'attempt', status: 'running' }])
  ;(window as unknown as { api: unknown }).api = { jobs: { list, listRuns } }
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  client.setQueryData(['jobs'], [{ id: 'job', inProgressRunsCount: 1 }])
  client.setQueryData(['jobs', 'job', 'runs'], [{ id: 'attempt', status: 'running' }])
  const wrapper = ({ children }: { children: ReactNode }): React.JSX.Element =>
    createElement(QueryClientProvider, { client }, children)
  const view = renderHook(() => ({ jobs: useJobList(), runs: useJobRuns('job') }), { wrapper })
  await act(async () => { await vi.advanceTimersByTimeAsync(10) })
  list.mockResolvedValue([{ id: 'job', inProgressRunsCount: 0 }])
  listRuns.mockResolvedValue([{ id: 'attempt', status: 'succeeded' }])
  await act(async () => { await vi.advanceTimersByTimeAsync(5100) })
  expect(view.result.current.jobs.data?.[0].inProgressRunsCount).toBe(0)
  expect(view.result.current.runs.data?.[0].status).toBe('succeeded')
  list.mockClear(); listRuns.mockClear()
  await act(async () => { await vi.advanceTimersByTimeAsync(10000) })
  expect(list).not.toHaveBeenCalled()
  expect(listRuns).not.toHaveBeenCalled()
  client.clear()
})
