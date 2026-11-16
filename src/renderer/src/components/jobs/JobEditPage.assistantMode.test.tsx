import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { JobDetailData } from '../../../../shared/jobs'

/**
 * The edit page's Back and Save for a job mobile runs as the Assistant. A mode
 * pick held for its confirm must not be dropped by Back without the question.
 */

const update = vi.hoisted(() => ({ mutate: vi.fn(), mutateAsync: vi.fn() }))
vi.hoisted(() => { (window as unknown as { api: unknown }).api = { app: { setTheme: async () => undefined } } })

const job = {
  id: 'job-1', title: 'Morning brief', description: null, prompt: 'Summarise my day', type: 'local',
  modeId: null, runsOnMobile: true, needsSetup: false, incompleteSetup: false, agentIds: [], mcpProviderIds: [], recentRuns: []
} as unknown as JobDetailData

vi.mock('../../hooks/useJobs', () => ({
  useJob: () => ({ data: job, isLoading: false }),
  useDeleteJob: () => ({ mutate: vi.fn(), isPending: false }),
  useUpdateJob: () => update,
  useSetJobMcps: () => ({ mutate: vi.fn() }),
  useSetJobAgents: () => ({ mutate: vi.fn() })
}))
vi.mock('../../hooks/useAgents', () => ({ useAgents: () => ({ data: [] }) }))
vi.mock('../../hooks/useChatModes', () => ({
  useChatModes: () => ({ data: [{ id: 'm2', name: 'Deep work', isDefault: false, colorPreset: 'slate' }] })
}))
vi.mock('../../hooks/useMcp', () => ({ useMcpProviders: () => ({ data: [] }) }))
vi.mock('../../hooks/useCinna', () => ({ useCinnaAgents: () => ({ data: [] }) }))

const { JobEditPage } = await import('./JobEditPage')
const { useUIStore } = await import('../../stores/ui.store')

const dialog = (): HTMLElement | null => screen.queryByRole('dialog', { name: 'Make this a desktop job' })

beforeEach(() => {
  update.mutate.mockReset()
  update.mutateAsync.mockReset().mockResolvedValue(undefined)
  useUIStore.setState({ activeJobId: 'job-1', activeView: 'job-edit' })
})

describe('leaving the edit page of an Assistant job', () => {
  it('asks before Back drops a held mode pick, and Cancel stays on the page', async () => {
    render(<JobEditPage />)
    fireEvent.click(screen.getByRole('button', { name: 'Deep work' }))
    fireEvent.click(screen.getByRole('button', { name: 'Back' }))
    await waitFor(() => expect(dialog()).not.toBeNull())
    // Only the confirm's own button shows progress; Save is not left spinning.
    expect((screen.getByRole('button', { name: 'Save' }) as HTMLButtonElement).disabled).toBe(false)
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    await waitFor(() => expect(dialog()).toBeNull())
    expect(useUIStore.getState().activeView).toBe('job-edit')
    expect(screen.queryByRole('alert')).toBeNull()
    expect(update.mutateAsync).not.toHaveBeenCalled()
  })

  it('saves and leaves when the confirm is accepted', async () => {
    render(<JobEditPage />)
    fireEvent.click(screen.getByRole('button', { name: 'Deep work' }))
    fireEvent.click(screen.getByRole('button', { name: 'Back' }))
    await waitFor(() => expect(dialog()).not.toBeNull())
    fireEvent.click(screen.getByRole('button', { name: 'Make desktop job' }))
    await waitFor(() => expect(useUIStore.getState().activeView).toBe('job-detail'))
    expect(update.mutateAsync).toHaveBeenCalledWith({ jobId: 'job-1', patch: { modeId: 'm2' } })
  })

  it('leaves at once with nothing held', async () => {
    render(<JobEditPage />)
    fireEvent.click(screen.getByRole('button', { name: 'Back' }))
    await waitFor(() => expect(useUIStore.getState().activeView).toBe('job-detail'))
    expect(dialog()).toBeNull()
  })
})
