import { render, screen } from '@testing-library/react'
import { createElement } from 'react'
import { describe, expect, it, vi, beforeEach } from 'vitest'

/**
 * What the Cinna task view says when the fetch fails.
 *
 * `cinna:get-task-view` is registered with `ipcHandle` and throws, so its
 * message reaches the renderer as `Error invoking remote method
 * 'cinna:get-task-view': CinnaApiError: …`. The alert here is the only account
 * the user gets — the rest of the screen is the task's own content, which is
 * exactly what failed to arrive.
 */

const taskViewState = vi.hoisted(() => ({
  error: null as Error | null,
  data: undefined as unknown,
  isLoading: false
}))

vi.mock('../../hooks/useCinnaTaskView', () => ({
  useCinnaTaskView: () => ({
    error: taskViewState.error,
    data: taskViewState.data,
    isLoading: taskViewState.isLoading
  }),
  useInvalidateCinnaTaskView: () => () => undefined
}))
vi.mock('../../hooks/useJobs', () => ({
  useJob: () => ({ data: { id: 'job-1', title: 'Nightly check' } }),
  useJobRuns: () => ({
    data: [{ id: 'run-1', type: 'cinna_task', cinnaTaskId: 't-1', cinnaShortCode: null }]
  })
}))
vi.mock('../../hooks/useCinna', () => ({ useCinnaServerUrl: () => ({ data: null }) }))
vi.mock('../../hooks/useTaskAttachmentDownload', () => ({
  useTaskAttachmentDownload: () => ({ download: vi.fn(), state: {} })
}))
vi.mock('../../hooks/useRelativeNow', () => ({ useRelativeNow: () => new Date(0) }))
vi.mock('../../stores/ui.store', () => ({
  useUIStore: (sel: (s: Record<string, unknown>) => unknown) =>
    sel({
      activeJobId: 'job-1',
      activeCinnaRunId: 'run-1',
      setActiveView: () => undefined,
      setActiveCinnaRunId: () => undefined
    })
}))

const { CinnaTaskRunView } = await import('./CinnaTaskRunView')

const SENTENCE = 'That task is no longer visible to your account.'
const WIRE =
  "Error invoking remote method 'cinna:get-task-view': CinnaApiError: " + SENTENCE

beforeEach(() => {
  taskViewState.error = null
  taskViewState.data = undefined
  taskViewState.isLoading = false
})

describe('a Cinna task view that fails to load', () => {
  it('shows the reason with no IPC plumbing in front of it', () => {
    taskViewState.error = new Error(WIRE)
    render(createElement(CinnaTaskRunView))

    const alert = screen.getByRole('alert')
    expect(alert.textContent).toBe(SENTENCE)
    expect(alert.textContent ?? '').not.toContain('invoking remote method')
    expect(alert.textContent ?? '').not.toContain('CinnaApiError')
  })

  it('shows a failure that never crossed IPC unchanged', () => {
    // The over-correction guard.
    taskViewState.error = new Error('The task view timed out.')
    render(createElement(CinnaTaskRunView))
    expect(screen.getByRole('alert').textContent).toBe('The task view timed out.')
  })

  it('shows no alert while the fetch is still in flight', () => {
    // The alert must be conditional on there being an error, not on the data
    // being absent — otherwise every slow load looks like a failure.
    taskViewState.isLoading = true
    render(createElement(CinnaTaskRunView))
    expect(screen.getByText('Loading task…')).toBeTruthy()
    expect(screen.queryByRole('alert')).toBeNull()
  })
})
