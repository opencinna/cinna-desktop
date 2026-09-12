import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { JobRunData } from '../../../shared/jobs'
const refresh = vi.hoisted(() => vi.fn())
vi.mock('./useCinna', () => ({ useRefreshCinnaRun: () => ({ mutate: refresh }) }))
import { useCinnaRunPoll } from './useCinnaRunPoll'
const run = (refreshMode: JobRunData['refreshMode'], status: JobRunData['status'] = 'running'): JobRunData => ({
  id: 'run', jobId: 'job', userId: 'user', type: 'cinna_task', localChatId: null,
  cinnaTaskId: 'remote', cinnaShortCode: null, status, errorMessage: null, startedAt: null,
  finishedAt: null, createdAt: new Date(0), taskId: null, chatHidden: false, refreshMode
})
beforeEach(() => { vi.useFakeTimers(); refresh.mockClear() })
afterEach(() => { vi.useRealTimers() })
it('adopts active legacy history and stops when a Task takes over refresh ownership', () => {
  const { rerender, unmount } = renderHook(({ rows }) => useCinnaRunPoll(rows), { initialProps: { rows: [run('legacy_adoption')] } })
  expect(refresh).toHaveBeenCalledExactlyOnceWith({ runId: 'run' })
  act(() => vi.advanceTimersByTime(5_000))
  expect(refresh).toHaveBeenCalledTimes(2)
  rerender({ rows: [run('bound_task')] })
  act(() => vi.advanceTimersByTime(15_000))
  expect(refresh).toHaveBeenCalledTimes(2)
  unmount()
})
it.each(['bound_task', 'handoff_review', 'none'] as const)('leaves %s to the owning task service', (mode) => {
  const { unmount } = renderHook(() => useCinnaRunPoll([run(mode)]))
  act(() => vi.advanceTimersByTime(15_000))
  expect(refresh).not.toHaveBeenCalled()
  unmount()
})
it('never automatically adopts terminal history', () => {
  const { unmount } = renderHook(() => useCinnaRunPoll([run('legacy_adoption', 'succeeded')]))
  act(() => vi.advanceTimersByTime(15_000))
  expect(refresh).not.toHaveBeenCalled()
  unmount()
})
