import { render, screen, fireEvent } from '@testing-library/react'
import { createElement } from 'react'
import { describe, expect, it, vi, beforeEach } from 'vitest'
import type { JobRunData } from '../../../../shared/jobs'

/**
 * What a failed manual refresh records.
 *
 * The button spins and stops; nothing appears on the row. The log overlay is
 * the only place the reason exists at all — the same shape as a refused sidebar
 * run — so it is the one surface that has to carry a sentence rather than our
 * channel name. `job:refresh-run` throws, so the rejection arrives wrapped.
 */

const logged = vi.hoisted(() => [] as Array<{ message: string; data?: unknown }>)
const refreshMutate = vi.hoisted(() => vi.fn())

vi.mock('../../stores/logger.store', () => ({
  createLogger: () => ({
    debug: () => undefined,
    info: () => undefined,
    warn: (message: string, data?: unknown) => logged.push({ message, data }),
    error: () => undefined
  })
}))
vi.mock('../../hooks/useJobs', () => ({
  useOpenChatFromRun: () => () => undefined,
  useDeleteJobRun: () => ({ mutate: vi.fn(), isPending: false })
}))
vi.mock('../../hooks/useCinna', () => ({
  useRefreshCinnaRun: () => ({ mutate: refreshMutate, isPending: false }),
  useCinnaServerUrl: () => ({ data: null })
}))
vi.mock('../../hooks/useSystem', () => ({ useOpenExternal: () => ({ mutate: vi.fn() }) }))
vi.mock('../../hooks/useCinnaTaskView', () => ({
  useCinnaTaskView: () => ({ data: undefined, error: null, isLoading: false })
}))
vi.mock('../../hooks/useChat', () => ({ useShowChatInList: () => ({ mutate: vi.fn() }) }))
vi.mock('../../hooks/useRelativeNow', () => ({ useRelativeNow: () => new Date(0) }))
vi.mock('../../stores/ui.store', () => ({
  useUIStore: (sel: (s: Record<string, unknown>) => unknown) =>
    sel({ setActiveView: () => undefined, setActiveCinnaRunId: () => undefined })
}))

const { JobRunRow } = await import('./JobRunRow')

const SENTENCE = 'That task no longer exists on the server.'
const WIRE = "Error invoking remote method 'job:refresh-run': JobError: " + SENTENCE

function run(): JobRunData {
  return {
    id: 'run-1',
    jobId: 'job-1',
    type: 'cinna_task',
    status: 'running',
    cinnaTaskId: 't-1',
    cinnaShortCode: 'ABC',
    chatId: null,
    createdAt: 0,
    updatedAt: 0
  } as unknown as JobRunData
}

/** Click Refresh, then invoke whatever `onError` the component registered. */
function refreshAndFail(error: Error): void {
  render(createElement(JobRunRow, { run: run() }))
  fireEvent.click(screen.getByRole('button', { name: /refresh status/i }))
  const opts = refreshMutate.mock.calls[0][1] as { onError: (e: Error) => void }
  opts.onError(error)
}

beforeEach(() => {
  logged.length = 0
  refreshMutate.mockReset()
})

describe('a manual Cinna refresh that fails', () => {
  it('logs the reason with no IPC plumbing in it', () => {
    refreshAndFail(new Error(WIRE))

    expect(logged).toHaveLength(1)
    const { error } = logged[0].data as { error: string }
    expect(error).toBe(SENTENCE)
    expect(error).not.toContain('invoking remote method')
    expect(error).not.toContain('JobError')
  })

  it('logs a failure that never crossed IPC unchanged', () => {
    // The over-correction guard.
    refreshAndFail(new Error('The refresh was cancelled.'))
    expect((logged[0].data as { error: string }).error).toBe('The refresh was cancelled.')
  })
})
