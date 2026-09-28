import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, renderHook, waitFor } from '@testing-library/react'
import { beforeEach, afterEach, expect, it, vi } from 'vitest'
import type { ReactNode } from 'react'
import { useReadJobResult } from './useReadJobResult'

const markResultRead = vi.fn()
const get = vi.fn()
const jobs = () => [
  { id: 'j', inProgressRunsCount: 0, lastRunResult: { runId: 'run-j', status: 'completed', unread: true } },
  { id: 'k', inProgressRunsCount: 0, lastRunResult: { runId: 'run-k', status: 'failed', unread: true } }
]
const detailOf = (id: string) => ({ id, recentRuns: [], lastRunResult: jobs().find((job) => job.id === id)?.lastRunResult ?? null })
let client: QueryClient
beforeEach(() => {
  vi.spyOn(document, 'hasFocus').mockReturnValue(true)
  client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } })
  client.setQueryData(['jobs'], jobs())
  markResultRead.mockReset().mockResolvedValue(undefined)
  get.mockReset().mockImplementation(async (id: string) => detailOf(id))
  ;(window as unknown as { api: unknown }).api = { jobs: { list: vi.fn().mockResolvedValue(jobs()), get, markResultRead } }
})
afterEach(() => { client.clear(); vi.restoreAllMocks() })
const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>
const cached = () => client.getQueryData<ReturnType<typeof jobs>>(['jobs'])!

it('reads the latest result when the job page is open, and only that job\'s', async () => {
  const view = renderHook(({ id }) => useReadJobResult(id), { initialProps: { id: null as string | null }, wrapper })
  expect(markResultRead).not.toHaveBeenCalled()
  view.rerender({ id: 'j' })
  await waitFor(() => expect(cached()[0].lastRunResult.unread).toBe(false))
  expect(markResultRead).toHaveBeenCalledWith('j', 'run-j')
  expect(cached()[1].lastRunResult.unread).toBe(true)
})

it('does not clear a newer result that landed while the acknowledgement was in flight', async () => {
  let finish!: () => void
  markResultRead.mockReturnValueOnce(new Promise<void>((resolve) => { finish = resolve }))
  renderHook(() => useReadJobResult('j'), { wrapper })
  await waitFor(() => expect(markResultRead).toHaveBeenCalledWith('j', 'run-j'))
  act(() => client.setQueryData(['jobs'], [{ ...jobs()[0], lastRunResult: { runId: 'run-new', status: 'failed', unread: true } }]))
  await act(async () => finish())
  expect(cached()[0].lastRunResult).toEqual({ runId: 'run-new', status: 'failed', unread: true })
})

it('waits for the page to load, and for the window to be in the foreground', async () => {
  vi.mocked(document.hasFocus).mockReturnValue(false)
  let finish!: (value: unknown) => void
  get.mockReturnValueOnce(new Promise((resolve) => { finish = resolve }))
  renderHook(() => useReadJobResult('j'), { wrapper })
  await waitFor(() => expect(get).toHaveBeenCalledWith('j'))
  await act(async () => finish(detailOf('j')))
  expect(markResultRead).not.toHaveBeenCalled()
  act(() => {
    vi.mocked(document.hasFocus).mockReturnValue(true)
    window.dispatchEvent(new Event('focus'))
  })
  await waitFor(() => expect(markResultRead).toHaveBeenCalledWith('j', 'run-j'))
})

it('does nothing for a read result or a failed page load', async () => {
  client.setQueryData(['jobs'], [{ ...jobs()[0], lastRunResult: { runId: 'run-j', status: 'completed', unread: false } }, jobs()[1]])
  renderHook(() => useReadJobResult('j'), { wrapper })
  await waitFor(() => expect(client.getQueryState(['jobs', 'j'])?.status).toBe('success'))
  get.mockRejectedValue(new Error('Database unavailable'))
  renderHook(() => useReadJobResult('k'), { wrapper })
  await waitFor(() => expect(client.getQueryState(['jobs', 'k'])?.status).toBe('error'))
  expect(markResultRead).not.toHaveBeenCalled()
})

it('waits until the open page shows the same run the list does', async () => {
  // The list poll learned of a new result before the page's own query did.
  get.mockImplementation(async (id: string) => ({ ...detailOf(id), lastRunResult: { runId: 'run-older', status: 'completed', unread: false } }))
  renderHook(() => useReadJobResult('j'), { wrapper })
  await waitFor(() => expect(client.getQueryState(['jobs', 'j'])?.status).toBe('success'))
  expect(markResultRead).not.toHaveBeenCalled()
  await act(async () => { client.setQueryData(['jobs', 'j'], detailOf('j')) })
  await waitFor(() => expect(markResultRead).toHaveBeenCalledWith('j', 'run-j'))
})
