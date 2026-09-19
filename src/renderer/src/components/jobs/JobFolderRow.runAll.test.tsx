import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { describe, expect, it, vi, beforeEach } from 'vitest'
import type { JobData, JobFolderData } from '../../../../shared/jobs'

/**
 * The folder row's ⋯ menu and its "Run All Jobs" item. It starts the same set
 * of jobs the rows' own run buttons would, in the folder's order: not one this
 * device cannot run, not one already running — and one refused start must not
 * stop the ones after it.
 */

const executeMutateAsync = vi.hoisted(() => vi.fn())

vi.mock('../../hooks/useJobs', () => ({
  useExecuteJob: () => ({ mutate: vi.fn(), mutateAsync: executeMutateAsync, isPending: false }),
  useUpdateJobFolder: () => ({ mutate: vi.fn() }),
  useDeleteJobFolder: () => ({ mutate: vi.fn(), isPending: false })
}))
vi.mock('../../stores/ui.store', () => ({
  useUIStore: (sel: (s: Record<string, unknown>) => unknown) =>
    sel({
      activeJobId: null,
      activeView: 'jobs',
      setActiveJobId: () => undefined,
      setActiveView: () => undefined
    })
}))
vi.mock('./dragContext', () => ({ useJobsDrag: () => ({ drag: null, setDrag: () => undefined }) }))

const { JobFolderRow } = await import('./JobFolderRow')

function job(id: string, over: Partial<JobData> = {}): JobData {
  return {
    id,
    userId: 'u',
    type: 'local',
    title: `Job ${id}`,
    description: null,
    prompt: 'p',
    agentId: null,
    modeId: null,
    cinnaAgentId: null,
    cinnaPriority: null,
    colorPreset: null,
    iconName: null,
    folderId: 'f1',
    position: 0,
    deletedAt: null,
    createdAt: new Date('2026-01-01T00:00:00Z'),
    updatedAt: new Date('2026-01-01T00:00:00Z'),
    inProgressRunsCount: 0,
    needsSetup: false,
    incompleteSetup: false,
    ...over
  }
}

const folder = { id: 'f1', name: 'Nightly', collapsed: true } as JobFolderData

function openMenu(jobs: JobData[]): ReturnType<typeof render> {
  const r = render(
    <JobFolderRow
      folder={folder}
      jobs={jobs}
      onDropJobInto={() => undefined}
      onReorderInside={() => undefined}
      onReorderFolder={() => undefined}
    />
  )
  fireEvent.mouseEnter(screen.getByText('Nightly'))
  fireEvent.click(screen.getByRole('button', { name: 'Folder actions' }))
  return r
}

beforeEach(() => {
  executeMutateAsync.mockReset()
  executeMutateAsync.mockResolvedValue(undefined)
})

describe('folder menu', () => {
  it('leads with Run All Jobs, separated from Edit and Delete', () => {
    openMenu([job('a')])
    const menu = screen.getByRole('menu', { name: 'Folder actions' })
    const items = screen.getAllByRole('menuitem').map((b) => b.textContent?.trim())
    expect(items).toEqual(['Run All Jobs', 'Edit', 'Delete'])
    const [runAll] = screen.getAllByRole('menuitem')
    expect(runAll.nextElementSibling?.getAttribute('role')).not.toBe('menuitem')
    expect(menu.contains(runAll)).toBe(true)
  })

  it('starts every runnable job in order, without leaving the list', async () => {
    openMenu([
      job('a'),
      job('b', { incompleteSetup: true }),
      job('c', { inProgressRunsCount: 1 }),
      job('d')
    ])
    fireEvent.click(screen.getByRole('menuitem', { name: 'Run All Jobs' }))
    await waitFor(() => expect(executeMutateAsync).toHaveBeenCalledTimes(2))
    expect(executeMutateAsync.mock.calls.map((c) => c[0])).toEqual([
      { jobId: 'a', navigate: false },
      { jobId: 'd', navigate: false }
    ])
    expect(screen.queryByRole('menu')).toBeNull()
  })

  it('keeps going after one job is refused', async () => {
    executeMutateAsync.mockRejectedValueOnce(new Error('refused'))
    openMenu([job('a'), job('b')])
    fireEvent.click(screen.getByRole('menuitem', { name: 'Run All Jobs' }))
    await waitFor(() => expect(executeMutateAsync).toHaveBeenCalledTimes(2))
    expect(executeMutateAsync.mock.calls[1][0]).toEqual({ jobId: 'b', navigate: false })
  })

  it.each([
    ['nothing in it can start', [job('a', { inProgressRunsCount: 1 })], 'Each job is running or cannot run on this device'],
    ['it has no jobs', [], 'This folder has no jobs']
  ])('is unavailable when %s, and says why in text, not a tooltip', (_case, jobs, reason) => {
    openMenu(jobs)
    const item = screen.getByRole('menuitem', { name: 'Run All Jobs' })
    // Focusable, so a keyboard reaches the reason; described by it, named without it.
    expect(item.getAttribute('aria-disabled')).toBe('true')
    const describedBy = item.getAttribute('aria-describedby')
    expect(describedBy && document.getElementById(describedBy)?.textContent).toBe(reason)
    expect(item.hasAttribute('title')).toBe(false)
    fireEvent.click(item)
    expect(executeMutateAsync).not.toHaveBeenCalled()
  })

  it('skips a job that started on its own while earlier ones were starting', async () => {
    // Main does not refuse a second run, so a job whose own run button was
    // pressed mid-loop must not be started again by the loop.
    let finishFirst: () => void = () => undefined
    executeMutateAsync.mockImplementationOnce(
      () => new Promise<void>((resolve) => { finishFirst = resolve })
    )
    const { rerender } = openMenu([job('a'), job('b')])
    fireEvent.click(screen.getByRole('menuitem', { name: 'Run All Jobs' }))
    await waitFor(() => expect(executeMutateAsync).toHaveBeenCalledTimes(1))
    rerender(
      <JobFolderRow
        folder={folder}
        jobs={[job('a', { inProgressRunsCount: 1 }), job('b', { inProgressRunsCount: 1 })]}
        onDropJobInto={() => undefined}
        onReorderInside={() => undefined}
        onReorderFolder={() => undefined}
      />
    )
    finishFirst()
    await new Promise((r) => setTimeout(r, 20))
    expect(executeMutateAsync).toHaveBeenCalledTimes(1)
  })

  it('closes when a scroll moves the row', () => {
    // Its position is fixed at opening; left open, it would sit beside
    // another folder and act on this one.
    openMenu([job('a')])
    fireEvent.scroll(document)
    expect(screen.queryByRole('menu')).toBeNull()
  })
})
